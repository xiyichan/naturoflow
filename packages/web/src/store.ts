import { create } from "zustand";
import { freshNodeId } from "./ids.ts";
import { portCompatible } from "./ports.ts";
import {
  type NodePreview,
  api,
  ApiError,
  type NodeRun,
  type NodeTypeDef,
  type NodeTypeSummary,
  type PatchOp,
  type Run,
  type ServerEvent,
  type ValidationIssue,
  type Workflow,
  type WorkflowSummary,
} from "./api.ts";

export interface LightboxItem {
  path: string;
  mime: string;
  /** Shown under the image, e.g. the prompt. */
  title?: string;
  sub?: string;
}

export type EditorTarget = { mode: "new" } | { mode: "edit"; id: string } | null;

interface State {
  auth: "checking" | "ok" | "needed";
  connected: boolean;
  nodeTypes: Record<string, NodeTypeSummary>;
  defs: Record<string, NodeTypeDef>;
  workflows: WorkflowSummary[];
  workflow: Workflow | null;
  issues: ValidationIssue[];
  selected: string | null;
  run: Run | null;
  runs: Omit<Run, "nodes">[];
  notice: { kind: "info" | "error"; text: string } | null;
  editor: EditorTarget;
  logOpen: boolean;
  /** Bumped whenever saved credentials change, so pickers refetch. */
  credVersion: number;
  lightbox: { items: LightboxItem[]; index: number } | null;
  openLightbox(items: LightboxItem[], index?: number): void;
  closeLightbox(): void;
  stepLightbox(delta: number): void;
  view: "canvas" | "gallery";
  setView(v: "canvas" | "gallery"): void;
  /** Recent results per node of the open workflow, for previews on node cards. */
  previews: Record<string, NodePreview[]>;
  loadPreviews(): Promise<void>;
  /** Use this node's result from that run instead of executing it (null to stop). */
  pinResult(nodeId: string, runId: string | null): Promise<void>;
  /** Bumped when a run of the open workflow finishes, so the gallery refetches. */
  artifactsVersion: number;
  /** Latest single-node run per node of the open workflow (kept apart from the canvas run). */
  singleRuns: Record<string, Run>;
  /**
   * Add File nodes for the given files. With `target`, place them left of that node and connect
   * each to one of its free inputs that accepts a file.
   */
  addFileNodes(
    files: { path: string; name?: string }[],
    opts: { position?: { x: number; y: number }; target?: string },
  ): Promise<void>;
  runNode(
    nodeId: string,
    opts?: { fromRunId?: string; inputs?: Record<string, unknown>; params?: "current" | "history"; useCache?: boolean },
  ): Promise<boolean>;

  init(): Promise<void>;
  loadNodeTypes(): Promise<void>;
  loadDef(id: string): Promise<NodeTypeDef>;
  openWorkflow(id: string): Promise<void>;
  createWorkflow(name: string): Promise<void>;
  deleteWorkflow(id: string): Promise<void>;
  patch(ops: PatchOp[]): Promise<boolean>;
  layout(): Promise<void>;
  startRun(inputs: Record<string, unknown>, useCache?: boolean): Promise<void>;
  rerunFrom(nodeId: string): Promise<void>;
  cancelRun(): Promise<void>;
  showRun(id: string): Promise<void>;
  select(id: string | null): void;
  notify(kind: "info" | "error", text: string): void;
  setEditor(t: EditorTarget): void;
  setLogOpen(open: boolean): void;
  handleEvent(e: ServerEvent): void;
}

const LAST_WF = "naturoflow.lastWorkflow";
const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export const useStore = create<State>((set, get) => ({
  auth: "checking",
  connected: false,
  nodeTypes: {},
  defs: {},
  workflows: [],
  workflow: null,
  issues: [],
  selected: null,
  run: null,
  runs: [],
  notice: null,
  editor: null,
  logOpen: false,
  credVersion: 0,
  singleRuns: {},
  view: "canvas",
  lightbox: null,
  openLightbox(items, index = 0) {
    if (items.length) set({ lightbox: { items, index: Math.max(0, Math.min(index, items.length - 1)) } });
  },
  closeLightbox() {
    set({ lightbox: null });
  },
  stepLightbox(delta) {
    const lb = get().lightbox;
    if (lb && lb.items.length > 1) set({ lightbox: { ...lb, index: (lb.index + delta + lb.items.length) % lb.items.length } });
  },
  artifactsVersion: 0,
  previews: {},
  async loadPreviews() {
    const id = get().workflow?.id;
    if (!id) return;
    const previews = await api.previews(id).catch(() => ({}));
    if (get().workflow?.id === id) set({ previews });
  },
  async pinResult(nodeId, runId) {
    if (await get().patch([{ op: "update_node", id: nodeId, pin: runId ? { runId } : null }])) {
      get().notify("info", runId ? `${nodeId} 已选用这次的结果，运行时不再重新执行它` : `${nodeId} 已取消选用，运行时会正常执行`);
    }
  },
  setView(view) {
    set({ view });
  },

  async init() {
    try {
      const [types, workflows] = await Promise.all([api.nodeTypes(), api.workflows()]);
      set({ auth: "ok", nodeTypes: Object.fromEntries(types.map((t) => [t.id, t])), workflows });
      const last = storage.get(LAST_WF);
      const first = workflows.find((w) => w.id === last) ?? workflows[0];
      if (first) await get().openWorkflow(first.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) set({ auth: "needed" });
      else get().notify("error", `无法连接服务：${message(e)}`);
    }
  },

  async loadNodeTypes() {
    const types = await api.nodeTypes();
    set({ nodeTypes: Object.fromEntries(types.map((t) => [t.id, t])), defs: {} });
  },

  async loadDef(id) {
    const cached = get().defs[id];
    if (cached) return cached;
    const def = await api.nodeType(id);
    set((s) => ({ defs: { ...s.defs, [id]: def } }));
    return def;
  },

  async openWorkflow(id) {
    const [workflow, issues, runs] = await Promise.all([api.workflow(id), api.validate(id), api.runs(id)]);
    storage.set(LAST_WF, id);
    set({ workflow, issues, runs, selected: null, run: null, singleRuns: {}, previews: {} });
    get().loadPreviews();
    if (runs[0]) await get().showRun(runs[0].id);
  },

  async createWorkflow(name) {
    const wf = await api.createWorkflow(name);
    set({ workflows: await api.workflows() });
    await get().openWorkflow(wf.id);
  },

  async deleteWorkflow(id) {
    await api.deleteWorkflow(id);
    const workflows = await api.workflows();
    set({ workflows, workflow: get().workflow?.id === id ? null : get().workflow });
    if (!get().workflow && workflows[0]) await get().openWorkflow(workflows[0].id);
  },

  async patch(ops) {
    const wf = get().workflow;
    if (!wf) return false;
    try {
      const { workflow, issues } = await api.patch(wf.id, ops, wf.version);
      // An SSE event may already have delivered a newer version.
      if ((get().workflow?.version ?? 0) <= workflow.version) set({ workflow, issues });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        get().notify("info", "工作流刚被别处修改过（可能是 AI），已刷新到最新版本，请重试");
        await get().openWorkflow(wf.id);
      } else get().notify("error", message(e));
      return false;
    }
  },

  async layout() {
    const wf = get().workflow;
    if (wf) set({ workflow: await api.layout(wf.id) });
  },

  async rerunFrom(nodeId) {
    const run = get().run;
    if (!run) return;
    try {
      const { id } = await api.rerun(run.id, nodeId);
      if (get().run?.id !== id) set({ run: await api.getRun(id) });
      set({ logOpen: true });
    } catch (e) {
      get().notify("error", message(e));
    }
  },

  async addFileNodes(files, opts) {
    const wf = get().workflow;
    if (!wf || !files.length) return;
    const taken = new Set(wf.nodes.map((n) => n.id));
    const target = opts.target ? wf.nodes.find((n) => n.id === opts.target) : undefined;
    // Free inputs of the target that can take a file, in declared order.
    const free = target
      ? Object.entries(get().nodeTypes[target.type]?.inputs ?? {})
          .filter(([port, p]) => portCompatible("file", p.type) && !wf.edges.some((e) => e.to.node === target.id && e.to.port === port))
          .map(([port]) => port)
      : [];
    const origin = target ? { x: target.position.x - 280, y: target.position.y } : (opts.position ?? { x: 0, y: 0 });
    const ops: PatchOp[] = [];
    const added: string[] = [];
    files.forEach((f, i) => {
      const id = freshNodeId("file", taken);
      taken.add(id);
      added.push(id);
      const name = f.name ?? f.path.split("/").pop() ?? "file";
      ops.push({ op: "add_node", node: { id, type: "core.file", label: name.slice(0, 40), params: { path: f.path }, position: { x: origin.x, y: origin.y + i * 150 } } });
      const port = free[i];
      if (target && port) ops.push({ op: "connect", edge: { from: { node: id, port: "file" }, to: { node: target.id, port } } });
    });
    if (await get().patch(ops)) {
      get().select(added[added.length - 1]);
      if (target) {
        const wired = Math.min(free.length, files.length);
        get().notify(
          wired ? "info" : "error",
          wired ? `已接到 ${target.label || target.id} 的 ${free.slice(0, wired).join("、")}` : `${target.label || target.id} 没有空着的文件输入，素材节点已放在它旁边`,
        );
      }
    }
  },

  async runNode(nodeId, opts = {}) {
    const wf = get().workflow;
    if (!wf) return false;
    try {
      const { id } = await api.runNode(wf.id, nodeId, opts);
      if (get().singleRuns[nodeId]?.id !== id) {
        const run = await api.getRun(id);
        set((s) => ({ singleRuns: { ...s.singleRuns, [nodeId]: run } }));
      }
      return true;
    } catch (e) {
      get().notify("error", message(e));
      return false;
    }
  },

  async startRun(inputs, useCache = true) {
    const wf = get().workflow;
    if (!wf) return;
    try {
      const { id } = await api.run(wf.id, inputs, useCache);
      // run.started usually arrives over SSE first; fetch in case it didn't.
      if (get().run?.id !== id) set({ run: await api.getRun(id) });
      set({ logOpen: true });
    } catch (e) {
      const issues = e instanceof ApiError ? e.issues : undefined;
      if (issues) set({ issues });
      get().notify("error", issues ? "工作流还有问题，修好后再运行" : message(e));
    }
  },

  async cancelRun() {
    const run = get().run;
    if (run) await api.cancelRun(run.id);
  },

  async showRun(id) {
    set({ run: await api.getRun(id) });
  },

  select(id) {
    set({ selected: id });
  },

  notify(kind, text) {
    set({ notice: { kind, text } });
    const current = get().notice;
    setTimeout(() => {
      if (get().notice === current) set({ notice: null });
    }, kind === "error" ? 8000 : 4000);
  },

  setEditor(editor) {
    set({ editor });
  },

  setLogOpen(logOpen) {
    set({ logOpen });
  },

  handleEvent(e) {
    const s = get();
    const wfId = s.workflow?.id;
    switch (e.type) {
      case "workflow.changed": {
        if (e.workflow.id === wfId && e.workflow.version > (s.workflow?.version ?? 0)) {
          set({ workflow: e.workflow });
          api.validate(e.workflow.id).then((issues) => {
            if (get().workflow?.id === e.workflow.id) set({ issues });
          });
        }
        if (!s.workflows.some((w) => w.id === e.workflow.id && w.name === e.workflow.name)) {
          api.workflows().then((workflows) => set({ workflows }));
        }
        break;
      }
      case "workflow.deleted":
        set({ workflows: s.workflows.filter((w) => w.id !== e.id) });
        if (e.id === wfId) {
          set({ workflow: null, run: null });
          s.notify("info", "当前工作流已被删除");
        }
        break;
      case "nodeType.changed":
        s.loadNodeTypes();
        break;
      case "credentials.changed":
        set({ credVersion: s.credVersion + 1 });
        // Validation issues depend on which credentials exist.
        if (wfId) api.validate(wfId).then((issues) => get().workflow?.id === wfId && set({ issues }));
        break;
      case "run.started":
        // A single-node run is shown on that node, not as the canvas run.
        if (e.run.single) {
          if (e.run.workflowId === wfId) set({ singleRuns: { ...s.singleRuns, [e.run.single.nodeId]: e.run } });
          break;
        }
        // Child runs of subflow/map nodes belong to their parent; don't take over the canvas.
        if (e.run.workflowId === wfId && !e.run.parentRunId) set({ run: e.run, runs: [e.run, ...s.runs].slice(0, 10) });
        break;
      case "node.started":
      case "node.log":
      case "node.finished": {
        // Show a node's new result on its card as soon as it finishes, not when the whole run does.
        if (e.type === "node.finished" && e.node.status === "success" && e.node.outputs && e.node.cached !== "reuse" && e.node.cached !== "pin") {
          const isOurs = (s.run?.id === e.runId && s.run.workflowId === wfId) || Object.values(s.singleRuns).some((r) => r.id === e.runId);
          if (isOurs) {
            const list = s.previews[e.node.nodeId] ?? [];
            if (!list.some((p) => p.runId === e.runId)) {
              const entry = {
                runId: e.runId,
                at: e.node.finishedAt ?? Date.now(),
                ...(e.node.cached ? { cached: e.node.cached } : {}),
                outputs: e.node.outputs,
                ...(e.node.inactive?.length ? { inactive: e.node.inactive } : {}),
              };
              set({ previews: { ...get().previews, [e.node.nodeId]: [entry, ...list].slice(0, 20) } });
            }
          }
        }
        const single = Object.values(s.singleRuns).find((r) => r.id === e.runId);
        const run = single ?? s.run;
        if (!run || run.id !== e.runId) return;
        const prev: NodeRun = run.nodes[e.type === "node.finished" ? e.node.nodeId : e.nodeId];
        let next: NodeRun;
        if (e.type === "node.started") next = { ...prev, status: "running", startedAt: Date.now() };
        else if (e.type === "node.log") next = { ...prev, logs: [...prev.logs, e.line].slice(-2000) };
        else next = { ...e.node, logs: e.node.logs.length ? e.node.logs : prev.logs };
        const updated = { ...run, nodes: { ...run.nodes, [next.nodeId]: next } };
        if (single) set({ singleRuns: { ...s.singleRuns, [single.single!.nodeId]: updated } });
        else set({ run: updated });
        break;
      }
      case "run.finished":
        if (e.run.workflowId === wfId) {
          set({ artifactsVersion: get().artifactsVersion + 1 });
          get().loadPreviews();
        }
        if (e.run.single) {
          if (e.run.workflowId === wfId) {
            set({ singleRuns: { ...s.singleRuns, [e.run.single.nodeId]: e.run } });
            const n = e.run.nodes[e.run.single.nodeId];
            s.notify(n?.status === "success" ? "info" : "error", n?.status === "success" ? `${e.run.single.nodeId} 单独运行完成` : `${e.run.single.nodeId} 单独运行失败${n?.error ? `：${n.error}` : ""}`);
          }
          break;
        }
        if (e.run.workflowId === wfId && !e.run.parentRunId) {
          set({ run: s.run?.id === e.run.id || !s.run ? e.run : s.run, runs: s.runs.map((r) => (r.id === e.run.id ? e.run : r)) });
          if (s.run?.id === e.run.id) {
            s.notify(e.run.status === "success" ? "info" : "error", e.run.status === "success" ? "运行完成" : `运行${e.run.status === "cancelled" ? "已取消" : "失败"}${e.run.error ? `：${e.run.error}` : ""}`);
          }
        }
        break;
    }
  },
}));
