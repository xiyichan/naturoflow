import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { Engine, topoOrder, validateWorkflow, type EngineEvent, type RunOptions, type ValidationIssue } from "./engine.ts";
import { NodeRegistry } from "./registry.ts";
import { isFileRef, toFileRef } from "./files.ts";
import { SecretBox } from "./secrets.ts";
import { Store } from "./store.ts";
import {
  NfError,
  ToolPublish,
  credentialTypeOf,
  type FileRef,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  type NodeRunRecord,
  type RunRecord,
  type WorkflowInput,
} from "./types.ts";

/** A workflow's callable interface, derived from its core.input / core.output nodes. */
export interface WorkflowInterface {
  inputs: { key: string; type: string; description?: string; required: boolean; default?: unknown }[];
  outputs: string[];
}

export function workflowInterface(wf: Workflow): WorkflowInterface {
  const inputs = wf.nodes
    .filter((n) => n.type === "core.input")
    .map((n) => ({
      key: String(n.params.key ?? n.id),
      type: String(n.params.type ?? "any"),
      ...(n.params.description ? { description: String(n.params.description) } : {}),
      required: n.params.required !== false && n.params.default === undefined,
      ...(n.params.default !== undefined ? { default: n.params.default } : {}),
    }));
  const outputs = wf.nodes.filter((n) => n.type === "core.output").map((n) => String(n.params.key ?? n.id));
  return { inputs, outputs };
}

export const DEFAULT_ALLOWED_BINS = ["ffmpeg", "ffprobe", "echo", "cat", "curl", "convert", "magick", "sox"];

export interface ServiceConfig {
  home: string;
  allowedBins: string[];
  concurrency: number;
  /** Extra read-only node directories (e.g. bundled examples). */
  nodeDirs: string[];
  /** Reload node types when files in the node directories change (default true). */
  watch?: boolean;
}

export function loadConfig(homeDir = process.env.NATUROFLOW_HOME ?? path.join(os.homedir(), ".naturoflow")): ServiceConfig {
  // Absolute, because executors run with cwd set to the node's output directory.
  const home = path.resolve(homeDir);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "config.yaml");
  const user = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) : {};
  const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/nodes");
  return {
    home,
    allowedBins: user.allowedBins ?? DEFAULT_ALLOWED_BINS,
    concurrency: user.concurrency ?? 4,
    nodeDirs: user.nodeDirs ?? [examples],
  };
}

/** One patch operation; `apply_workflow_patch` takes an array of these. */
export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: WorkflowNode }),
  z.object({
    op: z.literal("update_node"),
    id: z.string(),
    params: z.record(z.string(), z.any()).optional(),
    /** Replace params entirely instead of merging. */
    replaceParams: z.boolean().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    label: z.string().optional(),
    type: z.string().optional(),
    /** Saved credential id to use; null clears it. */
    credential: z.string().nullable().optional(),
    /** Use this node's result from that run instead of executing it; null un-pins. */
    pin: z.object({ runId: z.string() }).nullable().optional(),
  }),
  z.object({ op: z.literal("remove_node"), id: z.string() }),
  z.object({ op: z.literal("connect"), edge: WorkflowEdge }),
  z.object({ op: z.literal("disconnect"), edge: WorkflowEdge }),
  z.object({ op: z.literal("rename"), name: z.string(), description: z.string().optional() }),
  /** Publish as an MCP tool (or pass `tool: null` to unpublish). */
  z.object({ op: z.literal("set_tool"), tool: ToolPublish.nullable() }),
]);
export type PatchOp = z.input<typeof PatchOp>;

/** One past result of a node, for canvas previews. */
export interface NodePreview {
  runId: string;
  at: number;
  single?: boolean;
  cached?: string;
  outputs: Record<string, unknown>;
  inactive?: string[];
}

/** A file produced by a workflow run, with what produced it. */
export interface Artifact {
  path: string;
  size: number;
  mime: string;
  runId: string;
  runStartedAt: number;
  runStatus: RunRecord["status"];
  single?: RunRecord["single"];
  rerunOf?: RunRecord["rerunOf"];
  nodeId: string;
  nodeType?: string;
  nodeLabel?: string;
  /** Output port, e.g. "files[2]" or "results[0].gif". */
  port: string;
  createdAt: number;
  /** The producing node's params at the time (secrets masked). */
  params?: Record<string, unknown>;
  /** Upstream nodes in the same run and their params at the time, nearest first (e.g. the prompt). */
  lineage?: { nodeId: string; nodeType?: string; nodeLabel?: string; params?: Record<string, unknown> }[];
  starred: boolean;
  note: string;
}

/** A saved credential as shown to the UI / MCP: never includes secret values. */
export interface CredentialInfo {
  id: string;
  type: string;
  name: string;
  /** Fields that have a value. */
  fields: string[];
  /** Non-secret field values (e.g. a region or account id), safe to display. */
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export type ServiceEvent =
  | EngineEvent
  | { type: "credentials.changed"; credentialType: string }
  | { type: "workflow.changed"; workflow: Workflow }
  | { type: "workflow.deleted"; id: string }
  | { type: "nodeType.changed"; id: string };

/**
 * The single service layer. REST, WebSocket, MCP and the CLI all call into this,
 * so anything one surface can do, the others can too.
 */
export class NaturoflowService extends EventEmitter {
  readonly registry: NodeRegistry;
  readonly store: Store;
  readonly engine: Engine;
  private liveRuns = new Map<string, RunRecord>();
  private secrets: SecretBox;
  private watchers: fs.FSWatcher[] = [];
  private reloadTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly config: ServiceConfig = loadConfig()) {
    super();
    config.home = path.resolve(config.home);
    const userNodes = path.join(config.home, "nodes");
    fs.mkdirSync(userNodes, { recursive: true });
    this.registry = new NodeRegistry([...config.nodeDirs, userNodes], userNodes);
    if (config.watch !== false) this.watchNodeDirs([...config.nodeDirs, userNodes]);
    this.store = new Store(path.join(config.home, "naturoflow.db"));
    this.secrets = new SecretBox(config.home);
    this.store.cancelInterruptedRuns("interrupted: the server stopped while this was running");
    this.engine = new Engine(this.registry, {
      runsDir: path.join(config.home, "runs"),
      allowedBins: config.allowedBins,
      concurrency: config.concurrency,
      loadWorkflow: (id) => this.store.getWorkflow(id),
      getCredential: (id) => this.resolveCredential(id),
      cache: { get: (k) => this.store.getCache(k), set: (k, v) => this.store.setCache(k, v) },
    });
    this.engine.on("event", (e: EngineEvent) => {
      if (e.type === "run.started") this.liveRuns.set(e.run.id, e.run);
      if (e.type === "node.finished") {
        const run = this.liveRuns.get(e.runId);
        if (run) this.store.saveRun(run);
      }
      if (e.type === "run.finished") {
        this.store.saveRun(e.run);
        this.liveRuns.delete(e.run.id);
      }
      this.emit("event", e);
    });
  }

  // ---- node types ----
  listNodeTypes() {
    return this.registry.list().map(({ def, source, readonly }) => ({
      id: def.id,
      name: def.name,
      category: def.category,
      description: def.description,
      executor: def.executor.kind,
      inputs: def.inputs,
      outputs: def.outputs,
      source,
      readonly,
    }));
  }

  getNodeType(id: string) {
    const t = this.registry.require(id);
    return { ...t.def, source: t.source, readonly: t.readonly };
  }

  /**
   * Create or replace a node type. `def` may be an object or a YAML/JSON string.
   * `mode` guards against accidentally overwriting (create) or typo-creating (update).
   */
  saveNodeType(def: unknown, mode: "create" | "update" | "upsert" = "upsert") {
    const obj = typeof def === "string" ? YAML.parse(def) : def;
    const id = (obj as { id?: string })?.id;
    const exists = !!id && !!this.registry.get(id);
    if (mode === "create" && exists) throw new NfError("CONFLICT", `node type "${id}" already exists; use update`);
    if (mode === "update" && !exists) throw new NfError("NODE_TYPE_NOT_FOUND", `node type "${id}" does not exist`);
    const saved = this.registry.save(obj);
    this.emit("event", { type: "nodeType.changed", id: saved.id } satisfies ServiceEvent);
    return saved;
  }

  deleteNodeType(id: string) {
    this.registry.delete(id);
    this.emit("event", { type: "nodeType.changed", id } satisfies ServiceEvent);
  }

  reloadNodeTypes() {
    const result = this.registry.reload();
    this.emit("event", { type: "nodeType.changed", id: "*" } satisfies ServiceEvent);
    return result;
  }

  /** Editing a node YAML file updates open canvases without a restart. */
  private watchNodeDirs(dirs: string[]) {
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, (_event, file) => {
          if (file && !/\.(ya?ml|json)$/.test(String(file))) return;
          clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => {
            const { errors } = this.reloadNodeTypes();
            for (const e of errors) console.error(`[naturoflow] node type ${e.file}: ${e.message}`);
          }, 200);
        });
        w.unref();
        this.watchers.push(w);
      } catch {
        // Watching is a convenience; reload_node_types still works without it.
      }
    }
  }

  /** Run a single node type in isolation with sample inputs/params. */
  async testNodeType(id: string, inputs: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
    this.registry.require(id);
    const wf = Workflow.parse({
      id: `__test__${id}`,
      name: `test ${id}`,
      nodes: [{ id: "node", type: id, params }],
    });
    // Feed sample inputs through const nodes so the engine sees a normal graph.
    const def = this.registry.require(id).def;
    for (const [port, value] of Object.entries(inputs)) {
      if (!def.inputs[port]) throw new NfError("PORT_NOT_FOUND", `${id} has no input "${port}"`);
      wf.nodes.push(WorkflowNode.parse({ id: `in_${port}`, type: "core.const", params: { value } }));
      wf.edges.push({ from: { node: `in_${port}`, port: "value" }, to: { node: "node", port } });
    }
    return this.engine.run(wf, {}, { useCache: false });
  }

  // ---- workflows ----
  listWorkflows() {
    return this.store.listWorkflows();
  }

  getWorkflow(id: string): Workflow {
    const wf = this.store.getWorkflow(id);
    if (!wf) throw new NfError("WORKFLOW_NOT_FOUND", `workflow "${id}" not found`);
    return wf;
  }

  createWorkflow(input: Partial<WorkflowInput> & { name: string }): Workflow {
    const wf = Workflow.parse({ id: input.id ?? randomUUID().slice(0, 8), ...input, version: 1 });
    if (this.store.getWorkflow(wf.id)) throw new NfError("CONFLICT", `workflow "${wf.id}" already exists`);
    return this.commit(wf);
  }

  /** Replace a workflow wholesale. Pass `expectedVersion` to guard against concurrent edits. */
  saveWorkflow(input: WorkflowInput, expectedVersion?: number): Workflow {
    const wf = Workflow.parse(input);
    const cur = this.store.getWorkflow(wf.id);
    if (cur && expectedVersion !== undefined && cur.version !== expectedVersion) {
      throw new NfError("VERSION_CONFLICT", `workflow is at version ${cur.version}, expected ${expectedVersion}`);
    }
    wf.version = (cur?.version ?? 0) + 1;
    return this.commit(wf);
  }

  deleteWorkflow(id: string) {
    if (!this.store.deleteWorkflow(id)) throw new NfError("WORKFLOW_NOT_FOUND", `workflow "${id}" not found`);
    this.emit("event", { type: "workflow.deleted", id } satisfies ServiceEvent);
  }

  /** Apply edit operations atomically: either all succeed or nothing is saved. */
  applyPatch(id: string, ops: PatchOp[], expectedVersion?: number): { workflow: Workflow; issues: ValidationIssue[] } {
    const cur = this.getWorkflow(id);
    if (expectedVersion !== undefined && cur.version !== expectedVersion) {
      throw new NfError("VERSION_CONFLICT", `workflow is at version ${cur.version}, expected ${expectedVersion}`);
    }
    const wf: Workflow = structuredClone(cur);
    ops.forEach((raw, i) => {
      const op = PatchOp.parse(raw);
      const at = `ops[${i}]`;
      const find = (nid: string) => {
        const n = wf.nodes.find((n) => n.id === nid);
        if (!n) throw new NfError("NODE_NOT_FOUND", `node "${nid}" not found`, at);
        return n;
      };
      switch (op.op) {
        case "add_node":
          if (wf.nodes.some((n) => n.id === op.node.id)) throw new NfError("CONFLICT", `node "${op.node.id}" exists`, at);
          this.registry.require(op.node.type);
          wf.nodes.push(op.node);
          break;
        case "update_node": {
          const n = find(op.id);
          if (op.type) n.type = this.registry.require(op.type).def.id;
          if (op.params) n.params = op.replaceParams ? op.params : { ...n.params, ...op.params };
          if (op.position) n.position = op.position;
          if (op.label !== undefined) n.label = op.label;
          if (op.credential === null) delete n.credential;
          else if (op.credential !== undefined) n.credential = op.credential;
          if (op.pin === null) delete n.pin;
          else if (op.pin) {
            const rec = this.store.getRun(op.pin.runId)?.nodes[n.id];
            if (!rec || rec.status !== "success") throw new NfError("INVALID_ARGUMENT", `run "${op.pin.runId}" has no successful result for node "${n.id}"`, at);
            n.pin = { runId: op.pin.runId };
          }
          break;
        }
        case "remove_node":
          find(op.id);
          wf.nodes = wf.nodes.filter((n) => n.id !== op.id);
          wf.edges = wf.edges.filter((e) => e.from.node !== op.id && e.to.node !== op.id);
          break;
        case "connect":
          find(op.edge.from.node);
          find(op.edge.to.node);
          // An input port takes one edge: connecting replaces the previous one.
          wf.edges = wf.edges.filter((e) => !(e.to.node === op.edge.to.node && e.to.port === op.edge.to.port));
          wf.edges.push(op.edge);
          break;
        case "disconnect":
          wf.edges = wf.edges.filter((e) => JSON.stringify(e) !== JSON.stringify(op.edge));
          break;
        case "rename":
          wf.name = op.name;
          if (op.description !== undefined) wf.description = op.description;
          break;
        case "set_tool":
          if (op.tool) {
            const clash = this.store.allWorkflows().find((w) => w.id !== wf.id && w.tool?.name === op.tool!.name);
            if (clash) throw new NfError("CONFLICT", `tool name "${op.tool.name}" is used by workflow "${clash.id}"`, at);
            wf.tool = op.tool;
          } else delete wf.tool;
          break;
      }
    });
    wf.version = cur.version + 1;
    const saved = this.commit(wf);
    return { workflow: saved, issues: this.validateWorkflow(saved) };
  }

  /** Layered left-to-right layout by dependency depth. */
  autoLayout(id: string): Workflow {
    const wf = structuredClone(this.getWorkflow(id));
    const depth = new Map<string, number>();
    const order = topoOrder(wf) ?? wf.nodes.map((n) => n.id);
    for (const nid of order) {
      const preds = wf.edges.filter((e) => e.to.node === nid).map((e) => depth.get(e.from.node) ?? 0);
      depth.set(nid, preds.length ? Math.max(...preds) + 1 : 0);
    }
    const rows = new Map<number, number>();
    for (const nid of order) {
      const d = depth.get(nid)!;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      wf.nodes.find((n) => n.id === nid)!.position = { x: d * 300, y: row * 160 };
    }
    wf.version += 1;
    return this.commit(wf);
  }

  validateWorkflow(idOrWorkflow: string | WorkflowInput): ValidationIssue[] {
    const wf = typeof idOrWorkflow === "string" ? this.getWorkflow(idOrWorkflow) : Workflow.parse(idOrWorkflow);
    return [...validateWorkflow(wf, this.registry), ...this.credentialIssues(wf)];
  }

  /** Nodes whose type needs a credential but have none selected, or point at a missing/wrong one. */
  private credentialIssues(wf: Workflow): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const n of wf.nodes) {
      const def = this.registry.get(n.type)?.def;
      const type = def && credentialTypeOf(def);
      if (!def || !type) continue;
      if (!n.credential) {
        if (def.credentials!.required) {
          issues.push({ code: "MISSING_CREDENTIAL", message: `select a ${def.credentials!.name ?? type} credential`, nodeId: n.id, path: "credential" });
        }
        continue;
      }
      const c = this.store.getCredential(n.credential);
      if (!c) issues.push({ code: "CREDENTIAL_NOT_FOUND", message: `credential "${n.credential}" no longer exists`, nodeId: n.id, path: "credential" });
      else if (c.type !== type) {
        issues.push({ code: "CREDENTIAL_TYPE_MISMATCH", message: `credential "${c.name}" is a ${c.type} credential, expected ${type}`, nodeId: n.id, path: "credential" });
      }
    }
    return issues;
  }

  // ---- credentials ----
  /** The credential fields a credential type expects, taken from the node types that declare it. */
  credentialSpec(type: string) {
    for (const { def } of this.registry.list()) {
      if (credentialTypeOf(def) === type) return { type, name: def.credentials!.name ?? type, fields: def.credentials!.fields };
    }
    return undefined;
  }

  listCredentials(type?: string): CredentialInfo[] {
    return this.store.listCredentials(type).map((c) => this.info(c));
  }

  createCredential(input: { type: string; name: string; data: Record<string, string> }): CredentialInfo {
    const spec = this.credentialSpec(input.type);
    if (!spec) throw new NfError("UNKNOWN_CREDENTIAL_TYPE", `no node type declares credential type "${input.type}"`);
    const name = input.name?.trim();
    if (!name) throw new NfError("INVALID_ARGUMENT", "name is required");
    const data = this.cleanCredentialData(spec.fields, input.data ?? {});
    for (const [k, f] of Object.entries(spec.fields)) {
      if (f.required && !data[k]) throw new NfError("INVALID_ARGUMENT", `${f.label ?? k} is required`, `data.${k}`);
    }
    const now = Date.now();
    const row = { id: randomUUID().slice(0, 8), type: input.type, name, data: this.secrets.encrypt(data), fields: Object.keys(data), createdAt: now, updatedAt: now };
    this.store.saveCredential(row);
    this.emit("event", { type: "credentials.changed", credentialType: input.type } satisfies ServiceEvent);
    return this.info(row);
  }

  /** Rename and/or change values. Fields left empty keep their stored value. */
  updateCredential(id: string, input: { name?: string; data?: Record<string, string> }): CredentialInfo {
    const cur = this.store.getCredential(id);
    if (!cur) throw new NfError("CREDENTIAL_NOT_FOUND", `credential "${id}" not found`);
    const spec = this.credentialSpec(cur.type);
    const old = this.secrets.decrypt<Record<string, string>>(cur.data);
    const data = { ...old, ...this.cleanCredentialData(spec?.fields ?? {}, input.data ?? {}) };
    const row = { ...cur, name: input.name?.trim() || cur.name, data: this.secrets.encrypt(data), fields: Object.keys(data), updatedAt: Date.now() };
    this.store.saveCredential(row);
    this.emit("event", { type: "credentials.changed", credentialType: cur.type } satisfies ServiceEvent);
    return this.info(row);
  }

  deleteCredential(id: string) {
    const cur = this.store.getCredential(id);
    if (!cur || !this.store.deleteCredential(id)) throw new NfError("CREDENTIAL_NOT_FOUND", `credential "${id}" not found`);
    this.emit("event", { type: "credentials.changed", credentialType: cur.type } satisfies ServiceEvent);
  }

  /** Workflows/nodes that use a credential (shown before deleting it). */
  credentialUsage(id: string): { workflowId: string; nodeId: string }[] {
    return this.store.allWorkflows().flatMap((w) => w.nodes.filter((n) => n.credential === id).map((n) => ({ workflowId: w.id, nodeId: n.id })));
  }

  /** Decrypted values, for the engine only. */
  private resolveCredential(id: string): { type: string; data: Record<string, string>; secrets: string[] } | undefined {
    const c = this.store.getCredential(id);
    if (!c) return undefined;
    const data = this.secrets.decrypt<Record<string, string>>(c.data);
    const spec = this.credentialSpec(c.type);
    const secrets = Object.entries(data)
      .filter(([k]) => spec?.fields[k]?.secret !== false)
      .map(([, v]) => v);
    return { type: c.type, data, secrets };
  }

  private cleanCredentialData(fields: Record<string, unknown>, data: Record<string, unknown>) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!(k in fields)) throw new NfError("INVALID_ARGUMENT", `unknown credential field "${k}"`, `data.${k}`);
      if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
    }
    return out;
  }

  private info(c: { id: string; type: string; name: string; data: string; fields: string[]; createdAt: number; updatedAt: number }): CredentialInfo {
    const spec = this.credentialSpec(c.type);
    const values: Record<string, string> = {};
    const nonSecret = Object.entries(spec?.fields ?? {}).filter(([, f]) => f.secret === false).map(([k]) => k);
    if (nonSecret.length) {
      const data = this.secrets.decrypt<Record<string, string>>(c.data);
      for (const k of nonSecret) if (data[k]) values[k] = data[k];
    }
    return { id: c.id, type: c.type, name: c.name, fields: c.fields, values, createdAt: c.createdAt, updatedAt: c.updatedAt };
  }

  private commit(wf: Workflow): Workflow {
    this.store.saveWorkflow(wf);
    this.emit("event", { type: "workflow.changed", workflow: wf } satisfies ServiceEvent);
    return wf;
  }

  // ---- runs ----
  /** Run a stored workflow (by id) or an ad-hoc workflow object. */
  async runWorkflow(
    idOrWorkflow: string | WorkflowInput,
    inputs: Record<string, unknown> = {},
    opts: { wait?: boolean; useCache?: boolean } = { wait: true },
  ): Promise<RunRecord> {
    const wf = typeof idOrWorkflow === "string" ? this.getWorkflow(idOrWorkflow) : Workflow.parse(idOrWorkflow);
    return this.start(wf, inputs, { useCache: opts.useCache }, opts.wait);
  }

  /**
   * Re-run `nodeId` and everything downstream of it, reusing the earlier run's outputs for all
   * other nodes. Uses the workflow's current definition, so edit a node's params then rerun from it.
   */
  async rerunFromNode(runId: string, nodeId: string, opts: { wait?: boolean } = { wait: true }): Promise<RunRecord> {
    const prev = this.getRun(runId);
    const wf = this.getWorkflow(prev.workflowId);
    if (!wf.nodes.some((n) => n.id === nodeId)) throw new NfError("NODE_NOT_FOUND", `node "${nodeId}" not in workflow`);
    const downstream = new Set([nodeId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of wf.edges) {
        if (downstream.has(e.from.node) && !downstream.has(e.to.node)) {
          downstream.add(e.to.node);
          grew = true;
        }
      }
    }
    const reuse: Record<string, NodeRunRecord> = {};
    for (const [id, nr] of Object.entries(prev.nodes)) if (!downstream.has(id) && nr.status === "success") reuse[id] = nr;
    return this.start(wf, prev.inputs, { reuse, rerunOf: { runId, fromNode: nodeId } }, opts.wait);
  }

  /**
   * Run one node on its own (no upstream/downstream). Inputs come from `inputs` if given, else from
   * the `fromRunId` run's record of this node, else from the node's most recent execution.
   * `params: "history"` replays that record's params; the default uses the node's current params.
   */
  async runSingleNode(
    workflowId: string,
    nodeId: string,
    opts: {
      fromRunId?: string;
      inputs?: Record<string, unknown>;
      params?: "current" | "history";
      useCache?: boolean;
      wait?: boolean;
    } = {},
  ): Promise<RunRecord> {
    const wf = this.getWorkflow(workflowId);
    const node = wf.nodes.find((n) => n.id === nodeId);
    if (!node) throw new NfError("NODE_NOT_FOUND", `node "${nodeId}" not in workflow`);
    const def = this.registry.require(node.type).def;

    // The source record: an explicit earlier run, else the latest time this node ran.
    let sourceRun: RunRecord | undefined;
    if (opts.fromRunId) {
      sourceRun = this.getRun(opts.fromRunId);
      if (sourceRun.workflowId !== workflowId || !sourceRun.nodes[nodeId]) {
        throw new NfError("NODE_NOT_FOUND", `run "${opts.fromRunId}" has no record of node "${nodeId}"`);
      }
    } else if (!opts.inputs || opts.params === "history") {
      const latest = this.store.nodeHistory(workflowId, nodeId, 1)[0];
      if (latest) sourceRun = this.getRun(latest.runId);
    }
    const source = sourceRun?.nodes[nodeId];

    // Each input takes its upstream node's current result: File / Constant values as they are now,
    // a pinned result, or that node's latest successful output. So after regenerating upstream,
    // running this node alone uses the new result. Replaying a history entry keeps its inputs.
    const fixed: Record<string, unknown> = {};
    if (!opts.fromRunId) {
      for (const e of wf.edges.filter((e) => e.to.node === nodeId)) {
        const up = wf.nodes.find((n) => n.id === e.from.node);
        if (!up) continue;
        try {
          if (up.type === "core.file" && typeof up.params.path === "string") {
            const p = up.params.path.startsWith("~/") ? path.join(os.homedir(), up.params.path.slice(2)) : up.params.path;
            fixed[e.to.port] = toFileRef(p);
            continue;
          }
          if (up.type === "core.const") {
            fixed[e.to.port] = up.params.value;
            continue;
          }
        } catch {
          continue; // a missing file: fall back to history / the missing-input error below
        }
        const rec = up.pin ? this.store.getRun(up.pin.runId)?.nodes[up.id] : this.store.nodeHistory(workflowId, up.id, 5).find((h) => h.node.status === "success")?.node;
        if (rec?.outputs && !rec.inactive?.includes(e.from.port) && rec.outputs[e.from.port] !== undefined) fixed[e.to.port] = rec.outputs[e.from.port];
      }
    }
    const inputs = opts.inputs ?? { ...(source?.inputs ?? {}), ...fixed };
    const missing = Object.entries(def.inputs).filter(([k, p]) => p.required && inputs[k] === undefined).map(([k]) => k);
    if (missing.length) {
      throw new NfError(
        "MISSING_INPUT",
        `no value for input ${missing.map((m) => `"${m}"`).join(", ")}: run the workflow once, pick a history entry, or provide inputs`,
      );
    }
    if (opts.params === "history" && !source?.params) {
      throw new NfError("NO_HISTORY_PARAMS", "that execution has no recorded params (it ran before params were recorded)");
    }

    return this.start(
      wf,
      sourceRun?.inputs ?? {},
      {
        single: {
          nodeId,
          inputs,
          ...(opts.params === "history" ? { params: source!.params } : {}),
          ...(sourceRun ? { fromRunId: sourceRun.id } : {}),
        },
        useCache: opts.useCache ?? false,
      },
      opts.wait,
    );
  }

  /** Pinned results of a workflow's nodes, for the engine. */
  private pinsOf(wf: Workflow): Record<string, NodeRunRecord> {
    const pins: Record<string, NodeRunRecord> = {};
    for (const n of wf.nodes) {
      const rec = n.pin ? this.store.getRun(n.pin.runId)?.nodes[n.id] : undefined;
      if (rec) pins[n.id] = rec;
    }
    return pins;
  }

  private start(wf: Workflow, inputs: Record<string, unknown>, ro: RunOptions, wait = true): Promise<RunRecord> {
    ro = { ...ro, pins: { ...this.pinsOf(wf), ...ro.pins } };
    if (wait) return this.engine.run(wf, inputs, ro);
    return new Promise<RunRecord>((resolve, reject) => {
      this.engine.run(wf, inputs, { ...ro, onStart: resolve }).catch(reject);
    });
  }

  getWorkflowInterface(id: string): WorkflowInterface {
    return workflowInterface(this.getWorkflow(id));
  }

  /** Workflows published as MCP tools. */
  listPublished(): (Workflow & { tool: ToolPublish })[] {
    return this.store.allWorkflows().filter((w): w is Workflow & { tool: ToolPublish } => !!w.tool);
  }

  clearCache(): number {
    return this.store.clearCache();
  }

  /** Resolve when the run finishes, or with its current state after `timeoutMs`. */
  waitForRun(id: string, timeoutMs: number): Promise<RunRecord> {
    const cur = this.getRun(id);
    if (!this.liveRuns.has(id)) return Promise.resolve(cur);
    return new Promise((resolve) => {
      const onEvent = (e: ServiceEvent) => {
        if (e.type === "run.finished" && e.run.id === id) finish(e.run);
      };
      const timer = setTimeout(() => finish(this.getRun(id)), timeoutMs);
      const finish = (run: RunRecord) => {
        clearTimeout(timer);
        this.off("event", onEvent);
        resolve(run);
      };
      this.on("event", onEvent);
    });
  }

  getRun(id: string): RunRecord {
    const run = this.liveRuns.get(id) ?? this.store.getRun(id);
    if (!run) throw new NfError("RUN_NOT_FOUND", `run "${id}" not found`);
    return run;
  }

  /**
   * Recent successful results of every node in a workflow, newest first (outputs only — no logs,
   * traces or inputs), for previews on the canvas.
   */
  nodePreviews(workflowId: string, limit = 20): Record<string, NodePreview[]> {
    const wf = this.getWorkflow(workflowId);
    const out: Record<string, NodePreview[]> = {};
    for (const n of wf.nodes) {
      if (n.type === "core.const" || n.type === "core.file" || n.type === "core.input") continue;
      const list = this.store
        .nodeHistory(workflowId, n.id, limit * 2)
        .filter((h) => h.node.status === "success" && h.node.cached !== "reuse" && h.node.cached !== "pin")
        .slice(0, limit)
        .map((h) => ({
          runId: h.runId,
          at: h.node.finishedAt ?? h.runStartedAt,
          ...(h.single ? { single: true } : {}),
          ...(h.node.cached ? { cached: h.node.cached } : {}),
          outputs: h.node.outputs ?? {},
          ...(h.node.inactive?.length ? { inactive: h.node.inactive } : {}),
        }));
      // A pinned result older than the window still shows up.
      if (n.pin && !list.some((p) => p.runId === n.pin!.runId)) {
        const rec = this.store.getRun(n.pin.runId)?.nodes[n.id];
        if (rec?.outputs) list.push({ runId: n.pin.runId, at: rec.finishedAt ?? 0, outputs: rec.outputs });
      }
      if (list.length) out[n.id] = list;
    }
    return this.maskSecrets(out);
  }

  /** A node's past executions (params, request/response, outputs, logs), newest first. */
  nodeHistory(workflowId: string, nodeId: string, opts: { limit?: number; before?: number } = {}) {
    this.getWorkflow(workflowId);
    const entries = this.store.nodeHistory(workflowId, nodeId, Math.min(Math.max(opts.limit ?? 20, 1), 200), opts.before);
    return this.maskSecrets(entries);
  }

  /**
   * Replace every saved credential's secret values in `value` with ****. Stored outputs keep real
   * values (downstream nodes and reruns need them); this is for displaying history.
   */
  private maskSecrets<T>(value: T): T {
    const secrets = this.store
      .listCredentials()
      .flatMap((c) => this.resolveCredential(c.id)?.secrets ?? [])
      .filter((v) => v.length >= 4)
      .sort((a, b) => b.length - a.length);
    if (!secrets.length) return value;
    let text = JSON.stringify(value);
    for (const v of secrets) text = text.split(JSON.stringify(v).slice(1, -1)).join("****");
    return JSON.parse(text);
  }

  /**
   * Files this workflow's runs produced, newest first. Each file appears once, attributed to the
   * node that created it (not to cached/reused copies or core.* pass-through nodes). Files that
   * were deleted from disk are left out.
   */
  listArtifacts(
    workflowId: string,
    opts: { limit?: number; before?: number; nodeId?: string; starred?: boolean; mime?: string } = {},
  ): { items: Artifact[]; nextBefore?: number } {
    const wf = this.getWorkflow(workflowId);
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 500);
    const starred = opts.starred ? this.store.starredPaths() : undefined;
    const byPath = new Map<string, Artifact>();
    const score = (a: Artifact) => (a.nodeType?.startsWith("core.") ? 0 : 1);
    let before = opts.before ?? Number.MAX_SAFE_INTEGER;
    let nextBefore: number | undefined;

    scan: while (true) {
      const runs = this.store.runsOf(workflowId, before, 50);
      if (!runs.length) break;
      for (const run of runs) {
        // A single-node run's upstream ran in the run its inputs came from — possibly through a
        // chain of replays — so follow fromRunId until the node's record turns up.
        const recordOf = (id: string) => {
          let r: RunRecord | undefined = run;
          for (let hops = 0; r && hops < 8; hops++) {
            if (r.nodes[id]) return r.nodes[id];
            r = r.single?.fromRunId ? this.store.getRun(r.single.fromRunId) : undefined;
          }
          return undefined;
        };
        const lineageOf = (nodeId: string) =>
          upstreamOf(wf, nodeId)
            .map((id) => {
              const rec = recordOf(id);
              const n = wf.nodes.find((x) => x.id === id);
              if (!n || n.type.startsWith("core.")) return undefined;
              return { nodeId: id, nodeType: n.type, ...(n.label ? { nodeLabel: n.label } : {}), ...(rec?.params ? { params: rec.params } : {}) };
            })
            .filter((x): x is NonNullable<typeof x> => !!x);
        for (const nr of Object.values(run.nodes)) {
          if (nr.status !== "success" || nr.cached || !nr.outputs) continue;
          const node = wf.nodes.find((n) => n.id === nr.nodeId);
          // core.* nodes (File, Constant, Output…) only pass files along; they aren't results.
          // Older records don't carry the type; a deleted File node is recognised by its shape.
          const type =
            nr.nodeType ??
            node?.type ??
            (Object.keys(nr.params ?? {}).join() === "path" && Object.keys(nr.outputs).join() === "file" ? "core.file" : undefined);
          if (type?.startsWith("core.") && type !== "core.map" && type !== "core.subflow") continue;
          for (const { ref, port } of fileRefsIn(nr.outputs)) {
            if (starred && !starred.has(ref.path)) continue;
            if (opts.mime && !ref.mime.startsWith(opts.mime)) continue;
            if (!byPath.has(ref.path) && !fs.existsSync(ref.path)) continue;
            const a: Artifact = {
              path: ref.path,
              size: ref.size,
              mime: ref.mime,
              runId: run.id,
              runStartedAt: run.startedAt,
              runStatus: run.status,
              ...(run.single ? { single: run.single } : {}),
              ...(run.rerunOf ? { rerunOf: run.rerunOf } : {}),
              nodeId: nr.nodeId,
              nodeType: type,
              ...(node?.label ? { nodeLabel: node.label } : {}),
              port,
              createdAt: nr.finishedAt ?? run.startedAt,
              ...(nr.params ? { params: nr.params } : {}),
              lineage: lineageOf(nr.nodeId),
              starred: false,
              note: "",
            };
            const cur = byPath.get(ref.path);
            if (!cur || score(a) > score(cur)) byPath.set(ref.path, a);
          }
        }
        before = run.startedAt;
        if (byPath.size >= limit) {
          nextBefore = run.startedAt;
          break scan;
        }
      }
      if (runs.length < 50) break;
    }

    // Filter by node only after attribution, so a pass-through copy never stands in for its producer.
    const items = [...byPath.values()]
      .filter((a) => !opts.nodeId || a.nodeId === opts.nodeId)
      .sort((x, y) => y.createdAt - x.createdAt);
    const marks = this.store.getMarks(items.map((a) => a.path));
    for (const a of items) Object.assign(a, marks.get(a.path) ?? {});
    return { items: this.maskSecrets(items), ...(nextBefore ? { nextBefore } : {}) };
  }

  /** Generated files across all workflows, newest first (for the canvas asset panel). */
  listAllArtifacts(opts: { limit?: number; starred?: boolean; mime?: string } = {}): Artifact[] {
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 300);
    // A subflow/map child's file also shows up in its parent workflow: keep the producing entry.
    const byPath = new Map<string, Artifact>();
    for (const w of this.store.listWorkflows()) {
      for (const a of this.listArtifacts(w.id, { ...opts, limit }).items) {
        const cur = byPath.get(a.path);
        if (!cur || (cur.nodeType?.startsWith("core.") && !a.nodeType?.startsWith("core."))) byPath.set(a.path, a);
      }
    }
    return [...byPath.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  get uploadsDir() {
    return path.join(this.config.home, "uploads");
  }

  /** Save an uploaded file under <home>/uploads and return it as a FileRef. */
  saveUpload(name: string, data: Uint8Array): FileRef {
    const safe = path.basename(name).replace(/[^\w.\-\u4e00-\u9fff ]+/g, "_").slice(-120) || "upload";
    const dir = path.join(this.uploadsDir, `${Date.now()}-${randomUUID().slice(0, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safe);
    fs.writeFileSync(file, data);
    return toFileRef(file);
  }

  /** Uploaded files, newest first. */
  listUploads(limit = 100): (FileRef & { name: string; createdAt: number })[] {
    if (!fs.existsSync(this.uploadsDir)) return [];
    return fs
      .readdirSync(this.uploadsDir)
      .sort()
      .reverse()
      .slice(0, limit)
      .flatMap((d) => {
        const dir = path.join(this.uploadsDir, d);
        if (!fs.statSync(dir).isDirectory()) return [];
        return fs.readdirSync(dir).map((f) => ({ ...toFileRef(path.join(dir, f)), name: f, createdAt: fs.statSync(dir).mtimeMs }));
      });
  }

  /** Star and/or annotate a produced file (only files under the runs directory). */
  markArtifact(filePath: string, mark: { starred?: boolean; note?: string }) {
    const runsDir = path.resolve(this.config.home, "runs");
    const abs = path.resolve(filePath);
    if (!abs.startsWith(runsDir + path.sep)) throw new NfError("INVALID_ARGUMENT", "not a run output file");
    return this.store.setMark(abs, { ...mark, ...(mark.note !== undefined ? { note: mark.note.slice(0, 2000) } : {}) });
  }

  listRuns(workflowId?: string, limit?: number) {
    return this.store.listRuns(workflowId, limit);
  }

  cancelRun(id: string): boolean {
    return this.engine.cancel(id);
  }

  close() {
    clearTimeout(this.reloadTimer);
    for (const w of this.watchers) w.close();
    this.store.close();
  }
}

/** Every FileRef inside a value, with a readable path like "files[2]" or "results[0].gif". */
function fileRefsIn(value: unknown, at = ""): { ref: FileRef; port: string }[] {
  if (isFileRef(value)) return [{ ref: value, port: at }];
  if (Array.isArray(value)) return value.flatMap((v, i) => fileRefsIn(v, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => fileRefsIn(v, at ? `${at}.${k}` : k));
  }
  return [];
}

/** Ancestors of a node through the workflow's edges, nearest first. */
function upstreamOf(wf: Workflow, nodeId: string): string[] {
  const out: string[] = [];
  let frontier = [nodeId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of wf.edges) {
        if (e.to.node === id && !out.includes(e.from.node) && e.from.node !== nodeId) {
          out.push(e.from.node);
          next.push(e.from.node);
        }
      }
    }
    frontier = next;
  }
  return out;
}
