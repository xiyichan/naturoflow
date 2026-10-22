import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge as RFEdge, type EdgeProps } from "@xyflow/react";
import type { Edge } from "./api.ts";
import { useStore } from "./store.ts";
import { t } from "./i18n.ts";

export type CableEdgeType = RFEdge<{ edge: Edge }, "cable">;

/** A cable; when selected it shows a × at its midpoint that disconnects it. */
export function CableEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, selected, data, interactionWidth }: EdgeProps<CableEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth ?? 32} />
      {selected && data && (
        <EdgeLabelRenderer>
          <button
            className="nf-cable__cut nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={t("断开这条连线（Delete）")}
            aria-label={t("断开连线")}
            // Act on pointer down: by click time the pane would already have deselected the edge
            // (unmounting this button).
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              useStore.getState().patch([{ op: "disconnect", edge: data.edge }]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") useStore.getState().patch([{ op: "disconnect", edge: data.edge }]);
            }}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
