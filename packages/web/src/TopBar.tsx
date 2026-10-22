import { useEffect, useRef, useState } from "react";
import { useStore } from "./store.ts";

export function TopBar() {
  const workflows = useStore((s) => s.workflows);
  const workflow = useStore((s) => s.workflow);
  const connected = useStore((s) => s.connected);
  const issues = useStore((s) => s.issues);
  const run = useStore((s) => s.run);
  const openWorkflow = useStore((s) => s.openWorkflow);
  const createWorkflow = useStore((s) => s.createWorkflow);
  const layout = useStore((s) => s.layout);
  const startRun = useStore((s) => s.startRun);
  const cancelRun = useStore((s) => s.cancelRun);
  const select = useStore((s) => s.select);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const [askInputs, setAskInputs] = useState(false);

  const running = run?.status === "running" && run.workflowId === workflow?.id;
  const inputNodes = workflow?.nodes.filter((n) => n.type === "core.input") ?? [];

  return (
    <header className="nf-top">
      <span className="nf-brand">naturoflow</span>
      <select
        className="nf-input nf-top__wf"
        aria-label="切换工作流"
        value={workflow?.id ?? ""}
        onChange={(e) => e.target.value && openWorkflow(e.target.value)}
      >
        {!workflow && <option value="">选择工作流</option>}
        {workflows.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      {workflow && (
        <div className="nf-seg nf-top__views" role="tablist" aria-label="视图">
          <button role="tab" aria-selected={view === "canvas"} onClick={() => setView("canvas")}>
            画布
          </button>
          <button role="tab" aria-selected={view === "gallery"} onClick={() => setView("gallery")}>
            生成结果
          </button>
        </div>
      )}
      <button
        className="nf-btn nf-btn--ghost"
        onClick={() => {
          const name = prompt("新工作流的名称");
          if (name?.trim()) createWorkflow(name.trim());
        }}
      >
        新建工作流
      </button>

      <span className="nf-spacer" />

      <span className="nf-sync" data-on={connected || undefined} title={connected ? "画布与服务实时同步，AI 的修改会马上出现" : "与服务断开，正在重连"}>
        {connected ? "实时同步中" : "已断开，重连中"}
      </span>

      {workflow && (
        <>
          <button
            className="nf-btn nf-btn--ghost"
            data-warn={issues.length > 0 || undefined}
            onClick={() => {
              setView("canvas");
              select(null);
            }}
            title="在右侧查看检查结果"
          >
            {issues.length ? `${issues.length} 个问题` : "检查通过"}
          </button>
          <button className="nf-btn nf-btn--ghost" onClick={layout}>
            自动排列
          </button>
          {running ? (
            <button className="nf-btn nf-btn--stop" onClick={cancelRun}>
              停止运行
            </button>
          ) : (
            <div className="nf-runwrap">
              <button
                className="nf-btn nf-btn--primary"
                onClick={() => (inputNodes.length ? setAskInputs(true) : startRun({}))}
              >
                运行
              </button>
              {askInputs && (
                <RunInputs
                  keys={inputNodes.map((n) => ({ key: String(n.params.key ?? n.id), def: n.params.default }))}
                  onCancel={() => setAskInputs(false)}
                  onRun={(inputs) => {
                    setAskInputs(false);
                    startRun(inputs);
                  }}
                />
              )}
            </div>
          )}
        </>
      )}
    </header>
  );
}

function RunInputs({
  keys,
  onRun,
  onCancel,
}: {
  keys: { key: string; def: unknown }[];
  onRun: (v: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(keys.map((k) => [k.key, k.def === undefined ? "" : typeof k.def === "string" ? k.def : JSON.stringify(k.def)])),
  );
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const submit = () => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === "") continue;
      // Numbers, booleans and JSON are parsed; anything else is a string.
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    }
    onRun(out);
  };
  return (
    <form
      className="nf-pop"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <p className="nf-pop__title">运行输入</p>
      {keys.map(({ key }, i) => (
        <label key={key} className="nf-field">
          <span className="nf-field__label">{key}</span>
          <input
            ref={i === 0 ? first : undefined}
            className="nf-input"
            value={values[key]}
            onChange={(e) => setValues({ ...values, [key]: e.target.value })}
          />
        </label>
      ))}
      <div className="nf-pop__actions">
        <button type="button" className="nf-btn nf-btn--ghost" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="nf-btn nf-btn--primary">
          运行
        </button>
      </div>
    </form>
  );
}
