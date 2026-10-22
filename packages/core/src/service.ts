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
import { SecretBox } from "./secrets.ts";
import { Store } from "./store.ts";
import {
  NfError,
  ToolPublish,
  credentialTypeOf,
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
  }),
  z.object({ op: z.literal("remove_node"), id: z.string() }),
  z.object({ op: z.literal("connect"), edge: WorkflowEdge }),
  z.object({ op: z.literal("disconnect"), edge: WorkflowEdge }),
  z.object({ op: z.literal("rename"), name: z.string(), description: z.string().optional() }),
  /** Publish as an MCP tool (or pass `tool: null` to unpublish). */
  z.object({ op: z.literal("set_tool"), tool: ToolPublish.nullable() }),
]);
export type PatchOp = z.input<typeof PatchOp>;

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

  private start(wf: Workflow, inputs: Record<string, unknown>, ro: RunOptions, wait = true): Promise<RunRecord> {
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
