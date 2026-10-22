import { useEffect, useRef, useState } from "react";
import {
  api,
  fileUrl,
  type NodeHistoryEntry,
  type NodeRun,
  type NodeTypeDef,
  type WorkflowInterface,
  type WorkflowNode,
} from "./api.ts";
import { CredentialPicker } from "./CredentialPicker.tsx";
import { ParamForm } from "./ParamForm.tsx";
import { typeColor, typeLabel } from "./ports.ts";
import { useStore } from "./store.ts";

const STATUS_TEXT: Record<string, string> = {
  pending: "等待中",
  running: "运行中",
  success: "成功",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};

export function Inspector() {
  const workflow = useStore((s) => s.workflow);
  const selected = useStore((s) => s.selected);
  const node = workflow?.nodes.find((n) => n.id === selected);
  return (
    <aside className="nf-insp" aria-label="检查器">
      {node ? <NodePanel key={node.id} node={node} /> : workflow ? <WorkflowPanel /> : null}
    </aside>
  );
}

function NodePanel({ node }: { node: WorkflowNode }) {
  const loadDef = useStore((s) => s.loadDef);
  const nodeTypeSummary = useStore((s) => s.nodeTypes[node.type]);
  const run = useStore((s) => s.run);
  const patch = useStore((s) => s.patch);
  const setEditor = useStore((s) => s.setEditor);
  const [def, setDef] = useState<NodeTypeDef | null>(null);
  const [tab, setTab] = useState<"params" | "run" | "history">("params");
  const runNode = useStore((s) => s.runNode);
  const singleRun = useStore((s) => s.singleRuns[node.id]);
  const nodeRun = run?.nodes[node.id];

  useEffect(() => {
    setDef(null);
    loadDef(node.type).then(setDef).catch(() => setDef(null));
  }, [node.type, nodeTypeSummary, loadDef]);

  // Local draft so typing is instant; flushed to the server after a short pause.
  const [draft, setDraft] = useState(node.params);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!dirty.current) setDraft(node.params);
  }, [node.params]);
  const flush = (params: Record<string, unknown>) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await patch([{ op: "update_node", id: node.id, params, replaceParams: true }]);
      dirty.current = false;
    }, 450);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  /** Save a pending param edit immediately (so a run uses what's on screen). */
  const flushNow = async () => {
    clearTimeout(timer.current);
    await patch([{ op: "update_node", id: node.id, params: draft, replaceParams: true }]);
    dirty.current = false;
  };

  const [label, setLabel] = useState(node.label ?? "");
  useEffect(() => setLabel(node.label ?? ""), [node.label]);

  return (
    <>
      <header className="nf-insp__head">
        <input
          className="nf-insp__title"
          value={label}
          placeholder={nodeTypeSummary?.name ?? node.type}
          aria-label="节点名称"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== (node.label ?? "") && patch([{ op: "update_node", id: node.id, label }])}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <p className="nf-insp__meta">
          <code>{node.id}</code> 是 <code>{node.type}</code>
          {nodeTypeSummary && nodeTypeSummary.executor !== "builtin" && (
            <button className="nf-link" onClick={() => setEditor({ mode: "edit", id: node.type })}>
              编辑类型
            </button>
          )}
        </p>
        {nodeTypeSummary?.description && <p className="nf-insp__desc">{nodeTypeSummary.description}</p>}
        <div className="nf-insp__actions">
          <button
            className="nf-btn"
            disabled={singleRun?.status === "running"}
            title="只执行这个节点，输入沿用它上一次收到的值；不会运行上下游"
            onClick={async () => {
              if (dirty.current) await flushNow();
              if (await runNode(node.id)) setTab("run");
            }}
          >
            {singleRun?.status === "running" ? "单独运行中…" : "单独运行"}
          </button>
        </div>
      </header>

      <div className="nf-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "params"} onClick={() => setTab("params")}>
          参数
        </button>
        <button role="tab" aria-selected={tab === "run"} onClick={() => setTab("run")}>
          运行结果
          {nodeRun && nodeRun.status !== "pending" && <span className="nf-dot" data-status={nodeRun.status} />}
        </button>
        <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
          历史
        </button>
      </div>

      <div className="nf-insp__body">
        {tab === "params" ? (
          !nodeTypeSummary ? (
            <p className="nf-warn">找不到节点类型 <code>{node.type}</code>。新建这个类型，或者删掉这个节点。</p>
          ) : def ? (
            <>
              {def.credentials && <CredentialPicker node={node} spec={def.credentials} typeId={def.id} />}
              <ParamForm
                schema={def.params}
                value={draft}
                onChange={(key, v) => {
                  const next = { ...draft };
                  if (v === undefined) delete next[key];
                  else next[key] = v;
                  dirty.current = true;
                  setDraft(next);
                  flush(next);
                }}
              />
              <Ports def={def} />
            </>
          ) : (
            <p className="nf-muted">加载中…</p>
          )
        ) : tab === "run" ? (
          <>
            <SingleRunBox node={node} def={def} beforeRun={async () => dirty.current && (await flushNow())} />
            <h4>工作流运行结果</h4>
            <RunDetail run={nodeRun} nodeId={node.id} />
          </>
        ) : (
          <NodeHistory nodeId={node.id} onRan={() => setTab("run")} />
        )}
      </div>
    </>
  );
}

function Ports({ def }: { def: NodeTypeDef }) {
  const rows = [
    ...Object.entries(def.inputs).map(([n, p]) => ({ dir: "输入", n, p })),
    ...Object.entries(def.outputs).map(([n, p]) => ({ dir: "输出", n, p })),
  ];
  if (!rows.length) return null;
  return (
    <table className="nf-ports">
      <caption>端口</caption>
      <tbody>
        {rows.map(({ dir, n, p }) => (
          <tr key={dir + n}>
            <td>{dir}</td>
            <td>
              <i className="nf-swatch" style={{ background: typeColor(p.type) }} />
              <code>{n}</code>
            </td>
            <td>
              {typeLabel(p.type)}
              {!p.required && dir === "输入" ? "，可选" : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunDetail({ run, nodeId, single }: { run?: NodeRun; nodeId: string; single?: boolean }) {
  const rerunFrom = useStore((s) => s.rerunFrom);
  const runStatus = useStore((s) => s.run?.status);
  const rerun = !single && runStatus && runStatus !== "running" && (
    <button className="nf-btn" onClick={() => rerunFrom(nodeId)} title="上游节点沿用这次运行的结果，只重新执行这个节点和它的下游">
      从这里重新运行
    </button>
  );
  if (!run || run.status === "pending") {
    return (
      <>
        <p className="nf-muted">这个节点在当前运行里还没有结果。</p>
        {rerun}
      </>
    );
  }
  const skippedBranch = run.status === "skipped" && !run.error;
  return (
    <div className="nf-run">
      <p className="nf-run__status" data-status={run.status}>
        {skippedBranch ? "未走此分支" : STATUS_TEXT[run.status]}
        {!run.cached && run.startedAt && run.finishedAt ? `，用时 ${((run.finishedAt - run.startedAt) / 1000).toFixed(2)} 秒` : ""}
        {run.attempts > 1 ? `，尝试 ${run.attempts} 次` : ""}
      </p>
      {run.cached === "cache" && <p className="nf-muted">输入和参数都没变，直接用了缓存的输出，没有重新执行。</p>}
      {run.cached === "reuse" && <p className="nf-muted">沿用了上一次运行的输出。</p>}
      {run.cached === "pin" && <p className="nf-muted">使用的是你选用的那次结果，这次没有重新执行。</p>}
      {skippedBranch && <p className="nf-muted">上游的条件分支没有走到这里，所以没有执行。</p>}
      {run.inactive?.length ? <p className="nf-muted">没有触发的输出：{run.inactive.join("、")}</p> : null}
      {rerun}
      {run.error && <pre className="nf-run__error">{run.error}</pre>}
      {run.outputs && <Values title="输出" values={run.outputs} />}
      {run.inputs && Object.keys(run.inputs).length > 0 && <Values title="输入" values={run.inputs} />}
      {run.logs.length > 0 && (
        <>
          <h4>日志</h4>
          <pre className="nf-log">{run.logs.slice(-300).join("\n")}</pre>
        </>
      )}
    </div>
  );
}

type FileRef = { $file: true; path: string; size: number; mime: string };
const isFile = (v: unknown): v is FileRef => !!v && typeof v === "object" && (v as FileRef).$file === true;

function Values({ title, values }: { title: string; values: Record<string, unknown> }) {
  return (
    <>
      <h4>{title}</h4>
      <dl className="nf-values">
        {Object.entries(values).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{isFile(v) ? <FilePreview f={v} /> : <pre>{typeof v === "string" ? v : JSON.stringify(v, null, 2)}</pre>}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function FilePreview({ f }: { f: FileRef }) {
  const url = fileUrl(f.path);
  const size = f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${(f.size / 1e3).toFixed(1)} KB`;
  const open = () => useStore.getState().openLightbox([{ path: f.path, mime: f.mime, sub: f.path }]);
  return (
    <figure className="nf-file">
      {f.mime.startsWith("image/") && <img src={url} alt={f.path} title="双击放大" onDoubleClick={open} />}
      {f.mime.startsWith("video/") && <video src={url} controls muted loop onDoubleClick={open} />}
      {f.mime.startsWith("audio/") && <audio src={url} controls />}
      <figcaption>
        <a href={url} target="_blank" rel="noreferrer">
          {f.path.split("/").pop()}
        </a>{" "}
        <span className="nf-muted">
          {f.mime}，{size}
        </span>
      </figcaption>
    </figure>
  );
}

function WorkflowPanel() {
  const workflow = useStore((s) => s.workflow)!;
  const issues = useStore((s) => s.issues);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const showRun = useStore((s) => s.showRun);
  const select = useStore((s) => s.select);
  const patch = useStore((s) => s.patch);
  const deleteWorkflow = useStore((s) => s.deleteWorkflow);
  const startRun = useStore((s) => s.startRun);
  const notify = useStore((s) => s.notify);
  const [name, setName] = useState(workflow.name);
  useEffect(() => setName(workflow.name), [workflow.name]);

  return (
    <>
      <header className="nf-insp__head">
        <input
          className="nf-insp__title"
          value={name}
          aria-label="工作流名称"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== workflow.name && patch([{ op: "rename", name: name.trim() }])}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <p className="nf-insp__meta">
          <code>{workflow.id}</code>，第 {workflow.version} 版，{workflow.nodes.length} 个节点
        </p>
      </header>
      <div className="nf-insp__body">
        <h4>检查</h4>
        {issues.length === 0 ? (
          <p className="nf-ok">没有发现问题，可以运行。</p>
        ) : (
          <ul className="nf-issues">
            {issues.map((i, k) => (
              <li key={k}>
                {i.nodeId ? (
                  <button className="nf-link" onClick={() => select(i.nodeId!)}>
                    {i.nodeId}
                  </button>
                ) : null}{" "}
                {i.message}
              </li>
            ))}
          </ul>
        )}

        <h4>最近运行</h4>
        {runs.length === 0 ? (
          <p className="nf-muted">还没有运行过。</p>
        ) : (
          <ul className="nf-runs">
            {runs.map((r) => (
              <li key={r.id}>
                <button aria-current={r.id === run?.id || undefined} onClick={() => showRun(r.id)}>
                  <span className="nf-dot" data-status={r.status} />
                  <span className="nf-runs__time">{shortTime(r.startedAt)}</span>
                  {r.rerunOf && <span className="nf-tag">从 {r.rerunOf.fromNode} 重跑</span>}
                  {r.single && <span className="nf-tag">单独运行 {r.single.nodeId}</span>}
                  <span className="nf-muted">{STATUS_TEXT[r.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {run?.outputs && Object.keys(run.outputs).length > 0 && <Values title="工作流输出" values={run.outputs} />}

        <PublishSection key={workflow.id} />

        <h4>缓存</h4>
        <p className="nf-muted">
          节点类型设置了 <code>cache: true</code> 的节点（如 ffmpeg），输入和参数不变时会直接复用上次的输出。
        </p>
        <div className="nf-row">
          <button className="nf-btn" onClick={() => startRun({}, false)}>
            不用缓存运行
          </button>
          <button
            className="nf-btn nf-btn--ghost"
            onClick={async () => notify("info", `已清除 ${(await api.clearCache()).cleared} 条缓存`)}
          >
            清除全部缓存
          </button>
        </div>

        <button
          className="nf-btn nf-btn--danger"
          onClick={() => confirm(`删除工作流“${workflow.name}”？运行记录会保留。`) && deleteWorkflow(workflow.id)}
        >
          删除工作流
        </button>
      </div>
    </>
  );
}

/** Publish the workflow as an MCP tool; its core.input nodes become the tool's arguments. */
function PublishSection() {
  const workflow = useStore((s) => s.workflow)!;
  const patch = useStore((s) => s.patch);
  const [iface, setIface] = useState<WorkflowInterface | null>(null);
  const [name, setName] = useState(workflow.tool?.name ?? workflow.id.replace(/[^a-zA-Z0-9_-]/g, "_"));
  const [desc, setDesc] = useState(workflow.tool?.description ?? "");
  useEffect(() => {
    api.workflowInterface(workflow.id).then(setIface).catch(() => setIface(null));
  }, [workflow.id, workflow.version]);
  useEffect(() => {
    if (workflow.tool) {
      setName(workflow.tool.name);
      setDesc(workflow.tool.description ?? "");
    }
  }, [workflow.tool]);

  const tool = workflow.tool;
  const dirty = tool && (tool.name !== name || (tool.description ?? "") !== desc);
  const publish = () => patch([{ op: "set_tool", tool: { name: name.trim(), ...(desc.trim() ? { description: desc.trim() } : {}) } }]);

  return (
    <>
      <h4>发布为 MCP 工具</h4>
      <p className="nf-muted">
        {tool ? (
          <>
            已发布。连接到 naturoflow 的 AI 可以直接调用工具 <code>{tool.name}</code>。
          </>
        ) : (
          <>发布后，AI 可以把这个工作流当成一个工具直接调用。工作流的输入节点就是工具的参数。</>
        )}
      </p>
      <div className="nf-form">
        <label className="nf-field">
          <span className="nf-field__label">工具名</span>
          <input className="nf-input nf-code" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="nf-field">
          <span className="nf-field__label">给 AI 看的说明</span>
          <textarea className="nf-input" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="这个工具做什么、什么时候用" />
        </label>
      </div>
      {iface && (
        <p className="nf-muted nf-iface">
          参数：{iface.inputs.length ? iface.inputs.map((i) => `${i.key}（${i.type}${i.required ? "" : "，可选"}）`).join("、") : "无（加 Workflow Input 节点来声明参数）"}
          <br />
          返回：{iface.outputs.length ? iface.outputs.join("、") : "无（加 Workflow Output 节点来声明返回值）"}
        </p>
      )}
      <div className="nf-row">
        {!tool && (
          <button className="nf-btn nf-btn--primary" disabled={!/^[a-zA-Z0-9_-]{1,64}$/.test(name.trim())} onClick={publish}>
            发布
          </button>
        )}
        {dirty && (
          <button className="nf-btn nf-btn--primary" onClick={publish}>
            保存修改
          </button>
        )}
        {tool && (
          <button className="nf-btn nf-btn--ghost" onClick={() => patch([{ op: "set_tool", tool: null }])}>
            取消发布
          </button>
        )}
      </div>
    </>
  );
}

/** Every past execution of this node, newest first, with what was sent and received. */
function NodeHistory({ nodeId, onRan }: { nodeId: string; onRan: () => void }) {
  const runNode = useStore((s) => s.runNode);
  const pinResult = useStore((s) => s.pinResult);
  const pinnedRunId = useStore((s) => s.workflow?.nodes.find((n) => n.id === nodeId)?.pin?.runId);
  const singleRunning = useStore((s) => s.singleRuns[nodeId]?.status === "running");
  const workflowId = useStore((s) => s.workflow!.id);
  // Refetch when a run of this workflow finishes.
  const lastFinished = useStore((s) => (s.run?.workflowId === workflowId ? s.run.finishedAt : undefined));
  const showRun = useStore((s) => s.showRun);
  const currentRun = useStore((s) => s.run?.id);
  const [items, setItems] = useState<NodeHistoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const PAGE = 20;

  useEffect(() => {
    api.nodeHistory(workflowId, nodeId, undefined, PAGE).then((h) => {
      setItems(h);
      setMore(h.length === PAGE);
      setOpen((o) => o ?? h[0]?.runId ?? null);
    });
  }, [workflowId, nodeId, lastFinished]);

  const loadMore = async () => {
    const last = items?.at(-1);
    if (!last) return;
    const h = await api.nodeHistory(workflowId, nodeId, last.runStartedAt, PAGE);
    setItems([...(items ?? []), ...h]);
    setMore(h.length === PAGE);
  };

  if (!items) return <p className="nf-muted">加载中…</p>;
  if (!items.length) return <p className="nf-muted">这个节点还没有执行过。运行工作流后，每次的请求和结果都会记录在这里。</p>;

  return (
    <ol className="nf-hist">
      {items.map((h) => {
        const n = h.node;
        const ms = n.startedAt && n.finishedAt ? n.finishedAt - n.startedAt : undefined;
        const isOpen = open === h.runId;
        return (
          <li key={h.runId} data-open={isOpen || undefined}>
            <button className="nf-hist__row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : h.runId)}>
              <span className="nf-dot" data-status={n.status} />
              <span className="nf-hist__time">{new Date(n.startedAt ?? h.runStartedAt).toLocaleString()}</span>
              {n.cached && <span className="nf-tag">{n.cached === "cache" ? "缓存" : "沿用"}</span>}
              {h.rerunOf && <span className="nf-tag">重跑</span>}
              {h.single && <span className="nf-tag">单独运行</span>}
              <span className="nf-muted nf-hist__meta">
                {STATUS_TEXT[n.status]}
                {ms !== undefined && !n.cached ? `，${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}` : ""}
              </span>
            </button>
            {isOpen && (
              <div className="nf-hist__detail">
                {n.error && <pre className="nf-run__error">{n.error}</pre>}
                {n.trace?.request && <TraceBlock title="请求" value={n.trace.request} />}
                {n.trace?.response && <TraceBlock title="响应" value={n.trace.response} />}
                {n.params && Object.keys(n.params).length > 0 && <TraceBlock title="参数" value={n.params} />}
                {n.inputs && Object.keys(n.inputs).length > 0 && <Values title="输入" values={n.inputs} />}
                {n.outputs && Object.keys(n.outputs).length > 0 && <Values title="输出" values={n.outputs} />}
                {n.logs.length > 0 && (
                  <details className="nf-hist__logs">
                    <summary>日志（{n.logs.length} 条）</summary>
                    <pre className="nf-log">{n.logs.join("\n")}</pre>
                  </details>
                )}
                <div className="nf-row">
                  {n.status === "success" && (
                    <button
                      className="nf-btn"
                      data-on={pinnedRunId === h.runId || undefined}
                      title="运行时不再执行这个节点，下游直接用这次的结果"
                      onClick={() => pinResult(nodeId, pinnedRunId === h.runId ? null : h.runId)}
                    >
                      {pinnedRunId === h.runId ? "已选用（点击取消）" : "选用这个结果"}
                    </button>
                  )}
                  <button
                    className="nf-btn"
                    disabled={singleRunning}
                    title="用这次的输入单独运行这个节点，参数用节点现在的设置"
                    onClick={async () => (await runNode(nodeId, { fromRunId: h.runId, params: "current" })) && onRan()}
                  >
                    用这次的输入运行
                  </button>
                  <button
                    className="nf-btn"
                    disabled={singleRunning || !n.params}
                    title={n.params ? "输入和参数都和这次完全一样，重新执行一遍" : "这次执行没有记录参数（发生在记录参数功能上线之前）"}
                    onClick={async () => (await runNode(nodeId, { fromRunId: h.runId, params: "history" })) && onRan()}
                  >
                    按这次完整重放
                  </button>
                </div>
                <div className="nf-row">
                  {h.runId !== currentRun ? (
                    <button className="nf-btn nf-btn--ghost" onClick={() => showRun(h.runId)}>
                      在画布上查看这次运行
                    </button>
                  ) : (
                    <span className="nf-muted">画布上显示的就是这次运行</span>
                  )}
                  <button className="nf-btn nf-btn--ghost" onClick={() => navigator.clipboard?.writeText(JSON.stringify(n, null, 2))}>
                    复制 JSON
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
      {more && (
        <li>
          <button className="nf-btn nf-btn--ghost" onClick={loadMore}>
            加载更早的记录
          </button>
        </li>
      )}
    </ol>
  );
}

function TraceBlock({ title, value }: { title: string; value: Record<string, unknown> }) {
  const { method, url, ...rest } = value as { method?: string; url?: string };
  return (
    <>
      <h4>{title}</h4>
      {method && url && (
        <p className="nf-hist__url">
          <b>{method}</b> <code>{url}</code>
        </p>
      )}
      <pre className="nf-log">{JSON.stringify(method && url ? rest : value, null, 2)}</pre>
    </>
  );
}

/** Run just this node: with its last inputs, or inputs typed here. */
function SingleRunBox({ node, def, beforeRun }: { node: WorkflowNode; def: NodeTypeDef | null; beforeRun: () => Promise<unknown> }) {
  const workflowId = useStore((s) => s.workflow!.id);
  const runNode = useStore((s) => s.runNode);
  const single = useStore((s) => s.singleRuns[node.id]);
  const [mode, setMode] = useState<"last" | "custom">("last");
  const [text, setText] = useState("");
  const [useCache, setUseCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasInputs = !!def && Object.keys(def.inputs).length > 0;

  // Prefill the custom inputs with what the node got last time (or empty ports).
  useEffect(() => {
    if (mode !== "custom" || text) return;
    api.nodeHistory(workflowId, node.id, undefined, 1).then((h) => {
      const last = h[0]?.node.inputs;
      const blank = Object.fromEntries(Object.keys(def?.inputs ?? {}).map((k) => [k, null]));
      setText(JSON.stringify(last && Object.keys(last).length ? last : blank, null, 2));
    });
  }, [mode, workflowId, node.id, def, text]);

  const run = async () => {
    setError(null);
    let inputs: Record<string, unknown> | undefined;
    if (mode === "custom") {
      try {
        inputs = JSON.parse(text || "{}");
      } catch {
        return setError("输入不是合法的 JSON");
      }
    }
    await beforeRun();
    await runNode(node.id, { ...(inputs ? { inputs } : {}), useCache });
  };

  const nr = single?.nodes[node.id];
  return (
    <section className="nf-single">
      <h4>单独运行</h4>
      <p className="nf-muted">只执行这个节点，上下游都不会运行。结果会记进这个节点的历史。</p>
      {hasInputs && (
        <div className="nf-single__modes" role="radiogroup" aria-label="输入来源">
          <label>
            <input type="radio" checked={mode === "last"} onChange={() => setMode("last")} /> 沿用上次的输入
          </label>
          <label>
            <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} /> 手动填写输入
          </label>
        </div>
      )}
      {hasInputs && mode === "custom" && (
        <textarea
          className="nf-input nf-code"
          rows={Math.min(12, Math.max(4, text.split("\n").length))}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="输入（JSON，按端口名）"
        />
      )}
      <label className="nf-single__cache">
        <input type="checkbox" checked={useCache} onChange={(e) => setUseCache(e.target.checked)} /> 输入和参数没变时使用缓存
      </label>
      {error && <p className="nf-field__error">{error}</p>}
      <button className="nf-btn nf-btn--primary" disabled={single?.status === "running"} onClick={run}>
        {single?.status === "running" ? "运行中…" : "运行这个节点"}
      </button>
      {nr && (
        <div className="nf-single__result">
          <p className="nf-muted">
            {new Date(single.startedAt).toLocaleString()} 的单独运行
            {single.single?.fromRunId ? "（输入来自之前的一次运行）" : ""}
          </p>
          <RunDetail run={nr} nodeId={node.id} single />
        </div>
      )}
    </section>
  );
}

/** Today: time only; otherwise month/day and time. */
function shortTime(ts: number) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
