import { useMemo, useState } from "react";
import type { NodeTypeSummary } from "./api.ts";
import { Assets } from "./Assets.tsx";
import { DND_TYPE } from "./Canvas.tsx";
import { freshNodeId } from "./ids.ts";
import { EXECUTOR_LABELS, typeColor } from "./ports.ts";
import { useStore } from "./store.ts";

const CATEGORY_LABELS: Record<string, string> = {
  core: "流程",
  network: "网络",
  media: "媒体",
  script: "脚本",
  data: "数据",
  ai: "AI 模型",
  general: "其他",
};

function Jacks({ ports }: { ports: NodeTypeSummary["inputs"] }) {
  return (
    <span className="nf-pal__jacks">
      {Object.entries(ports).map(([name, p]) => (
        <i key={name} style={{ background: typeColor(p.type) }} />
      ))}
    </span>
  );
}

export function Palette() {
  const types = useStore((s) => s.nodeTypes);
  const workflow = useStore((s) => s.workflow);
  const patch = useStore((s) => s.patch);
  const select = useStore((s) => s.select);
  const setEditor = useStore((s) => s.setEditor);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"nodes" | "assets">("nodes");
  const addFileNodes = useStore((s) => s.addFileNodes);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = Object.values(types).filter(
      (t) => !needle || `${t.id} ${t.name} ${t.description ?? ""}`.toLowerCase().includes(needle),
    );
    const by = new Map<string, NodeTypeSummary[]>();
    for (const t of list.sort((a, b) => a.name.localeCompare(b.name))) {
      by.set(t.category, [...(by.get(t.category) ?? []), t]);
    }
    return [...by].sort(([a], [b]) => (a === "core" ? -1 : b === "core" ? 1 : a.localeCompare(b)));
  }, [types, q]);

  const add = async (t: NodeTypeSummary) => {
    if (!workflow) return;
    const id = freshNodeId(t.id, new Set(workflow.nodes.map((n) => n.id)));
    const maxX = Math.max(0, ...workflow.nodes.map((n) => n.position.x));
    if (await patch([{ op: "add_node", node: { id, type: t.id, params: {}, position: { x: maxX + 300, y: 80 } } }])) select(id);
  };

  const tabs = (
    <div className="nf-tabs nf-pal__tabs" role="tablist">
      <button role="tab" aria-selected={tab === "nodes"} onClick={() => setTab("nodes")}>
        节点
      </button>
      <button role="tab" aria-selected={tab === "assets"} onClick={() => setTab("assets")}>
        素材
      </button>
    </div>
  );

  if (tab === "assets") {
    const maxX = Math.max(0, ...(workflow?.nodes ?? []).map((n) => n.position.x));
    return (
      <aside className="nf-pal" aria-label="素材">
        {tabs}
        <Assets onAdd={(files) => addFileNodes(files, { position: { x: maxX + 300, y: 80 } })} />
      </aside>
    );
  }

  return (
    <aside className="nf-pal" aria-label="节点库">
      {tabs}
      <div className="nf-pal__top">
        <input
          className="nf-input"
          type="search"
          placeholder="搜索节点"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索节点"
        />
        <button className="nf-btn nf-btn--ghost" onClick={() => setEditor({ mode: "new" })}>
          新建节点类型
        </button>
      </div>
      <p className="nf-pal__hint">拖到画布上，或双击添加</p>
      <div className="nf-pal__list">
        {groups.map(([cat, list]) => (
          <section key={cat}>
            <h3 className="nf-pal__cat">{CATEGORY_LABELS[cat] ?? cat}</h3>
            <ul>
              {list.map((t) => (
                <li key={t.id}>
                  <div
                    className="nf-pal__item"
                    draggable={!!workflow}
                    tabIndex={0}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DND_TYPE, t.id);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onDoubleClick={() => add(t)}
                    onKeyDown={(e) => e.key === "Enter" && add(t)}
                    title={t.description ?? t.id}
                  >
                    <Jacks ports={t.inputs} />
                    <span className="nf-pal__name">
                      {t.name}
                      <small>{t.id}</small>
                    </span>
                    <Jacks ports={t.outputs} />
                    <span className="nf-pal__kind">{EXECUTOR_LABELS[t.executor] ?? t.executor}</span>
                    {t.executor !== "builtin" && (
                      <button
                        className="nf-pal__edit"
                        onClick={() => setEditor({ mode: "edit", id: t.id })}
                        aria-label={`编辑 ${t.name}`}
                      >
                        编辑
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
