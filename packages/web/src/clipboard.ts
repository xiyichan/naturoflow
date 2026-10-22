import type { Edge, PatchOp, Workflow, WorkflowNode } from "./api.ts";
import { freshNodeId } from "./ids.ts";

/** Marker so we only paste our own clipboard contents, not arbitrary JSON. */
const KIND = "naturoflow/nodes";

interface Clip {
  kind: typeof KIND;
  nodes: WorkflowNode[];
  edges: Edge[];
}

/** The chosen nodes plus the cables between them, as clipboard text. */
export function copyText(wf: Workflow, ids: Set<string>): string | null {
  const nodes = wf.nodes.filter((n) => ids.has(n.id));
  if (!nodes.length) return null;
  const edges = wf.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node));
  return JSON.stringify({ kind: KIND, nodes, edges } satisfies Clip);
}

export function parseClip(text: string | undefined | null): Clip | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v?.kind === KIND && Array.isArray(v.nodes) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ops that add a copy of the clip to `wf`: fresh ids, internal cables rewired, and the group
 * moved so its top-left corner sits at `at`. A chosen past result belongs to the original node,
 * so copies start without one.
 */
export function pasteOps(wf: Workflow, clip: Clip, at: { x: number; y: number }) {
  const taken = new Set(wf.nodes.map((n) => n.id));
  const rename = new Map<string, string>();
  for (const n of clip.nodes) {
    const id = freshNodeId(n.id, taken);
    taken.add(id);
    rename.set(n.id, id);
  }
  const minX = Math.min(...clip.nodes.map((n) => n.position.x));
  const minY = Math.min(...clip.nodes.map((n) => n.position.y));
  const ops: PatchOp[] = clip.nodes.map(({ pin: _pin, ...n }) => ({
    op: "add_node",
    node: {
      ...n,
      id: rename.get(n.id)!,
      position: { x: Math.round(n.position.x - minX + at.x), y: Math.round(n.position.y - minY + at.y) },
    },
  }));
  for (const e of clip.edges) {
    const from = rename.get(e.from.node);
    const to = rename.get(e.to.node);
    if (from && to) ops.push({ op: "connect", edge: { from: { ...e.from, node: from }, to: { ...e.to, node: to } } });
  }
  return { ops, ids: [...rename.values()] };
}
