import { useEffect, useRef, useState } from "react";
import { api, fileUrl, type NodeRun, type NodeTypeDef, type WorkflowInterface, type WorkflowNode } from "./api.ts";
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
  const [tab, setTab] = useState<"params" | "run">("params");
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
      </header>

      <div className="nf-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "params"} onClick={() => setTab("params")}>
          参数
        </button>
        <button role="tab" aria-selected={tab === "run"} onClick={() => setTab("run")}>
          运行结果
          {nodeRun && nodeRun.status !== "pending" && <span className="nf-dot" data-status={nodeRun.status} />}
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
        ) : (
          <RunDetail run={nodeRun} nodeId={node.id} />
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

function RunDetail({ run, nodeId }: { run?: NodeRun; nodeId: string }) {
  const rerunFrom = useStore((s) => s.rerunFrom);
  const runStatus = useStore((s) => s.run?.status);
  const rerun = runStatus && runStatus !== "running" && (
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
  return (
    <figure className="nf-file">
      {f.mime.startsWith("image/") && <img src={url} alt={f.path} />}
      {f.mime.startsWith("video/") && <video src={url} controls muted loop />}
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
                  {new Date(r.startedAt).toLocaleString()}
                  {r.rerunOf && <span className="nf-tag">从 {r.rerunOf.fromNode} 重跑</span>}
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
