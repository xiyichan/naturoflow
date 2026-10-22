import { useEffect, useRef } from "react";
import { useStore } from "./store.ts";
import { t } from "./i18n.ts";

const STATUS_TEXT: Record<string, string> = {
  pending: t("等待"),
  running: t("运行中"),
  success: t("成功"),
  failed: t("失败"),
  skipped: t("跳过"),
  cancelled: t("取消"),
};

/** Bottom strip: one chip per node for the current run, expandable to the combined log. */
export function RunDrawer() {
  const run = useStore((s) => s.run);
  const workflow = useStore((s) => s.workflow);
  const open = useStore((s) => s.logOpen);
  const setOpen = useStore((s) => s.setLogOpen);
  const select = useStore((s) => s.select);
  const logRef = useRef<HTMLPreElement>(null);

  const order = workflow?.nodes.map((n) => n.id) ?? [];
  const nodes = run ? order.map((id) => run.nodes[id]).filter(Boolean) : [];
  const lines = nodes.flatMap((n) => n.logs.map((l) => `${n.nodeId.padEnd(12)} ${l}`));

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, open]);

  if (!run || run.workflowId !== workflow?.id) return null;

  return (
    <section className="nf-drawer" data-open={open || undefined} aria-label={t("运行日志")}>
      <div className="nf-drawer__bar">
        <button className="nf-btn nf-btn--ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? t("收起日志") : t("展开日志")}
        </button>
        <span className="nf-drawer__run" data-status={run.status}>
          {STATUS_TEXT[run.status]}
        </span>
        <ol className="nf-chips">
          {nodes.map((n) => (
            <li key={n.nodeId}>
              <button data-status={n.status} onClick={() => select(n.nodeId)} title={n.error ?? STATUS_TEXT[n.status]}>
                {n.nodeId}
              </button>
            </li>
          ))}
        </ol>
      </div>
      {open && (
        <pre ref={logRef} className="nf-log nf-drawer__log">
          {lines.length ? lines.join("\n") : t("这次运行还没有日志输出。")}
        </pre>
      )}
    </section>
  );
}
