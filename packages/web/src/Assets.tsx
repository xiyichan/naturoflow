import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, fileUrl, type Artifact, type UploadedFile } from "./api.ts";
import { MasonryItem } from "./Masonry.tsx";
import { useStore } from "./store.ts";
import { t } from "./i18n.ts";

/** Drag payload for a file going onto the canvas. */
export const DND_FILE = "application/x-naturoflow-file";
export interface DraggedFile {
  path: string;
  mime: string;
  name: string;
}

type Item = DraggedFile & { key: string; caption: string; sub?: string; starred?: boolean };
type Scope = "workflow" | "all" | "uploads";

function fromArtifact(a: Artifact): Item {
  const prompt = [a.params, ...(a.lineage ?? []).map((l) => l.params)]
    .map((p) => p?.prompt)
    .find((v) => typeof v === "string" && v) as string | undefined;
  return {
    key: a.path,
    path: a.path,
    mime: a.mime,
    name: a.path.split("/").pop() ?? a.path,
    caption: a.nodeLabel || a.nodeId,
    sub: prompt,
    starred: a.starred,
  };
}

/** Node title for a dropped asset: the prompt that made it reads better than a hash filename. */
function label(it: Item) {
  return it.sub ? (it.sub.length > 18 ? `${it.sub.slice(0, 18)}…` : it.sub) : it.name;
}

function fromUpload(u: UploadedFile): Item {
  return { key: u.path, path: u.path, mime: u.mime, name: u.name, caption: u.name };
}

/** Recent generated files and uploads, ready to drag onto the canvas or onto a node's input. */
export function Assets({ onAdd }: { onAdd: (files: DraggedFile[]) => void }) {
  const workflowId = useStore((s) => s.workflow?.id);
  const version = useStore((s) => s.artifactsVersion);
  const notify = useStore((s) => s.notify);
  const [scope, setScope] = useState<Scope>("workflow");
  const [starred, setStarred] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [uploadsVersion, setUploadsVersion] = useState(0);
  const openLightbox = useStore((s) => s.openLightbox);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (scope === "uploads") return (await api.uploads()).map(fromUpload);
      if (scope === "all") return (await api.allArtifacts({ starred })).map(fromArtifact);
      if (!workflowId) return [];
      return (await api.artifacts(workflowId, { starred, limit: 80 })).items.map(fromArtifact);
    };
    load().then((l) => !cancelled && setItems(l));
    return () => {
      cancelled = true;
    };
  }, [scope, starred, workflowId, version, uploadsVersion]);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const saved = await api.upload(files);
      notify("info", t("已上传 {0} 个文件，拖到画布上就能使用", [saved.length]));
      setScope("uploads");
      setUploadsVersion((v) => v + 1);
    } catch (e) {
      notify("error", t("上传失败：{0}", [(e as Error).message]));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDropping(false);
    upload([...e.dataTransfer.files]);
  };

  return (
    <div
      className="nf-assets"
      data-dropping={dropping || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div className="nf-assets__top">
        <div className="nf-seg" role="radiogroup" aria-label={t("素材范围")}>
          {(
            [
              ["workflow", t("本工作流")],
              ["all", t("全部")],
              ["uploads", t("上传的")],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="radio" aria-checked={scope === k} onClick={() => setScope(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="nf-assets__row">
          {scope !== "uploads" && (
            <label className="nf-gal__star-filter">
              <input type="checkbox" checked={starred} onChange={(e) => setStarred(e.target.checked)} />  {t("只看标星")}
            </label>
          )}
          <span className="nf-spacer" />
          <button className="nf-btn nf-btn--ghost" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? t("上传中…") : t("上传文件")}
          </button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              upload([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>
        <p className="nf-pal__hint nf-assets__hint">{t("拖到画布上使用，拖到节点上会自动接到它的文件输入；点 ＋ 直接添加，双击放大查看。也可以把电脑里的文件拖进来。")}</p>
      </div>

      {items && items.length === 0 ? (
        <p className="nf-muted nf-assets__empty">
          {scope === "uploads" ? t("还没有上传过文件。") : starred ? t("没有标星的文件。") : t("还没有生成过文件。")}
        </p>
      ) : (
        <ul className="nf-assets__grid nf-masonry">
          {items?.map((it) => (
            <MasonryItem key={it.key} gap={8}>
              <div
                className="nf-assets__item"
                draggable
                tabIndex={0}
                title={t("{0}\n{1}\n拖到画布使用，双击放大", [it.sub ?? it.caption, it.path])}
                onDragStart={(e) => {
                  const payload: DraggedFile = { path: it.path, mime: it.mime, name: label(it) };
                  e.dataTransfer.setData(DND_FILE, JSON.stringify(payload));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() =>
                  openLightbox(
                    items.map((x) => ({ path: x.path, mime: x.mime, title: x.sub, sub: x.caption })),
                    items.indexOf(it),
                  )
                }
                onKeyDown={(e) => e.key === "Enter" && onAdd([{ path: it.path, mime: it.mime, name: label(it) }])}
              >
                <span className="nf-assets__media">
                  {it.mime.startsWith("image/") ? (
                    <img src={fileUrl(it.path)} alt="" loading="lazy" draggable={false} />
                  ) : it.mime.startsWith("video/") ? (
                    <video src={fileUrl(it.path)} preload="metadata" muted />
                  ) : (
                    <span className="nf-gal__icon">{it.name.split(".").pop()?.toUpperCase()}</span>
                  )}
                  {it.starred && <i className="nf-assets__star">★</i>}
                  <button
                    className="nf-assets__add"
                    title={t("添加到画布")}
                    aria-label={t("添加到画布")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAdd([{ path: it.path, mime: it.mime, name: label(it) }]);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    ＋
                  </button>
                </span>
                <span className="nf-assets__cap">{it.sub || it.caption}</span>
              </div>
            </MasonryItem>
          ))}
        </ul>
      )}
    </div>
  );
}
