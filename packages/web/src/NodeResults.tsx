import { useEffect, useRef, useState } from "react";
import { fileUrl, type NodePreview } from "./api.ts";
import { useStore } from "./store.ts";
import { t } from "./i18n.ts";

type FileRef = { $file: true; path: string; size: number; mime: string };
const isFile = (v: unknown): v is FileRef => !!v && typeof v === "object" && (v as FileRef).$file === true;

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|avif|mp4|webm|mov)$/i;

/** Something to show: a local file (served by the API) or a remote image/video URL. */
export interface Media {
  /** Local path, or the full http(s) URL for remote media. */
  path: string;
  mime: string;
  remote?: boolean;
}

/**
 * Every distinct image/video in a result: local files, or — when there are none — http(s) links
 * whose path ends in a media extension (e.g. Seedream / S3 links, which carry signature queries).
 */
export function mediaIn(v: unknown): Media[] {
  const out: Media[] = [];
  const seen = new Set<string>();
  const add = (m: Media) => !seen.has(m.path) && (seen.add(m.path), out.push(m));
  const walk = (x: unknown) => {
    if (isFile(x)) {
      if (x.mime.startsWith("image/") || x.mime.startsWith("video/")) add({ path: x.path, mime: x.mime });
    } else if (typeof x === "string" && /^https?:\/\//i.test(x)) {
      try {
        const ext = MEDIA_EXT.exec(new URL(x).pathname)?.[1]?.toLowerCase();
        if (ext) add({ path: x, mime: /mp4|webm|mov/.test(ext) ? "video/mp4" : "image/*", remote: true });
      } catch {
        // not a URL
      }
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(v);
  // A node that saved its images locally (e.g. Seedream) also outputs their links: show only the
  // local copies then, so each image appears once. Links are shown only when nothing was saved.
  const local = out.filter((m) => !m.remote);
  return local.length ? local : out;
}

/** Local files (any type) in a result, for a text fallback. */
function filesIn(v: unknown): FileRef[] {
  const all = (x: unknown): FileRef[] =>
    isFile(x) ? [x] : Array.isArray(x) ? x.flatMap(all) : x && typeof x === "object" ? Object.values(x).flatMap(all) : [];
  const seen = new Set<string>();
  return all(v).filter((f) => !seen.has(f.path) && seen.add(f.path));
}

export const mediaSrc = (m: Media) => (m.remote ? m.path : fileUrl(m.path));

/** A short text for results without files (a number, a string, a small object). */
function summary(outputs: Record<string, unknown>): string {
  const [k, v] = Object.entries(outputs)[0] ?? [];
  if (k === undefined) return t("（无输出）");
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return `${Object.keys(outputs).length > 1 ? `${k}: ` : ""}${text ?? ""}`.slice(0, 160);
}

function when(ts: number) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

/**
 * Results on a node card: the chosen (pinned) or latest result, ‹ › to flip through earlier ones,
 * double-click to enlarge, and 选用 to make a result the one this node passes on.
 */
export function NodeResults({ nodeId, previews, pinnedRunId }: { nodeId: string; previews: NodePreview[]; pinnedRunId?: string }) {
  const pinResult = useStore((s) => s.pinResult);
  const openLightbox = useStore((s) => s.openLightbox);
  const startAt = () => Math.max(0, pinnedRunId ? previews.findIndex((p) => p.runId === pinnedRunId) : 0);
  const [i, setI] = useState(startAt);
  // Jump to the newest result when a new one arrives (or to the chosen one when pinning changes).
  const newest = previews[0]?.runId;
  useEffect(() => setI(startAt()), [newest, pinnedRunId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = previews[Math.min(i, previews.length - 1)];
  // Remote links that fail to load (expired, private) fall back to the text summary.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  if (!cur) return null;
  const files = filesIn(cur.outputs);
  const images = mediaIn(cur.outputs).filter((m) => !broken.has(m.path));
  const isPinned = pinnedRunId === cur.runId;
  const pinnedIdx = pinnedRunId ? previews.findIndex((p) => p.runId === pinnedRunId) : -1;

  const enlarge = (m: Media) => {
    // All results' media in order, so ← → in the viewer walks through this node's history.
    const all = previews.flatMap((p) => mediaIn(p.outputs).filter((x) => !broken.has(x.path)).map((x) => ({ x, p })));
    openLightbox(
      all.map(({ x, p }) => ({ path: x.path, mime: x.mime, title: t("{0} 的结果{1}", [nodeId, pinnedRunId === p.runId ? t("（已选用）") : ""]), sub: when(p.at) })),
      Math.max(0, all.findIndex(({ x }) => x.path === m.path)),
    );
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const markBroken = (path: string) => setBroken((b) => new Set(b).add(path));

  return (
    <div className="nf-res nodrag nopan" data-pinned={isPinned || undefined} onClick={stop} onDoubleClick={stop}>
      {images.length ? (
        <div className="nf-res__media" data-count={Math.min(images.length, 4)}>
          {images.slice(0, 4).map((m) =>
            m.mime.startsWith("video/") ? (
              <video key={m.path} src={mediaSrc(m)} muted preload="metadata" onDoubleClick={() => enlarge(m)} onError={() => markBroken(m.path)} title={t("双击放大")} />
            ) : (
              <img
                key={m.path}
                src={mediaSrc(m)}
                alt=""
                draggable={false}
                referrerPolicy="no-referrer"
                onDoubleClick={() => enlarge(m)}
                onError={() => markBroken(m.path)}
                title={m.remote ? t("双击放大（网络图片）") : t("双击放大")}
              />
            ),
          )}
          {images.length > 4 && <span className="nf-res__more">+{images.length - 4}</span>}
        </div>
      ) : files.length ? (
        <p className="nf-res__text">{files.map((f) => f.path.split("/").pop()).join("、")}</p>
      ) : (
        <p className="nf-res__text">{summary(cur.outputs)}</p>
      )}
      {previews.length > 1 && (
        <HistoryStrip previews={previews} current={i} pinnedRunId={pinnedRunId} broken={broken} onPick={setI} />
      )}
      {pinnedRunId && !isPinned && (
        <p className="nf-res__note">
          
          {t("正在看的不是选用的结果，下游用的仍是 ★ 那次")}
          {pinnedIdx >= 0 && (
            <button onClick={() => setI(pinnedIdx)} title={t("回到选用的那次")}>
              
              {t("查看")}
            </button>
          )}
        </p>
      )}
      <div className="nf-res__bar">
        <button disabled={i >= previews.length - 1} onClick={() => setI(i + 1)} aria-label={t("更早的结果")} title={t("更早的结果")}>
          ‹
        </button>
        <span className="nf-res__pos" title={new Date(cur.at).toLocaleString()}>
          {previews.length > 1 ? `${i + 1}/${previews.length}　` : ""}
          {when(cur.at)}
        </span>
        <button disabled={i <= 0} onClick={() => setI(i - 1)} aria-label={t("更新的结果")} title={t("更新的结果")}>
          ›
        </button>
        <span className="nf-spacer" />
        {isPinned ? (
          <button className="nf-res__pin" data-on onClick={() => pinResult(nodeId, null)} title={t("取消选用：运行时正常执行这个节点")}>
            
            {t("已选用 ×")}
          </button>
        ) : (
          <button className="nf-res__pin" onClick={() => pinResult(nodeId, cur.runId)} title={t("选用这次的结果：运行时不再执行这个节点，下游用这个结果")}>
            {pinnedRunId ? t("改用这次") : t("选用")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Every past result as a thumbnail; click one to show it (then 选用 it if wanted). */
function HistoryStrip({
  previews,
  current,
  pinnedRunId,
  broken,
  onPick,
}: {
  previews: NodePreview[];
  current: number;
  pinnedRunId?: string;
  broken: Set<string>;
  onPick: (i: number) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // Thumbnails whose link no longer loads (expired / private) show as numbered chips instead.
  const [failed, setFailed] = useState<Set<string>>(new Set());
  // Keep the shown result in view as it changes.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>("[data-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <div ref={strip} className="nf-res__strip nowheel" role="listbox" aria-label={t("历史结果")}>
      {previews.map((p, idx) => {
        const m = mediaIn(p.outputs).find((x) => !broken.has(x.path) && !failed.has(x.path));
        return (
          <button
            key={p.runId}
            role="option"
            aria-selected={idx === current}
            data-current={idx === current || undefined}
            data-pinned={p.runId === pinnedRunId || undefined}
            title={`${new Date(p.at).toLocaleString()}${p.runId === pinnedRunId ? t("（已选用）") : ""}`}
            onClick={() => onPick(idx)}
          >
            {m && !m.mime.startsWith("video/") ? (
              <img
                src={mediaSrc(m)}
                alt=""
                draggable={false}
                referrerPolicy="no-referrer"
                onError={() => setFailed((f) => new Set(f).add(m.path))}
              />
            ) : m ? (
              <video src={mediaSrc(m)} muted preload="metadata" />
            ) : (
              <span>{previews.length - idx}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
