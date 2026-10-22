import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fileUrl, type Artifact } from "./api.ts";
import { MasonryItem } from "./Masonry.tsx";
import { useStore } from "./store.ts";
import { t } from "./i18n.ts";

const KINDS: { label: string; mime?: string }[] = [
  { label: t("全部") },
  { label: t("图片"), mime: "image/" },
  { label: t("视频"), mime: "video/" },
  { label: t("音频"), mime: "audio/" },
];

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

function sizeOf(n: number) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** The text that best identifies how a file was made (usually the prompt). */
function headline(a: Artifact) {
  // The producer's own prompt, else the nearest upstream one (e.g. Seedream before a download step).
  for (const p of [a.params, ...(a.lineage ?? []).map((l) => l.params)]) {
    const v = p?.prompt ?? p?.text;
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function toLightbox(a: Artifact) {
  return { path: a.path, mime: a.mime, title: headline(a) || undefined, sub: `${a.nodeLabel || a.nodeId}${t("，")}${new Date(a.createdAt).toLocaleString()}${a.note ? `，${a.note}` : ""}` };
}

/** Own params plus upstream params as "node.param", for comparing whole chains. */
function allParams(a: Artifact): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(a.params ?? {}) };
  for (const l of a.lineage ?? []) for (const [k, v] of Object.entries(l.params ?? {})) out[`${l.nodeLabel || l.nodeId}.${k}`] = v;
  return out;
}

function Thumb({ a, big }: { a: Artifact; big?: boolean }) {
  const url = fileUrl(a.path);
  if (a.mime.startsWith("image/")) return <img src={url} alt={headline(a) || a.path} loading="lazy" />;
  if (a.mime.startsWith("video/")) return <video src={url} preload="metadata" muted controls={big} loop={big} />;
  if (a.mime.startsWith("audio/")) return big ? <audio src={url} controls /> : <span className="nf-gal__icon">{t("音频")}</span>;
  return <span className="nf-gal__icon">{a.path.split(".").pop()?.toUpperCase()}</span>;
}

/** Everything the workflow's runs produced, newest first, to look back at and compare. */
export function Gallery() {
  const workflow = useStore((s) => s.workflow);
  const version = useStore((s) => s.artifactsVersion);
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | undefined>();
  const [nodeId, setNodeId] = useState("");
  const [kind, setKind] = useState(0);
  const [starredOnly, setStarredOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const openLightbox = useStore((s) => s.openLightbox);

  const query = useMemo(() => ({ nodeId: nodeId || undefined, mime: KINDS[kind].mime, starred: starredOnly }), [nodeId, kind, starredOnly]);

  useEffect(() => {
    if (!workflow) return;
    api.artifacts(workflow.id, query).then((r) => {
      setItems(r.items);
      setNextBefore(r.nextBefore);
      setSelected((s) => (s && r.items.some((a) => a.path === s) ? s : (r.items[0]?.path ?? null)));
    });
  }, [workflow?.id, query, version]);

  const loadMore = async () => {
    if (!workflow || !nextBefore) return;
    const r = await api.artifacts(workflow.id, { ...query, before: nextBefore });
    setItems((cur) => [...(cur ?? []), ...r.items.filter((a) => !cur?.some((c) => c.path === a.path))]);
    setNextBefore(r.nextBefore);
  };

  const update = useCallback((path: string, mark: Partial<Pick<Artifact, "starred" | "note">>) => {
    setItems((cur) => cur?.map((a) => (a.path === path ? { ...a, ...mark } : a)) ?? null);
    api.markArtifact(path, mark);
  }, []);

  const togglePick = (path: string) =>
    setPicked((p) => (p.includes(path) ? p.filter((x) => x !== path) : p.length >= 4 ? [...p.slice(1), path] : [...p, path]));

  if (!workflow) return <div className="nf-empty"><p>{t("先打开一个工作流。")}</p></div>;
  const current = items?.find((a) => a.path === selected);
  const pickedItems = picked.map((p) => items?.find((a) => a.path === p)).filter(Boolean) as Artifact[];

  return (
    <>
      <main className="nf-gal">
        <div className="nf-gal__bar">
          <span className="nf-gal__count">{items ? t("{0}{1} 个文件", [items.length, nextBefore ? "+" : ""]) : t("加载中…")}</span>
          <div className="nf-seg" role="radiogroup" aria-label={t("文件类型")}>
            {KINDS.map((k, i) => (
              <button key={k.label} role="radio" aria-checked={kind === i} onClick={() => setKind(i)}>
                {k.label}
              </button>
            ))}
          </div>
          <select className="nf-input nf-gal__node" value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label={t("按节点筛选")}>
            <option value="">{t("所有节点")}</option>
            {workflow.nodes
              .filter((n) => !n.type.startsWith("core.") || n.type === "core.map" || n.type === "core.subflow")
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label || n.id}
                </option>
              ))}
          </select>
          <label className="nf-gal__star-filter">
            <input type="checkbox" checked={starredOnly} onChange={(e) => setStarredOnly(e.target.checked)} />  {t("只看标星")}
          </label>
          <span className="nf-spacer" />
          {picked.length > 0 && (
            <button className="nf-btn nf-btn--ghost" onClick={() => setPicked([])}>
              
              {t("清除勾选")}
            </button>
          )}
          <button className="nf-btn nf-btn--primary" disabled={pickedItems.length < 2} onClick={() => setComparing(true)}>
            
            {t("对比所选（{0}）", [pickedItems.length])}
          </button>
        </div>

        {items && items.length === 0 ? (
          <div className="nf-empty">
            <p>{starredOnly || nodeId || kind ? t("没有符合筛选条件的文件。") : t("这个工作流还没有生成过文件。")}</p>
            <p>{t("运行后，生成的图片、视频、音频都会出现在这里，最新的在最前面。")}</p>
          </div>
        ) : (
          <ul className="nf-gal__grid nf-masonry">
            {items?.map((a) => (
              <MasonryItem key={a.path} gap={14} data-selected={a.path === selected || undefined} data-picked={picked.includes(a.path) || undefined}>
                <button
                  className="nf-gal__card"
                  onClick={() => setSelected(a.path)}
                  onDoubleClick={() => openLightbox(items.map(toLightbox), items.indexOf(a))}
                  title={t("{0}\n双击放大", [headline(a) || a.path])}
                >
                  <span className="nf-gal__media">
                    <Thumb a={a} />
                  </span>
                  <span className="nf-gal__cap">
                    <b>{a.nodeLabel || a.nodeId}</b>
                    <span className="nf-muted">{when(a.createdAt)}</span>
                  </span>
                  {headline(a) && <span className="nf-gal__prompt">{headline(a)}</span>}
                  {a.note && <span className="nf-gal__note">{a.note}</span>}
                </button>
                <label className="nf-gal__pick" title={t("勾选后可以对比")}>
                  <input type="checkbox" checked={picked.includes(a.path)} onChange={() => togglePick(a.path)} aria-label={t("勾选对比")} />
                </label>
                <button
                  className="nf-gal__star"
                  data-on={a.starred || undefined}
                  onClick={() => update(a.path, { starred: !a.starred })}
                  aria-label={a.starred ? t("取消标星") : t("标星")}
                  title={a.starred ? t("取消标星") : t("标星")}
                >
                  ★
                </button>
              </MasonryItem>
            ))}
            {nextBefore && (
              <li className="nf-gal__more">
                <button className="nf-btn" onClick={loadMore}>
                  
                  {t("加载更早的")}
                </button>
              </li>
            )}
          </ul>
        )}
      </main>

      <aside className="nf-insp" aria-label={t("文件详情")}>
        {current ? <Detail key={current.path} a={current} onMark={(m) => update(current.path, m)} /> : <p className="nf-muted nf-insp__body">{t("选一个文件查看详情。")}</p>}
      </aside>

      {comparing && <Compare items={pickedItems} onClose={() => setComparing(false)} onMark={update} />}
    </>
  );
}

function Detail({ a, onMark }: { a: Artifact; onMark: (m: Partial<Pick<Artifact, "starred" | "note">>) => void }) {
  const setView = useStore((s) => s.setView);
  const showRun = useStore((s) => s.showRun);
  const select = useStore((s) => s.select);
  const [note, setNote] = useState(a.note);
  useEffect(() => setNote(a.note), [a.note]);

  return (
    <>
      <div className="nf-gal__big" title={t("双击放大")} onDoubleClick={() => useStore.getState().openLightbox([toLightbox(a)])}>
        <Thumb a={a} big />
      </div>
      <div className="nf-insp__body">
        <div className="nf-row nf-gal__actions">
          <button className="nf-btn" data-on={a.starred || undefined} onClick={() => onMark({ starred: !a.starred })}>
            {a.starred ? t("★ 已标星") : t("☆ 标星")}
          </button>
          <button
            className="nf-btn nf-btn--ghost"
            onClick={async () => {
              await showRun(a.runId);
              select(a.nodeId);
              setView("canvas");
            }}
          >
            
            {t("在画布上查看这次运行")}
          </button>
          <a className="nf-btn nf-btn--ghost" href={fileUrl(a.path)} target="_blank" rel="noreferrer">
            
            {t("打开原文件")}
          </a>
        </div>
        <label className="nf-field">
          <span className="nf-field__label">{t("备注")}</span>
          <textarea
            className="nf-input"
            rows={2}
            value={note}
            placeholder={t("比如：这张构图最好、字太小")}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== a.note && onMark({ note })}
          />
        </label>
        <dl className="nf-gal__meta">
          <dt>{t("节点")}</dt>
          <dd>
            {a.nodeLabel || a.nodeId} <code>{a.nodeType}</code>
          </dd>
          <dt>{t("输出")}</dt>
          <dd>
            <code>{a.port}</code>
          </dd>
          <dt>{t("生成时间")}</dt>
          <dd>
            {new Date(a.createdAt).toLocaleString()}
            {a.single && <span className="nf-tag">{t("单独运行")}</span>}
            {a.rerunOf && <span className="nf-tag">{t("重跑")}</span>}
          </dd>
          <dt>{t("文件")}</dt>
          <dd>
            {a.mime}{t("，")}{sizeOf(a.size)}
            <br />
            <code className="nf-gal__path">{a.path}</code>
          </dd>
        </dl>
        {a.params && Object.keys(a.params).length > 0 && (
          <>
            <h4>{t("当时的参数（{0}）", [a.nodeLabel || a.nodeId])}</h4>
            <ParamTable params={a.params} />
          </>
        )}
        {(a.lineage ?? []).map((l) => (
          <div key={l.nodeId}>
            <h4>
              
              {t("上游")} {l.nodeLabel || l.nodeId} <code>{l.nodeType}</code>
            </h4>
            {l.params && Object.keys(l.params).length ? (
              <ParamTable params={l.params} />
            ) : (
              <p className="nf-muted">{t("这次运行没有记录它的参数（发生在记录参数功能上线之前）。")}</p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function show(v: unknown) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function ParamTable({ params, differs }: { params: Record<string, unknown>; differs?: Set<string> }) {
  const keys = Object.keys(params).filter((k) => k !== "code" || typeof params[k] !== "string" || (params[k] as string).length < 400);
  return (
    <dl className="nf-gal__params">
      {keys.map((k) => (
        <div key={k} data-diff={differs?.has(k) || undefined}>
          <dt>{k}</dt>
          <dd>{show(params[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Side by side, with the params that differ between them highlighted. */
function Compare({ items, onClose, onMark }: { items: Artifact[]; onClose: () => void; onMark: (path: string, m: Partial<Pick<Artifact, "starred" | "note">>) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const merged = items.map(allParams);
  const keys = [...new Set(merged.flatMap((p) => Object.keys(p)))];
  const differs = new Set(keys.filter((k) => new Set(merged.map((p) => JSON.stringify(p[k]))).size > 1));
  const sameNode = new Set(items.map((a) => a.nodeId)).size === 1;

  return (
    <div className="nf-cmp" role="dialog" aria-modal="true" aria-label={t("对比")}>
      <header className="nf-cmp__head">
        <h2>{t("对比 {0} 个结果", [items.length])}</h2>
        <span className="nf-muted">
          {merged.every((p) => !Object.keys(p).length)
            ? t("这些结果没有记录参数（发生在记录参数功能上线之前），只能看图对比")
            : merged.some((p) => !Object.keys(p).length)
              ? t("部分结果没有记录参数；其余参数的差异已高亮")
              : differs.size
                ? t("参数不同的地方已高亮：{0}", [[...differs].join("、")])
                : sameNode
                  ? t("参数完全相同（只是又生成了一次）")
                  : t("来自不同节点")}
        </span>
        <span className="nf-spacer" />
        <button className="nf-btn" onClick={onClose}>
          
          {t("关闭")}
        </button>
      </header>
      <div className="nf-cmp__cols" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((a) => (
          <section key={a.path} className="nf-cmp__col">
            <div className="nf-cmp__media" title={t("双击放大")} onDoubleClick={() => useStore.getState().openLightbox(items.map(toLightbox), items.indexOf(a))}>
              <Thumb a={a} big />
            </div>
            <div className="nf-cmp__info">
              <div className="nf-row">
                <button className="nf-btn" data-on={a.starred || undefined} onClick={() => onMark(a.path, { starred: !a.starred })}>
                  {a.starred ? t("★ 已标星") : t("☆ 标星")}
                </button>
                <span className="nf-muted">
                  {a.nodeLabel || a.nodeId}{t("，")}{when(a.createdAt)}
                </span>
              </div>
              {a.note && <p className="nf-gal__note">{a.note}</p>}
              <ParamTable params={allParams(a)} differs={differs} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
