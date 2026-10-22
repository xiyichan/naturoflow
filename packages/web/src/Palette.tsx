import { useMemo, useState } from "react";
import type { NodeTypeSummary } from "./api.ts";
import { Assets } from "./Assets.tsx";
import { DND_TYPE } from "./Canvas.tsx";
import { freshNodeId } from "./ids.ts";
import { EXECUTOR_LABELS, typeColor } from "./ports.ts";
import { useStore } from "./store.ts";
import { t } from "./i18n.ts";

const CATEGORY_LABELS: Record<string, string> = {
  core: t("流程"),
  network: t("网络"),
  media: t("媒体"),
  script: t("脚本"),
  data: t("数据"),
  ai: t("AI 模型"),
  general: t("其他"),
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
      (nt) => !needle || `${nt.id} ${nt.name} ${nt.description ?? ""}`.toLowerCase().includes(needle),
    );
    const by = new Map<string, NodeTypeSummary[]>();
    for (const nt of list.sort((a, b) => a.name.localeCompare(b.name))) {
      by.set(nt.category, [...(by.get(nt.category) ?? []), nt]);
    }
    return [...by].sort(([a], [b]) => (a === "core" ? -1 : b === "core" ? 1 : a.localeCompare(b)));
  }, [types, q]);

  const add = async (nt: NodeTypeSummary) => {
    if (!workflow) return;
    const id = freshNodeId(nt.id, new Set(workflow.nodes.map((n) => n.id)));
    const maxX = Math.max(0, ...workflow.nodes.map((n) => n.position.x));
    if (await patch([{ op: "add_node", node: { id, type: nt.id, params: {}, position: { x: maxX + 300, y: 80 } } }])) select(id);
  };

  const tabs = (
    <div className="nf-tabs nf-pal__tabs" role="tablist">
      <button role="tab" aria-selected={tab === "nodes"} onClick={() => setTab("nodes")}>
        
        {t("节点")}
      </button>
      <button role="tab" aria-selected={tab === "assets"} onClick={() => setTab("assets")}>
        
        {t("素材")}
      </button>
    </div>
  );

  if (tab === "assets") {
    const maxX = Math.max(0, ...(workflow?.nodes ?? []).map((n) => n.position.x));
    return (
      <aside className="nf-pal" aria-label={t("素材")}>
        {tabs}
        <Assets onAdd={(files) => addFileNodes(files, { position: { x: maxX + 300, y: 80 } })} />
      </aside>
    );
  }

  return (
    <aside className="nf-pal" aria-label={t("节点库")}>
      {tabs}
      <div className="nf-pal__top">
        <input
          className="nf-input"
          type="search"
          placeholder={t("搜索节点")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t("搜索节点")}
        />
        <button className="nf-btn nf-btn--ghost" onClick={() => setEditor({ mode: "new" })}>
          
          {t("新建节点类型")}
        </button>
      </div>
      <p className="nf-pal__hint">{t("拖到画布上，或双击添加")}</p>
      <div className="nf-pal__list">
        {groups.map(([cat, list]) => (
          <section key={cat}>
            <h3 className="nf-pal__cat">{CATEGORY_LABELS[cat] ?? cat}</h3>
            <ul>
              {list.map((nt) => (
                <li key={nt.id}>
                  <div
                    className="nf-pal__item"
                    draggable={!!workflow}
                    tabIndex={0}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DND_TYPE, nt.id);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onDoubleClick={() => add(nt)}
                    onKeyDown={(e) => e.key === "Enter" && add(nt)}
                    title={nt.description ?? nt.id}
                  >
                    <Jacks ports={nt.inputs} />
                    <span className="nf-pal__name">
                      {nt.name}
                      <small>{nt.id}</small>
                    </span>
                    <Jacks ports={nt.outputs} />
                    <span className="nf-pal__kind">{EXECUTOR_LABELS[nt.executor] ?? nt.executor}</span>
                    {nt.executor !== "builtin" && (
                      <button
                        className="nf-pal__edit"
                        onClick={() => setEditor({ mode: "edit", id: nt.id })}
                        aria-label={t("编辑 {0}", [nt.name])}
                      >
                        
                        {t("编辑")}
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
