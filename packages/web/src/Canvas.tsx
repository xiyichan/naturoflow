import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type IsValidConnection,
  type OnDelete,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, type DragEvent } from "react";
import type { Edge, PatchOp } from "./api.ts";
import { FlowNode, type FlowNodeType } from "./FlowNode.tsx";
import { portCompatible, typeColor } from "./ports.ts";
import { useStore } from "./store.ts";

const nodeTypes = { nf: FlowNode };
export const DND_TYPE = "application/x-naturoflow-node-type";

const edgeId = (e: Edge) => `${e.from.node}.${e.from.port}->${e.to.node}.${e.to.port}`;

/** Pick a readable, unique node id from the type id, e.g. "ffmpeg.to-gif" -> "to_gif_2". */
export function freshNodeId(typeId: string, taken: Set<string>) {
  const base = (typeId.split(".").pop() ?? "node").replace(/[^a-zA-Z0-9_]/g, "_");
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function Canvas() {
  const workflow = useStore((s) => s.workflow);
  const types = useStore((s) => s.nodeTypes);
  const run = useStore((s) => s.run);
  const issues = useStore((s) => s.issues);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const patch = useStore((s) => s.patch);
  const { screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNodeType>([]);

  // Server state -> React Flow nodes. Positions come from the server except while dragging.
  useEffect(() => {
    if (!workflow) return setNodes([]);
    const issueByNode = new Map(issues.filter((i) => i.nodeId).map((i) => [i.nodeId!, i.message]));
    setNodes((prev) => {
      const dragging = new Map(prev.filter((n) => n.dragging).map((n) => [n.id, n.position]));
      return workflow.nodes.map((n) => ({
        id: n.id,
        type: "nf",
        position: dragging.get(n.id) ?? n.position,
        selected: n.id === selected,
        data: {
          node: n,
          type: types[n.type],
          run: run?.workflowId === workflow.id ? run.nodes[n.id] : undefined,
          issue: issueByNode.get(n.id),
        },
      }));
    });
  }, [workflow, types, run, issues, selected, setNodes]);

  const edges = useMemo<RFEdge[]>(() => {
    if (!workflow) return [];
    const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
    return workflow.edges.map((e) => {
      const portType = types[byId.get(e.from.node)?.type ?? ""]?.outputs[e.from.port]?.type;
      const up = run?.workflowId === workflow.id ? run.nodes[e.from.node] : undefined;
      const status = up?.status;
      // Cables from ports that didn't fire (untaken if-branch) are drawn faint and dashed.
      const dead = !!up && (up.inactive?.includes(e.from.port) || (up.status === "skipped" && !up.error));
      return {
        id: edgeId(e),
        source: e.from.node,
        sourceHandle: e.from.port,
        target: e.to.node,
        targetHandle: e.to.port,
        animated: status === "running",
        className: dead ? "nf-cable nf-cable--dead" : "nf-cable",
        style: { stroke: typeColor(portType) },
        data: { edge: e },
      };
    });
  }, [workflow, types, run]);

  const portType = useCallback(
    (nodeId: string, port: string, dir: "inputs" | "outputs") => {
      const n = workflow?.nodes.find((x) => x.id === nodeId);
      return n ? types[n.type]?.[dir][port]?.type : undefined;
    },
    [workflow, types],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (c) => {
      if (c.source === c.target || !c.sourceHandle || !c.targetHandle) return false;
      const from = portType(c.source, c.sourceHandle, "outputs");
      const to = portType(c.target, c.targetHandle, "inputs");
      return !!from && !!to && portCompatible(from, to);
    },
    [portType],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      patch([{ op: "connect", edge: { from: { node: c.source, port: c.sourceHandle! }, to: { node: c.target, port: c.targetHandle! } } }]);
    },
    [patch],
  );

  const onDelete: OnDelete<FlowNodeType, RFEdge> = useCallback(
    ({ nodes: deadNodes, edges: deadEdges }) => {
      const gone = new Set(deadNodes.map((n) => n.id));
      const ops: PatchOp[] = [
        ...deadNodes.map((n) => ({ op: "remove_node" as const, id: n.id })),
        ...deadEdges
          .filter((e) => !gone.has(e.source) && !gone.has(e.target))
          .map((e) => ({ op: "disconnect" as const, edge: (e.data as { edge: Edge }).edge })),
      ];
      if (ops.length) patch(ops);
      if (selected && gone.has(selected)) select(null);
    },
    [patch, select, selected],
  );

  const onDrop = useCallback(
    (ev: DragEvent) => {
      const typeId = ev.dataTransfer.getData(DND_TYPE);
      if (!typeId || !workflow) return;
      ev.preventDefault();
      const id = freshNodeId(typeId, new Set(workflow.nodes.map((n) => n.id)));
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      patch([{ op: "add_node", node: { id, type: typeId, params: {}, position: { x: Math.round(p.x), y: Math.round(p.y) } } }]).then(
        (ok) => ok && select(id),
      );
    },
    [workflow, patch, select, screenToFlowPosition],
  );

  if (!workflow) {
    return (
      <div className="nf-empty">
        <p>还没有打开的工作流。</p>
        <p>在顶栏新建一个，或者让 AI 通过 MCP 调用 <code>create_workflow</code>，它会马上出现在这里。</p>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onDelete={onDelete}
      onNodeDragStop={(_, __, dragged) =>
        patch(dragged.map((n) => ({ op: "update_node", id: n.id, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })))
      }
      onNodeClick={(_, n) => select(n.id)}
      onPaneClick={() => select(null)}
      onDragOver={(ev) => {
        if (ev.dataTransfer.types.includes(DND_TYPE)) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={onDrop}
      deleteKeyCode={["Backspace", "Delete"]}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "default" }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="var(--grid)" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} className="nf-minimap" style={{ width: 160, height: 110 }} />
    </ReactFlow>
  );
}
