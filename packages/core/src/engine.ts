import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execute, INACTIVE } from "./executors/index.ts";
import { isFileRef, toFileRef } from "./files.ts";
import { portCompatible } from "./ports.ts";
import { clip, preview } from "./logfmt.ts";
import { render } from "./template.ts";
import type { NodeRegistry } from "./registry.ts";
import {
  credentialTypeOf,
  parseDuration,
  type NodeRunRecord,
  type NodeTrace,
  type PortDef,
  type RunRecord,
  type Workflow,
  type WorkflowNode,
} from "./types.ts";

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
}

export type EngineEvent =
  | { type: "run.started"; run: RunRecord }
  | { type: "node.started"; runId: string; nodeId: string }
  | { type: "node.log"; runId: string; nodeId: string; line: string }
  | { type: "node.finished"; runId: string; node: NodeRunRecord }
  | { type: "run.finished"; run: RunRecord };

export interface EngineOptions {
  runsDir: string;
  allowedBins: string[];
  concurrency?: number;
  defaultTimeoutMs?: number;
  /** Resolves workflow ids for subflow/map nodes. */
  loadWorkflow?: (id: string) => Workflow | undefined;
  cache?: NodeCache;
  /** Decrypted credential values by id; `secrets` are masked in logs. */
  getCredential?: (id: string) => { type: string; data: Record<string, string>; secrets: string[] } | undefined;
}

export function validateWorkflow(wf: Workflow, registry: NodeRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  if (nodes.size !== wf.nodes.length) issues.push({ code: "DUPLICATE_NODE_ID", message: "node ids must be unique" });

  for (const n of wf.nodes) {
    const t = registry.get(n.type);
    if (!t) {
      issues.push({ code: "NODE_TYPE_NOT_FOUND", message: `unknown node type "${n.type}"`, nodeId: n.id });
      continue;
    }
    const props = (t.def.params.properties ?? {}) as Record<string, { default?: unknown }>;
    for (const req of (t.def.params.required ?? []) as string[]) {
      if (n.params[req] === undefined && props[req]?.default === undefined) {
        issues.push({ code: "MISSING_PARAM", message: `param "${req}" is required`, nodeId: n.id, path: `params.${req}` });
      }
    }
    for (const [port, def] of Object.entries(t.def.inputs)) {
      const incoming = wf.edges.filter((e) => e.to.node === n.id && e.to.port === port);
      if (def.required && incoming.length === 0) {
        issues.push({ code: "UNCONNECTED_INPUT", message: `input "${port}" is not connected`, nodeId: n.id, path: `inputs.${port}` });
      }
      if (incoming.length > 1) {
        issues.push({ code: "MULTIPLE_EDGES", message: `input "${port}" has ${incoming.length} incoming edges`, nodeId: n.id });
      }
    }
  }

  for (const [i, e] of wf.edges.entries()) {
    const from = nodes.get(e.from.node);
    const to = nodes.get(e.to.node);
    const where = `edges[${i}]`;
    if (!from || !to) {
      issues.push({ code: "EDGE_NODE_NOT_FOUND", message: `edge references missing node`, path: where });
      continue;
    }
    const fromPort = registry.get(from.type)?.def.outputs[e.from.port];
    const toPort = registry.get(to.type)?.def.inputs[e.to.port];
    if (registry.get(from.type) && !fromPort) {
      issues.push({ code: "PORT_NOT_FOUND", message: `${from.id} has no output "${e.from.port}"`, path: where });
    }
    if (registry.get(to.type) && !toPort) {
      issues.push({ code: "PORT_NOT_FOUND", message: `${to.id} has no input "${e.to.port}"`, path: where });
    }
    if (fromPort && toPort && !portCompatible(fromPort.type, toPort.type)) {
      issues.push({
        code: "TYPE_MISMATCH",
        message: `${from.id}.${e.from.port} (${fromPort.type}) -> ${to.id}.${e.to.port} (${toPort.type})`,
        path: where,
      });
    }
  }

  if (topoOrder(wf) === null) issues.push({ code: "CYCLE", message: "workflow contains a cycle" });
  return issues;
}

export function topoOrder(wf: Workflow): string[] | null {
  const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
  for (const e of wf.edges) if (indeg.has(e.to.node)) indeg.set(e.to.node, indeg.get(e.to.node)! + 1);
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of wf.edges.filter((e) => e.from.node === id)) {
      const d = indeg.get(e.to.node)! - 1;
      indeg.set(e.to.node, d);
      if (d === 0) queue.push(e.to.node);
    }
  }
  return order.length === wf.nodes.length ? order : null;
}

/** Coerce a raw executor output into the declared port type. */
function coerce(value: unknown, port: PortDef): unknown {
  if (value === undefined) return undefined;
  if (port.type === "file") return toFileRef(value);
  if (port.type === "list<file>") return (value as unknown[]).map(toFileRef);
  if (port.type === "number") return Number(value);
  if (port.type === "boolean") return value === true || value === "true";
  if (port.type === "string") return typeof value === "string" ? value : JSON.stringify(value);
  return value;
}

function paramDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, { default?: unknown }>;
  return Object.fromEntries(Object.entries(props).filter(([, p]) => p.default !== undefined).map(([k, p]) => [k, p.default]));
}

/** JSON with sorted keys, so equal values always hash the same. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Files are identified by path + size + mtime, so a changed input file misses the cache. */
function fingerprint(v: unknown): unknown {
  if (isFileRef(v)) {
    const st = fs.statSync(v.path, { throwIfNoEntry: false });
    return { $file: v.path, size: st?.size, mtime: st?.mtimeMs };
  }
  if (Array.isArray(v)) return v.map(fingerprint);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fingerprint(x)]));
  return v;
}

/** Cached/reused outputs are only usable if every file they reference is still there, unchanged in size. */
function filesIntact(v: unknown): boolean {
  if (isFileRef(v)) return fs.statSync(v.path, { throwIfNoEntry: false })?.size === v.size;
  if (Array.isArray(v)) return v.every(filesIntact);
  if (v && typeof v === "object") return Object.values(v).every(filesIntact);
  return true;
}

export interface NodeCache {
  get(key: string): { outputs: Record<string, unknown>; inactive?: string[] } | undefined;
  set(key: string, value: { outputs: Record<string, unknown>; inactive?: string[] }): void;
}

export interface RunOptions {
  /** Called synchronously once the run record exists (to learn the run id early). */
  onStart?: (run: RunRecord) => void;
  /** Use the node cache for cacheable nodes (default true). */
  useCache?: boolean;
  /** Outputs to reuse instead of executing, keyed by node id (rerun-from-node). */
  reuse?: Record<string, NodeRunRecord>;
  /** Results the user chose for pinned nodes, keyed by node id; these nodes don't execute. */
  pins?: Record<string, NodeRunRecord>;
  rerunOf?: RunRecord["rerunOf"];
  parentRunId?: string;
  /** Abort together with a parent run. */
  signal?: AbortSignal;
  /** Subflow nesting depth, to stop runaway recursion. */
  depth?: number;
  /**
   * Run just this node with the given inputs (no upstream/downstream). `params`, when given,
   * replaces the node's saved params for this run.
   */
  single?: { nodeId: string; inputs: Record<string, unknown>; params?: Record<string, unknown>; fromRunId?: string };
}

const MAX_DEPTH = 8;
const UPSTREAM_FAILED = "upstream did not succeed";

export class Engine extends EventEmitter {
  private active = new Map<string, AbortController>();

  constructor(
    private registry: NodeRegistry,
    private opts: EngineOptions,
  ) {
    super();
  }

  cancel(runId: string): boolean {
    const ac = this.active.get(runId);
    ac?.abort();
    return !!ac;
  }

  /** Runs a workflow; resolves when it finishes. */
  async run(wf: Workflow, inputs: Record<string, unknown> = {}, ro: RunOptions = {}): Promise<RunRecord> {
    if (ro.single) {
      const node = wf.nodes.find((n) => n.id === ro.single!.nodeId);
      if (!node) throw new Error(`node "${ro.single.nodeId}" not in workflow`);
      wf = { ...wf, nodes: [{ ...node, params: ro.single.params ?? node.params }], edges: [] };
    }
    // A single-node run gets its inputs directly, so unconnected inputs are expected.
    const issues = validateWorkflow(wf, this.registry).filter((i) => !(ro.single && i.code === "UNCONNECTED_INPUT"));
    if (issues.length) {
      const err = new Error(`workflow is invalid:\n${issues.map((i) => `- ${i.nodeId ?? i.path ?? ""} ${i.message}`).join("\n")}`);
      (err as Error & { issues: ValidationIssue[] }).issues = issues;
      throw err;
    }
    if ((ro.depth ?? 0) > MAX_DEPTH) throw new Error(`subflows nested deeper than ${MAX_DEPTH} levels (recursive workflow?)`);

    const run: RunRecord = {
      id: randomUUID(),
      workflowId: wf.id,
      status: "running",
      inputs,
      startedAt: Date.now(),
      nodes: {},
      ...(ro.parentRunId ? { parentRunId: ro.parentRunId } : {}),
      ...(ro.rerunOf ? { rerunOf: ro.rerunOf } : {}),
      ...(ro.single ? { single: { nodeId: ro.single.nodeId, ...(ro.single.fromRunId ? { fromRunId: ro.single.fromRunId } : {}) } } : {}),
    };
    for (const n of wf.nodes) run.nodes[n.id] = { runId: run.id, nodeId: n.id, nodeType: n.type, status: "pending", logs: [], attempts: 0 };
    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    ro.signal?.addEventListener("abort", onParentAbort, { once: true });
    this.active.set(run.id, ac);
    ro.onStart?.(run);
    this.emit("event", { type: "run.started", run } satisfies EngineEvent);

    const deps = new Map(wf.nodes.map((n) => [n.id, wf.edges.filter((e) => e.to.node === n.id)]));
    const concurrency = this.opts.concurrency ?? 4;
    const running = new Set<Promise<void>>();

    /** What a pending node should do now, given its upstream nodes' state. */
    const decide = (n: WorkflowNode): "wait" | "run" | "skip-failed" | "skip-branch" => {
      const def = this.registry.require(n.type).def;
      const edges = deps.get(n.id)!;
      let requiredMissing = false;
      let firedCount = 0;
      for (const e of edges) {
        const up = run.nodes[e.from.node];
        if (up.status === "pending" || up.status === "running") return "wait";
        if (up.status === "failed" || up.status === "cancelled") return "skip-failed";
        if (up.status === "skipped" && up.error) return "skip-failed";
        // A skipped (untaken-branch) node fires none of its ports.
        const fired = up.status === "success" && !up.inactive?.includes(e.from.port);
        if (fired) firedCount++;
        else if (def.inputs[e.to.port]?.required !== false) requiredMissing = true;
      }
      // Skip when a required input didn't fire, or when nothing connected fired at all.
      // A merge node with optional inputs still runs if at least one branch reached it.
      return requiredMissing || (edges.length > 0 && firedCount === 0) ? "skip-branch" : "run";
    };

    while (true) {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const n of wf.nodes) {
          if (run.nodes[n.id].status !== "pending") continue;
          if (ac.signal.aborted) {
            this.finishNode(run, n.id, "cancelled");
            continue;
          }
          const d = decide(n);
          if (d === "skip-failed") this.finishNode(run, n.id, "skipped", undefined, UPSTREAM_FAILED);
          else if (d === "skip-branch") this.finishNode(run, n.id, "skipped", undefined, undefined, { note: "branch not taken" });
          else if (d === "run" && running.size < concurrency) {
            run.nodes[n.id].status = "running";
            const p: Promise<void> = this.runNode(run, n, deps.get(n.id)!, ac.signal, ro).finally(() => running.delete(p));
            running.add(p);
          } else continue;
          progressed = true;
        }
      }
      if (running.size === 0) break;
      await Promise.race(running);
    }

    this.active.delete(run.id);
    ro.signal?.removeEventListener("abort", onParentAbort);
    const statuses = Object.values(run.nodes).map((n) => n.status);
    run.status = ac.signal.aborted ? "cancelled" : statuses.includes("failed") ? "failed" : "success";
    run.error = Object.values(run.nodes).find((n) => n.status === "failed")?.error;
    run.outputs = Object.fromEntries(
      wf.nodes
        .filter((n) => n.type === "core.output" && run.nodes[n.id].status === "success")
        .map((n) => [String(n.params.key ?? n.id), run.nodes[n.id].outputs?.value]),
    );
    run.finishedAt = Date.now();
    this.emit("event", { type: "run.finished", run } satisfies EngineEvent);
    return run;
  }

  private async runNode(
    run: RunRecord,
    node: WorkflowNode,
    incoming: Workflow["edges"],
    runSignal: AbortSignal,
    ro: RunOptions,
  ): Promise<void> {
    const { def, source } = this.registry.require(node.type);
    const nr = run.nodes[node.id];
    nr.startedAt = Date.now();
    this.emit("event", { type: "node.started", runId: run.id, nodeId: node.id } satisfies EngineEvent);

    // Inputs from ports that did not fire are left undefined (only optional ports get here).
    const inputs = ro.single?.nodeId === node.id ? ro.single.inputs : Object.fromEntries(
      incoming
        .filter((e) => !run.nodes[e.from.node].inactive?.includes(e.from.port))
        .map((e) => [e.to.port, run.nodes[e.from.node].outputs?.[e.from.port]]),
    );
    // Param values may be templates over this node's inputs and the workflow's run inputs,
    // e.g. duration: "{{workflow.inputs.seconds}}".
    const params = render(
      { ...paramDefaults(def.params), ...node.params },
      { inputs, workflow: { inputs: run.inputs } },
    ) as Record<string, unknown>;
    nr.inputs = inputs;

    // Resolve the node's credential; its secret values never reach logs or errors.
    let credential: Record<string, string> | undefined;
    let secrets: string[] = [];
    const credType = credentialTypeOf(def);
    if (credType) {
      const c = node.credential ? this.opts.getCredential?.(node.credential) : undefined;
      if (node.credential && !c) return this.failEarly(run, node.id, `credential "${node.credential}" not found`);
      if (c && c.type !== credType) return this.failEarly(run, node.id, `credential is a ${c.type} credential, expected ${credType}`);
      if (!c && def.credentials!.required) return this.failEarly(run, node.id, `no credential selected (needs ${def.credentials!.name ?? credType})`);
      credential = c?.data;
      secrets = (c?.secrets ?? []).filter((v) => v.length >= 4);
    }
    const mask = (text: string) => secrets.reduce((t, v) => t.split(v).join("****"), text);

    const log = (raw: string) => {
      const line = mask(raw);
      nr.logs.push(line);
      if (nr.logs.length > 2000) nr.logs.splice(0, nr.logs.length - 2000);
      this.emit("event", { type: "node.log", runId: run.id, nodeId: node.id, line } satisfies EngineEvent);
    };
    // Stored for the node's history: masked, with long strings clipped.
    const keep = <T>(v: T): T => JSON.parse(mask(JSON.stringify(clip(v)))) as T;
    nr.params = JSON.parse(mask(JSON.stringify(params)));
    const trace = (t: NodeTrace) => {
      nr.trace = { ...nr.trace, ...keep(t) };
    };
    // Every successful node ends its log with what it produced (masked like any other line).
    const logOutputs = (outputs?: Record<string, unknown>) => {
      if (outputs && Object.keys(outputs).length) log(`outputs: ${preview(outputs)}`);
    };

    // 0. A result the user pinned for this node.
    const pinned = ro.single?.nodeId === node.id ? undefined : ro.pins?.[node.id];
    if (pinned) {
      if (pinned.status === "success" && filesIntact(pinned.outputs)) {
        log(`using the chosen result from run ${pinned.runId}`);
        logOutputs(pinned.outputs);
        this.finishNode(run, node.id, "success", pinned.outputs, undefined, { inactive: pinned.inactive, cached: "pin" });
        return;
      }
      log(`the chosen result from run ${pinned.runId} is no longer available (files deleted?); running the node instead`);
    }

    // 1. Reuse outputs from an earlier run (rerun-from-node).
    const prev = ro.reuse?.[node.id];
    if (prev?.status === "success" && filesIntact(prev.outputs)) {
      log(`reused outputs from run ${prev.runId}`);
      logOutputs(prev.outputs);
      this.finishNode(run, node.id, "success", prev.outputs, undefined, { inactive: prev.inactive, cached: "reuse" });
      return;
    }

    // 2. The input-hash cache.
    const cacheable = (node.cache ?? def.cache) && ro.useCache !== false && !!this.opts.cache;
    let cacheKey: string | undefined;
    if (cacheable) {
      cacheKey = createHash("sha256").update(stableStringify({ def, params, inputs: fingerprint(inputs) })).digest("hex");
      const hit = this.opts.cache!.get(cacheKey);
      if (hit && filesIntact(hit.outputs)) {
        log(`cache hit ${cacheKey.slice(0, 12)}`);
        logOutputs(hit.outputs);
        this.finishNode(run, node.id, "success", hit.outputs, undefined, { inactive: hit.inactive, cached: "cache" });
        return;
      }
    }

    const outDir = path.join(this.opts.runsDir, run.id, node.id);
    fs.mkdirSync(outDir, { recursive: true });
    const timeoutMs = parseDuration(def.timeout, this.opts.defaultTimeoutMs ?? 10 * 60_000);
    const maxAttempts = 1 + (def.retry?.max ?? 0);
    const backoff = parseDuration(def.retry?.backoff, 1000);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      nr.attempts = attempt;
      // Subflow/map nodes manage their own children, so they are not bound by this node's timeout.
      const nested = def.executor.kind === "subflow" || (def.executor.kind === "builtin" && ["subflow", "map"].includes(def.executor.name));
      const signal = nested ? runSignal : AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]);
      try {
        const raw = await execute(def.executor, {
          inputs,
          params,
          ctx: {
            runId: run.id,
            nodeId: node.id,
            outDir,
            signal,
            log,
            trace,
            def,
            defDir: source ? path.dirname(source) : undefined,
            config: { allowedBins: this.opts.allowedBins },
            runInputs: run.inputs,
            credential,
            runSubflow: (workflowId, childInputs) => {
              const child = this.opts.loadWorkflow?.(workflowId);
              if (!child) throw new Error(`workflow "${workflowId}" not found`);
              return this.run(child, childInputs, {
                parentRunId: run.id,
                signal,
                useCache: ro.useCache,
                depth: (ro.depth ?? 0) + 1,
              });
            },
          },
        });
        const outputs: Record<string, unknown> = {};
        const inactive: string[] = [];
        for (const [port, pdef] of Object.entries(def.outputs)) {
          if (raw[port] === INACTIVE) {
            inactive.push(port);
            continue;
          }
          if (raw[port] === undefined && pdef.required) throw new Error(`executor did not produce output "${port}"`);
          outputs[port] = coerce(raw[port], pdef);
        }
        if (cacheKey) this.opts.cache!.set(cacheKey, { outputs, inactive });
        logOutputs(outputs);
        this.finishNode(run, node.id, "success", outputs, undefined, inactive.length ? { inactive } : {});
        return;
      } catch (e) {
        lastErr =
          signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
            ? new Error(`timed out after ${timeoutMs}ms`)
            : e;
        log(`attempt ${attempt}/${maxAttempts} failed: ${(lastErr as Error).message}`);
        if (runSignal.aborted) break;
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoff * attempt));
      }
    }
    this.finishNode(run, node.id, runSignal.aborted ? "cancelled" : "failed", undefined, mask(String((lastErr as Error)?.message)));
  }

  private failEarly(run: RunRecord, nodeId: string, error: string) {
    this.finishNode(run, nodeId, "failed", undefined, error);
  }

  private finishNode(
    run: RunRecord,
    nodeId: string,
    status: NodeRunRecord["status"],
    outputs?: Record<string, unknown>,
    error?: string,
    extra: Pick<NodeRunRecord, "inactive" | "cached" | "note"> = {},
  ) {
    const nr = run.nodes[nodeId];
    Object.assign(nr, { status, outputs, error, finishedAt: Date.now() }, extra);
    if (!nr.inactive?.length) delete nr.inactive;
    this.emit("event", { type: "node.finished", runId: run.id, node: nr } satisfies EngineEvent);
  }
}
