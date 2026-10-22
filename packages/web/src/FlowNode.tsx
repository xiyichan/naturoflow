import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { fileUrl, type NodePreview, type NodeRun, type NodeTypeSummary, type WorkflowNode } from "./api.ts";
import { NodeResults } from "./NodeResults.tsx";
import { EXECUTOR_LABELS, typeColor, typeLabel } from "./ports.ts";
import { guessMime } from "./mime.ts";
import { useStore } from "./store.ts";

export type FlowNodeData = {
  node: WorkflowNode;
  type?: NodeTypeSummary;
  run?: NodeRun;
  issue?: string;
  previews?: NodePreview[];
};

export type FlowNodeType = Node<FlowNodeData, "nf">;

const STATUS_TEXT: Record<string, string> = {
  pending: "等待",
  running: "运行中",
  success: "完成",
  failed: "失败",
  skipped: "跳过",
  cancelled: "取消",
};

function duration(run?: NodeRun) {
  if (!run?.startedAt || !run.finishedAt) return "";
  const ms = run.finishedAt - run.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function FlowNodeImpl({ data, selected }: NodeProps<FlowNodeType>) {
  const { node, type, run, issue, previews } = data;
  const inputs = Object.entries(type?.inputs ?? {});
  const outputs = Object.entries(type?.outputs ?? {});
  const status = run?.status;

  return (
    <div
      className="nf-node"
      data-status={status ?? "idle"}
      data-selected={selected || undefined}
      data-missing={!type || undefined}
      data-issue={issue ? true : undefined}
      data-branch-skip={(status === "skipped" && !run?.error) || undefined}
    >
      <header className="nf-node__head">
        <span className="nf-node__title">{node.label || type?.name || node.type}</span>
        {node.pin && <span className="nf-node__pinned" title="已选用一次历史结果，运行时不再执行这个节点">已选用</span>}
        <span className="nf-node__kind">{type ? EXECUTOR_LABELS[type.executor] ?? type.executor : "未知类型"}</span>
      </header>
      <div className="nf-node__sub">
        <code>{node.id}</code>
        {status && status !== "pending" && (
          <span className="nf-node__status">
            {status === "skipped" && run?.note ? "未走此分支" : STATUS_TEXT[status]}{" "}
            {run?.cached ? (run.cached === "cache" ? "（缓存）" : run.cached === "pin" ? "（已选用）" : "（沿用）") : duration(run)}
          </span>
        )}
      </div>

      {node.type === "core.file" && typeof node.params.path === "string" && (
        <div className="nf-node__file" title={node.params.path}>
          {/\.(png|jpe?g|webp|gif|svg)$/i.test(node.params.path) ? (
            <img
              src={fileUrl(node.params.path)}
              alt=""
              draggable={false}
              title="双击放大"
              onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              onDoubleClick={(e) => {
                e.stopPropagation();
                const p = node.params.path as string;
                useStore.getState().openLightbox([{ path: p, mime: guessMime(p), title: node.label, sub: p }]);
              }}
            />
          ) : null}
          <span>{node.params.path.split("/").pop()}</span>
        </div>
      )}
      <div className="nf-node__ports">
        <div className="nf-node__col">
          {inputs.map(([name, p]) => (
            <div key={name} className="nf-port nf-port--in" title={`${name}: ${typeLabel(p.type)}${p.required ? "" : "（可选）"}`}>
              <Handle
                type="target"
                position={Position.Left}
                id={name}
                className="nf-jack"
                style={{ "--jack": typeColor(p.type) } as React.CSSProperties}
              />
              <span className="nf-port__name" data-optional={!p.required || undefined}>
                {name}
              </span>
            </div>
          ))}
        </div>
        <div className="nf-node__col nf-node__col--out">
          {outputs.map(([name, p]) => (
            <div
              key={name}
              className="nf-port nf-port--out"
              data-inactive={run?.inactive?.includes(name) || (status === "skipped" && !run?.error) || undefined}
              title={`${name}: ${typeLabel(p.type)}`}
            >
              <span className="nf-port__name">{name}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={name}
                className="nf-jack"
                style={{ "--jack": typeColor(p.type) } as React.CSSProperties}
              />
            </div>
          ))}
        </div>
      </div>
      {previews && previews.length > 0 && <NodeResults nodeId={node.id} previews={previews} pinnedRunId={node.pin?.runId} />}
      {(issue || run?.error) && <p className="nf-node__error">{run?.error ?? issue}</p>}
    </div>
  );
}

export const FlowNode = memo(FlowNodeImpl);
