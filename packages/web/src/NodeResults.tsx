import { useEffect, useState } from "react";
import { fileUrl, type NodePreview } from "./api.ts";
import { useStore } from "./store.ts";

type FileRef = { $file: true; path: string; size: number; mime: string };
const isFile = (v: unknown): v is FileRef => !!v && typeof v === "object" && (v as FileRef).$file === true;

/** Every distinct file inside a result's outputs, in port order (`file` and `files[0]` are often the same). */
function filesIn(v: unknown): FileRef[] {
  const all = (x: unknown): FileRef[] =>
    isFile(x) ? [x] : Array.isArray(x) ? x.flatMap(all) : x && typeof x === "object" ? Object.values(x).flatMap(all) : [];
  const seen = new Set<string>();
  return all(v).filter((f) => !seen.has(f.path) && seen.add(f.path));
}

/** A short text for results without files (a number, a string, a small object). */
function summary(outputs: Record<string, unknown>): string {
  const [k, v] = Object.entries(outputs)[0] ?? [];
  if (k === undefined) return "（无输出）";
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
  if (!cur) return null;
  const files = filesIn(cur.outputs);
  const images = files.filter((f) => f.mime.startsWith("image/") || f.mime.startsWith("video/"));
  const isPinned = pinnedRunId === cur.runId;

  const enlarge = (f: FileRef) => {
    // All results' media in order, so ← → in the viewer walks through this node's history.
    const all = previews.flatMap((p) => filesIn(p.outputs).filter((x) => x.mime.startsWith("image/") || x.mime.startsWith("video/")).map((x) => ({ x, p })));
    openLightbox(
      all.map(({ x, p }) => ({ path: x.path, mime: x.mime, title: `${nodeId} 的结果${pinnedRunId === p.runId ? "（已选用）" : ""}`, sub: when(p.at) })),
      Math.max(0, all.findIndex(({ x }) => x.path === f.path)),
    );
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div className="nf-res nodrag nopan" data-pinned={isPinned || undefined} onClick={stop} onDoubleClick={stop}>
      {images.length ? (
        <div className="nf-res__media" data-count={Math.min(images.length, 4)}>
          {images.slice(0, 4).map((f) =>
            f.mime.startsWith("video/") ? (
              <video key={f.path} src={fileUrl(f.path)} muted preload="metadata" onDoubleClick={() => enlarge(f)} title="双击放大" />
            ) : (
              <img key={f.path} src={fileUrl(f.path)} alt="" draggable={false} onDoubleClick={() => enlarge(f)} title="双击放大" />
            ),
          )}
          {images.length > 4 && <span className="nf-res__more">+{images.length - 4}</span>}
        </div>
      ) : files.length ? (
        <p className="nf-res__text">{files.map((f) => f.path.split("/").pop()).join("、")}</p>
      ) : (
        <p className="nf-res__text">{summary(cur.outputs)}</p>
      )}
      <div className="nf-res__bar">
        <button disabled={i >= previews.length - 1} onClick={() => setI(i + 1)} aria-label="更早的结果" title="更早的结果">
          ‹
        </button>
        <span className="nf-res__pos" title={new Date(cur.at).toLocaleString()}>
          {previews.length > 1 ? `${i + 1}/${previews.length}　` : ""}
          {when(cur.at)}
        </span>
        <button disabled={i <= 0} onClick={() => setI(i - 1)} aria-label="更新的结果" title="更新的结果">
          ›
        </button>
        <span className="nf-spacer" />
        {isPinned ? (
          <button className="nf-res__pin" data-on onClick={() => pinResult(nodeId, null)} title="取消选用：运行时正常执行这个节点">
            已选用 ×
          </button>
        ) : (
          <button className="nf-res__pin" onClick={() => pinResult(nodeId, cur.runId)} title="选用这次的结果：运行时不再执行这个节点，下游用这个结果">
            选用
          </button>
        )}
      </div>
    </div>
  );
}
