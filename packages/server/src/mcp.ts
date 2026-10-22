import { McpServer, ResourceTemplate, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NfError,
  PatchOp,
  WorkflowEdge,
  WorkflowNode,
  type NaturoflowService,
  type RunRecord,
  type ServiceEvent,
  type WorkflowInterface,
  workflowInterface,
} from "@naturoflow/core";
import { z } from "zod";
import { NODE_TYPE_SPEC } from "./docs.ts";

export const SERVER_INFO = { name: "naturoflow", version: "0.1.0" };

const INSTRUCTIONS = `naturoflow is a canvas workflow engine where every node type is user-definable (HTTP calls, CLI commands like ffmpeg, JS/Python scripts).
Typical flow: list_node_types -> (create_node_type if needed; read naturoflow://docs/node-type-spec first) -> create_workflow -> apply_workflow_patch -> validate_workflow -> run_workflow -> get_run / get_node_run_logs.
Control flow: core.if (branch), core.map (run a workflow per list item), core.subflow (call another workflow). After changing one node, rerun_from_node reuses upstream results.
Node types with \`credentials\` need a saved credential per node (list_credentials, then update_node {credential}); the user enters key values in the canvas, never through you.
publish_workflow turns a workflow into its own tool. Edits you make appear live on the user's canvas.`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function fail(e: unknown): ToolResult {
  const err =
    e instanceof NfError
      ? e.toJSON()
      : e instanceof z.ZodError
        ? { code: "INVALID_ARGUMENT", message: e.issues[0]?.message, path: e.issues[0]?.path.join(".") }
        : { code: "ERROR", message: (e as Error).message, issues: (e as { issues?: unknown }).issues };
  return { content: [{ type: "text", text: JSON.stringify({ error: err }, null, 2) }], isError: true };
}

/** Wrap a handler so thrown errors become structured tool errors the agent can act on. */
function wrap<A>(fn: (args: A) => unknown | Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

/** Compact run view: statuses, errors, outputs; logs are fetched separately. */
export function summarizeRun(run: RunRecord) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: run.status,
    error: run.error,
    outputs: run.outputs,
    durationMs: run.finishedAt ? run.finishedAt - run.startedAt : Date.now() - run.startedAt,
    nodes: Object.fromEntries(
      Object.values(run.nodes).map((n) => [
        n.nodeId,
        {
          status: n.status,
          ...(n.error ? { error: n.error } : {}),
          ...(n.attempts > 1 ? { attempts: n.attempts } : {}),
          ...(n.finishedAt && n.startedAt ? { durationMs: n.finishedAt - n.startedAt } : {}),
          ...(n.outputs ? { outputs: n.outputs } : {}),
        },
      ]),
    ),
  };
}

/** Zod argument shape for a published workflow's inputs. */
function toolShape(iface: WorkflowInterface): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const i of iface.inputs) {
    let t: z.ZodTypeAny =
      i.type === "string" ? z.string()
      : i.type === "number" ? z.number()
      : i.type === "boolean" ? z.boolean()
      : i.type === "file" ? z.string().describe("absolute path of a local file")
      : z.any();
    const desc = [i.description, i.type === "file" ? "absolute file path" : undefined].filter(Boolean).join("; ");
    if (desc) t = t.describe(desc);
    shape[i.key] = i.required ? t : t.optional();
  }
  return shape;
}

const workflowId = z.string().describe("workflow id");
const expectedVersion = z
  .number()
  .int()
  .optional()
  .describe("if set, the edit fails when the workflow's current version differs (optimistic locking)");
const nodeTypeDef = z
  .union([z.string(), z.record(z.string(), z.any())])
  .describe("node type definition as an object or a YAML string; see naturoflow://docs/node-type-spec");

/** Build an MCP server exposing the whole service. One instance per MCP session. */
export function createMcpServer(svc: NaturoflowService): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: false } },
  });
  const patch = (id: string, ops: PatchOp[], v?: number) => {
    const { workflow, issues } = svc.applyPatch(id, ops, v);
    return { version: workflow.version, nodes: workflow.nodes.length, edges: workflow.edges.length, issues };
  };

  // ---------- node types ----------
  server.registerTool(
    "list_node_types",
    {
      title: "List node types",
      description: "List all available node types with their ports and executor kind.",
      inputSchema: { category: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    wrap(({ category }) => svc.listNodeTypes().filter((t) => !category || t.category === category)),
  );

  server.registerTool(
    "get_node_type",
    {
      title: "Get node type",
      description: "Full definition of a node type (ports, params JSON Schema, executor).",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    wrap(({ id }) => svc.getNodeType(id)),
  );

  server.registerTool(
    "create_node_type",
    {
      title: "Create node type",
      description: "Define a new node type (HTTP call, CLI command, JS/Python script). Read naturoflow://docs/node-type-spec first.",
      inputSchema: { definition: nodeTypeDef },
    },
    wrap(({ definition }) => svc.saveNodeType(definition, "create")),
  );

  server.registerTool(
    "update_node_type",
    {
      title: "Update node type",
      description: "Replace an existing user node type definition (same id).",
      inputSchema: { definition: nodeTypeDef },
    },
    wrap(({ definition }) => svc.saveNodeType(definition, "update")),
  );

  server.registerTool(
    "delete_node_type",
    {
      title: "Delete node type",
      description: "Delete a node type from the user's node directory.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    wrap(({ id }) => {
      svc.deleteNodeType(id);
      return { deleted: id };
    }),
  );

  server.registerTool(
    "test_node_type",
    {
      title: "Test node type",
      description: "Run one node type in isolation with sample inputs and params; returns outputs, error and logs.",
      inputSchema: {
        id: z.string(),
        inputs: z.record(z.string(), z.any()).optional().describe("value per input port"),
        params: z.record(z.string(), z.any()).optional(),
      },
    },
    wrap(async ({ id, inputs, params }) => {
      const run = await svc.testNodeType(id, inputs, params);
      const n = run.nodes.node;
      return { status: n.status, outputs: n.outputs, error: n.error, logs: n.logs.slice(-50) };
    }),
  );

  server.registerTool(
    "reload_node_types",
    {
      title: "Reload node types",
      description: "Re-read node type files from disk (after editing YAML files directly).",
      inputSchema: {},
    },
    wrap(() => ({ ...svc.reloadNodeTypes(), count: svc.listNodeTypes().length })),
  );

  // ---------- workflows ----------
  server.registerTool(
    "list_workflows",
    { title: "List workflows", description: "List stored workflows.", inputSchema: {}, annotations: { readOnlyHint: true } },
    wrap(() => svc.listWorkflows()),
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Get workflow",
      description: "Full workflow graph: nodes (id, type, params, position) and edges, plus its version.",
      inputSchema: { id: workflowId },
      annotations: { readOnlyHint: true },
    },
    wrap(({ id }) => svc.getWorkflow(id)),
  );

  server.registerTool(
    "create_workflow",
    {
      title: "Create workflow",
      description: "Create a workflow, optionally with initial nodes and edges.",
      inputSchema: {
        name: z.string(),
        id: z.string().optional().describe("defaults to a random short id"),
        description: z.string().optional(),
        nodes: z.array(WorkflowNode).optional(),
        edges: z.array(WorkflowEdge).optional(),
      },
    },
    wrap((args) => {
      const wf = svc.createWorkflow(args);
      return { workflow: wf, issues: svc.validateWorkflow(wf.id) };
    }),
  );

  server.registerTool(
    "export_workflow",
    {
      title: "Export workflow",
      description:
        "Get a workflow as a portable JSON document (format naturoflow.workflow): nodes, params, cables, and the custom node types it uses. Saved credentials and chosen past results are left out. Save it to a file to back up or share; import_workflow restores it.",
      inputSchema: { id: z.string() },
    },
    wrap(({ id }) => svc.exportWorkflow(id)),
  );

  server.registerTool(
    "import_workflow",
    {
      title: "Import workflow",
      description:
        "Create a new workflow from a document returned by export_workflow (or a bare workflow object). Missing custom node types it carries are added. Returns the workflow and warnings: nodes that need a credential chosen, missing node types, local files that don't exist here.",
      inputSchema: {
        doc: z.record(z.string(), z.any()).describe("the exported document"),
        name: z.string().optional().describe("name for the new workflow; defaults to the exported name"),
      },
    },
    wrap(({ doc, name }) => {
      const res = svc.importWorkflow(doc, { name });
      return { ...res, issues: svc.validateWorkflow(res.workflow.id) };
    }),
  );

  server.registerTool(
    "delete_workflow",
    {
      title: "Delete workflow",
      description: "Delete a workflow.",
      inputSchema: { id: workflowId },
      annotations: { destructiveHint: true },
    },
    wrap(({ id }) => {
      svc.deleteWorkflow(id);
      return { deleted: id };
    }),
  );

  server.registerTool(
    "apply_workflow_patch",
    {
      title: "Apply workflow patch",
      description:
        "Apply several edits atomically (all or nothing). Ops: add_node {node}, update_node {id, params?, replaceParams?, position?, label?, type?}, remove_node {id}, connect {edge}, disconnect {edge}, rename {name, description?}, set_tool {tool: {name, description?} | null}. Connecting to an input that already has an edge replaces it. Returns validation issues of the result.",
      inputSchema: { workflowId, ops: z.array(PatchOp).min(1), expectedVersion },
    },
    wrap(({ workflowId, ops, expectedVersion }) => patch(workflowId, ops, expectedVersion)),
  );

  server.registerTool(
    "add_node",
    {
      title: "Add node",
      description: "Add a node to a workflow.",
      inputSchema: { workflowId, node: WorkflowNode, expectedVersion },
    },
    wrap(({ workflowId, node, expectedVersion }) => patch(workflowId, [{ op: "add_node", node }], expectedVersion)),
  );

  server.registerTool(
    "update_node",
    {
      title: "Update node",
      description:
        "Change a node's params (merged unless replaceParams), position, label, type, selected credential, or pin it to an earlier result (pin: {runId}) so runs reuse that result instead of executing it. When a pinned node runs again (e.g. run_node), the pin moves to the new result.",
      inputSchema: {
        workflowId,
        id: z.string(),
        params: z.record(z.string(), z.any()).optional(),
        replaceParams: z.boolean().optional(),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
        label: z.string().optional(),
        type: z.string().optional(),
        credential: z.string().nullable().optional().describe("saved credential id (see list_credentials); null clears it"),
        pin: z
          .object({ runId: z.string() })
          .nullable()
          .optional()
          .describe("use this node's result from that run (see get_node_history) instead of executing it; null un-pins"),
        expectedVersion,
      },
    },
    wrap(({ workflowId, expectedVersion, ...rest }) => patch(workflowId, [{ op: "update_node", ...rest }], expectedVersion)),
  );

  server.registerTool(
    "remove_node",
    {
      title: "Remove node",
      description: "Remove a node and its edges.",
      inputSchema: { workflowId, id: z.string(), expectedVersion },
    },
    wrap(({ workflowId, id, expectedVersion }) => patch(workflowId, [{ op: "remove_node", id }], expectedVersion)),
  );

  server.registerTool(
    "connect",
    {
      title: "Connect ports",
      description: "Connect an output port to an input port.",
      inputSchema: { workflowId, edge: WorkflowEdge, expectedVersion },
    },
    wrap(({ workflowId, edge, expectedVersion }) => patch(workflowId, [{ op: "connect", edge }], expectedVersion)),
  );

  server.registerTool(
    "disconnect",
    {
      title: "Disconnect ports",
      description: "Remove an edge.",
      inputSchema: { workflowId, edge: WorkflowEdge, expectedVersion },
    },
    wrap(({ workflowId, edge, expectedVersion }) => patch(workflowId, [{ op: "disconnect", edge }], expectedVersion)),
  );

  server.registerTool(
    "validate_workflow",
    {
      title: "Validate workflow",
      description: "Check node types, required params, port connections, type compatibility and cycles.",
      inputSchema: { id: workflowId },
      annotations: { readOnlyHint: true },
    },
    wrap(({ id }) => {
      const issues = svc.validateWorkflow(id);
      return { valid: issues.length === 0, issues };
    }),
  );

  server.registerTool(
    "auto_layout",
    {
      title: "Auto layout",
      description: "Arrange nodes left-to-right by dependency depth.",
      inputSchema: { id: workflowId },
    },
    wrap(({ id }) => ({ version: svc.autoLayout(id).version })),
  );

  // ---------- runs ----------
  server.registerTool(
    "run_workflow",
    {
      title: "Run workflow",
      description:
        "Run a workflow. By default waits up to waitSeconds for completion; if still running, returns the current state — poll with get_run.",
      inputSchema: {
        id: workflowId,
        inputs: z.record(z.string(), z.any()).optional().describe("values for core.input nodes, keyed by params.key"),
        waitSeconds: z.number().min(0).max(300).default(45),
        useCache: z.boolean().default(true).describe("reuse cached outputs of cacheable nodes (e.g. ffmpeg) when inputs are unchanged"),
      },
    },
    wrap(async ({ id, inputs, waitSeconds, useCache }) => {
      const started = await svc.runWorkflow(id, inputs ?? {}, { wait: false, useCache });
      return summarizeRun(await svc.waitForRun(started.id, waitSeconds * 1000));
    }),
  );

  server.registerTool(
    "get_run",
    {
      title: "Get run",
      description: "Run status with per-node status, errors and outputs.",
      inputSchema: { id: z.string(), waitSeconds: z.number().min(0).max(300).default(0) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ id, waitSeconds }) => summarizeRun(await svc.waitForRun(id, waitSeconds * 1000))),
  );

  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: "Recent runs, newest first.",
      inputSchema: { workflowId: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true },
    },
    wrap(({ workflowId, limit }) => svc.listRuns(workflowId, limit)),
  );

  server.registerTool(
    "get_node_run_logs",
    {
      title: "Get node logs",
      description: "Logs, inputs and outputs of one node within a run.",
      inputSchema: { runId: z.string(), nodeId: z.string(), tail: z.number().int().min(1).max(2000).default(200) },
      annotations: { readOnlyHint: true },
    },
    wrap(({ runId, nodeId, tail }) => {
      const n = svc.getRun(runId).nodes[nodeId];
      if (!n) throw new NfError("NODE_NOT_FOUND", `node "${nodeId}" not in run`);
      return { ...n, logs: n.logs.slice(-tail) };
    }),
  );

  server.registerTool(
    "run_node",
    {
      title: "Run a single node",
      description:
        "Run one node on its own — no upstream or downstream nodes. Inputs: `inputs` if given, else that node's inputs from `fromRunId` (a runId from get_node_history), else from its most recent execution. params \"current\" (default) uses the node's current params, \"history\" replays the params recorded in that execution. Cache is off unless useCache. The result is added to the node's history.",
      inputSchema: {
        workflowId,
        nodeId: z.string(),
        fromRunId: z.string().optional(),
        inputs: z.record(z.string(), z.any()).optional().describe("value per input port"),
        params: z.enum(["current", "history"]).default("current"),
        useCache: z.boolean().default(false),
        waitSeconds: z.number().min(0).max(300).default(45),
      },
    },
    wrap(async ({ workflowId, nodeId, fromRunId, inputs, params, useCache, waitSeconds }) => {
      const started = await svc.runSingleNode(workflowId, nodeId, { fromRunId, inputs, params, useCache, wait: false });
      const run = await svc.waitForRun(started.id, waitSeconds * 1000);
      const { logs, ...node } = run.nodes[nodeId];
      return { runId: run.id, status: run.status, node: { ...node, logs: logs.slice(-30) } };
    }),
  );

  server.registerTool(
    "list_artifacts",
    {
      title: "List generated files",
      description:
        "Files (images, videos, audio…) produced by a workflow's runs, newest first, each with the node that created it, its params at the time (e.g. the prompt), and the user's star/note. Use it to look back at earlier results or compare attempts. Page with `before` = nextBefore.",
      inputSchema: {
        workflowId,
        limit: z.number().int().min(1).max(100).default(20),
        before: z.number().optional(),
        nodeId: z.string().optional(),
        starred: z.boolean().optional().describe("only files the user starred"),
        mime: z.string().optional().describe('mime prefix filter, e.g. "image/" or "video/"'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ workflowId, ...opts }) => svc.listArtifacts(workflowId, opts)),
  );

  server.registerTool(
    "mark_artifact",
    {
      title: "Star or annotate a generated file",
      description: "Star a generated file and/or set a note on it (shown in the user's gallery).",
      inputSchema: { path: z.string(), starred: z.boolean().optional(), note: z.string().optional() },
    },
    wrap(({ path, starred, note }) => svc.markArtifact(path, { starred, note })),
  );

  server.registerTool(
    "get_node_history",
    {
      title: "Get node history",
      description:
        "Past executions of one node across runs, newest first: status, params used, the HTTP request/response or command line/stdout (secrets masked), inputs, outputs and errors. Page with `before` = the last entry's runStartedAt.",
      inputSchema: {
        workflowId,
        nodeId: z.string(),
        limit: z.number().int().min(1).max(50).default(10),
        before: z.number().optional(),
        includeLogs: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ workflowId, nodeId, limit, before, includeLogs }) =>
      svc.nodeHistory(workflowId, nodeId, { limit, before }).map((h) => {
        const { logs, runId: _r, nodeId: _n, ...node } = h.node;
        return { ...h, node: includeLogs ? { ...node, logs } : node };
      }),
    ),
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel run",
      description: "Cancel a running workflow; running processes are killed.",
      inputSchema: { id: z.string() },
    },
    wrap(({ id }) => ({ cancelled: svc.cancelRun(id) })),
  );

  server.registerTool(
    "rerun_from_node",
    {
      title: "Rerun from node",
      description:
        "Re-run one node and everything downstream of it, reusing an earlier run's outputs for all other nodes. Uses the workflow's current definition: edit a node's params, then rerun from it.",
      inputSchema: { runId: z.string(), nodeId: z.string(), waitSeconds: z.number().min(0).max(300).default(45) },
    },
    wrap(async ({ runId, nodeId, waitSeconds }) => {
      const started = await svc.rerunFromNode(runId, nodeId, { wait: false });
      return summarizeRun(await svc.waitForRun(started.id, waitSeconds * 1000));
    }),
  );

  server.registerTool(
    "list_credentials",
    {
      title: "List credentials",
      description:
        "Saved credentials (API keys etc.) by name and id — values are never returned. Node types that declare `credentials` need one selected per node: update_node {credential: <id>}. The user creates and fills credentials in the canvas UI; ask them to add one if none exists.",
      inputSchema: { type: z.string().optional().describe("credential type, e.g. the node type id") },
      annotations: { readOnlyHint: true },
    },
    wrap(({ type }) => svc.listCredentials(type).map(({ id, type, name, fields, values }) => ({ id, type, name, fields, values }))),
  );

  server.registerTool(
    "clear_cache",
    {
      title: "Clear node cache",
      description: "Forget all cached node outputs so cacheable nodes execute again.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    wrap(() => ({ cleared: svc.clearCache() })),
  );

  // ---------- publishing ----------
  server.registerTool(
    "get_workflow_interface",
    {
      title: "Get workflow interface",
      description: "The inputs (from core.input nodes: key, type, required) and outputs (core.output keys) of a workflow.",
      inputSchema: { id: workflowId },
      annotations: { readOnlyHint: true },
    },
    wrap(({ id }) => ({ ...svc.getWorkflowInterface(id), tool: svc.getWorkflow(id).tool ?? null })),
  );

  server.registerTool(
    "publish_workflow",
    {
      title: "Publish workflow as tool",
      description:
        "Expose a workflow as its own MCP tool. Its core.input nodes (params.key / type / description / required) become the tool's arguments; file inputs take absolute paths. Clients see the new tool immediately.",
      inputSchema: {
        id: workflowId,
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).describe("tool name, e.g. video_to_gif"),
        description: z.string().optional().describe("what the tool does, for the calling agent"),
      },
    },
    wrap(({ id, name, description }) => {
      if (BUILTIN_TOOL_NAMES.has(name)) throw new NfError("CONFLICT", `"${name}" is a built-in tool name`);
      const { workflow } = svc.applyPatch(id, [{ op: "set_tool", tool: { name, ...(description ? { description } : {}) } }]);
      return { tool: workflow.tool, interface: svc.getWorkflowInterface(id) };
    }),
  );

  server.registerTool(
    "unpublish_workflow",
    {
      title: "Unpublish workflow",
      description: "Stop exposing a workflow as an MCP tool.",
      inputSchema: { id: workflowId },
    },
    wrap(({ id }) => {
      svc.applyPatch(id, [{ op: "set_tool", tool: null }]);
      return { unpublished: id };
    }),
  );

  // Every tool registered so far is built in; published workflows may not shadow them.
  const BUILTIN_TOOL_NAMES = new Set(Object.keys((server as unknown as { _registeredTools?: object })._registeredTools ?? {}));
  const published = new Map<string, { sig: string; tool: RegisteredTool }>();

  /** Register/update/remove one MCP tool per published workflow. */
  const syncPublished = () => {
    const want = new Map(
      svc
        .listPublished()
        .filter((w) => !BUILTIN_TOOL_NAMES.has(w.tool.name))
        .map((w) => [w.tool.name, w]),
    );
    for (const [name, entry] of published) {
      if (!want.has(name)) {
        entry.tool.remove();
        published.delete(name);
      }
    }
    for (const [name, wf] of want) {
      const iface = workflowInterface(wf);
      const sig = JSON.stringify([wf.id, wf.tool, iface]);
      const cur = published.get(name);
      if (cur?.sig === sig) continue;
      cur?.tool.remove();
      const tool = server.registerTool(
        name,
        {
          title: wf.name,
          description:
            (wf.tool.description ?? wf.description ?? `Runs the naturoflow workflow "${wf.name}".`) +
            (iface.outputs.length ? ` Returns: ${iface.outputs.join(", ")}.` : ""),
          inputSchema: toolShape(iface),
        },
        wrap(async (args: Record<string, unknown>) => {
          const started = await svc.runWorkflow(wf.id, args, { wait: false });
          const run = await svc.waitForRun(started.id, 120_000);
          if (run.status === "running") return { status: "running", runId: run.id, hint: "poll with get_run" };
          if (run.status !== "success") throw new NfError("RUN_FAILED", run.error ?? `run ${run.status}`, run.id);
          return { outputs: run.outputs, runId: run.id };
        }),
      );
      published.set(name, { sig, tool });
    }
  };
  syncPublished();

  // ---------- resources ----------
  server.registerResource(
    "node-type-spec",
    "naturoflow://docs/node-type-spec",
    { title: "Node type spec", description: "How to write node types and templates", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: NODE_TYPE_SPEC }] }),
  );

  const json = (uri: URL, value: unknown) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  });

  server.registerResource(
    "workflow",
    new ResourceTemplate("naturoflow://workflows/{id}", {
      list: async () => ({
        resources: svc.listWorkflows().map((w) => ({ uri: `naturoflow://workflows/${w.id}`, name: w.name, mimeType: "application/json" })),
      }),
    }),
    { title: "Workflow", mimeType: "application/json" },
    async (uri, { id }) => json(uri, svc.getWorkflow(String(id))),
  );

  server.registerResource(
    "node-type",
    new ResourceTemplate("naturoflow://node-types/{id}", {
      list: async () => ({
        resources: svc.listNodeTypes().map((t) => ({ uri: `naturoflow://node-types/${t.id}`, name: t.name, mimeType: "application/json" })),
      }),
    }),
    { title: "Node type", mimeType: "application/json" },
    async (uri, { id }) => json(uri, svc.getNodeType(String(id))),
  );

  server.registerResource(
    "run",
    new ResourceTemplate("naturoflow://runs/{id}", { list: undefined }),
    { title: "Run", mimeType: "application/json" },
    async (uri, { id }) => json(uri, svc.getRun(String(id))),
  );

  // Tell the client when the resource lists change.
  const onEvent = (e: ServiceEvent) => {
    if (!server.isConnected()) return;
    if (e.type === "workflow.changed" || e.type === "workflow.deleted") syncPublished();
    if (e.type === "workflow.deleted" || e.type === "nodeType.changed" || (e.type === "workflow.changed" && e.workflow.version === 1)) {
      server.sendResourceListChanged();
    }
  };
  svc.on("event", onEvent);
  const close = server.close.bind(server);
  server.close = async () => {
    svc.off("event", onEvent);
    await close();
  };

  return server;
}
