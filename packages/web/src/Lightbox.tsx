import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent } from "react";
import { fileUrl } from "./api.ts";
import { useStore, type LightboxItem } from "./store.ts";
import { t } from "./i18n.ts";

const MIN = 0.05;
const MAX = 16;

/** Full-screen viewer: fit / 1:1, wheel zoom around the cursor, drag to pan, ← → between items. */
export function Lightbox() {
  const box = useStore((s) => s.lightbox);
  const close = useStore((s) => s.closeLightbox);
  const step = useStore((s) => s.stepLightbox);
  if (!box) return null;
  const item = box.items[box.index];
  return <Viewer key={item.path} item={item} index={box.index} count={box.items.length} onClose={close} onStep={step} />;
}

function Viewer({
  item,
  index,
  count,
  onClose,
  onStep,
}: {
  item: LightboxItem;
  index: number;
  count: number;
  onClose: () => void;
  onStep: (d: number) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0, fit: true });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const isImage = item.mime.startsWith("image/");
  const [failed, setFailed] = useState(false);

  const fitScale = useCallback(() => {
    const el = stage.current;
    if (!el || !natural) return 1;
    return Math.min(1, (el.clientWidth - 48) / natural.w, (el.clientHeight - 48) / natural.h);
  }, [natural]);

  const fit = useCallback(() => setView({ scale: fitScale(), x: 0, y: 0, fit: true }), [fitScale]);
  useEffect(() => {
    if (natural) fit();
  }, [natural, fit]);
  useEffect(() => {
    const onResize = () => view.fit && fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [view.fit, fit]);

  /** Zoom to `next`, keeping the point under (cx, cy) (relative to the stage centre) fixed. */
  const zoomAt = (next: number, cx = 0, cy = 0) =>
    setView((v) => {
      const s = Math.min(MAX, Math.max(MIN, next));
      const k = s / v.scale;
      return { scale: s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, fit: false };
    });

  const centreOffset = (clientX: number, clientY: number) => {
    const r = stage.current!.getBoundingClientRect();
    return { cx: clientX - r.left - r.width / 2, cy: clientY - r.top - r.height / 2 };
  };

  const toggle = (clientX?: number, clientY?: number) => {
    if (view.fit || Math.abs(view.scale - fitScale()) < 0.01) {
      const { cx, cy } = clientX !== undefined ? centreOffset(clientX, clientY!) : { cx: 0, cy: 0 };
      zoomAt(1, cx, cy);
    } else fit();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onStep(1);
      else if (e.key === "ArrowLeft") onStep(-1);
      else if (isImage && (e.key === "+" || e.key === "=")) zoomAt(view.scale * 1.25);
      else if (isImage && e.key === "-") zoomAt(view.scale / 1.25);
      else if (isImage && e.key === "0") fit();
      else if (isImage && e.key === "1") zoomAt(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onWheel = (e: WheelEvent) => {
    if (!isImage) return;
    const { cx, cy } = centreOffset(e.clientX, e.clientY);
    zoomAt(view.scale * Math.exp(-e.deltaY * 0.0015), cx, cy);
  };

  const onPointerDown = (e: RPointerEvent) => {
    if (!isImage || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y, fit: false }));
  };
  const onPointerUp = () => (drag.current = null);

  const url = /^https?:\/\//i.test(item.path) ? item.path : fileUrl(item.path);
  const pct = Math.round(view.scale * 100);

  return (
    <div className="nf-lb" role="dialog" aria-modal="true" aria-label={t("查看大图")}>
      <div
        ref={stage}
        className="nf-lb__stage"
        data-grab={isImage && !view.fit ? true : undefined}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={(e) => e.target === e.currentTarget && onClose()}
        onDoubleClick={(e) => isImage && toggle(e.clientX, e.clientY)}
      >
        {isImage ? (
          <img
            src={url}
            alt={item.title ?? ""}
            draggable={false}
            referrerPolicy="no-referrer"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            style={{
              width: natural ? natural.w * view.scale : undefined,
              transform: `translate(${view.x}px, ${view.y}px)`,
              visibility: natural ? "visible" : "hidden",
            }}
          />
        ) : item.mime.startsWith("video/") ? (
          <video src={url} controls autoPlay loop className="nf-lb__media" />
        ) : item.mime.startsWith("audio/") ? (
          <audio src={url} controls autoPlay />
        ) : (
          <p className="nf-lb__nopreview">{t("这种文件不能预览，点下面的「打开原文件」。")}</p>
        )}

        {failed && <p className="nf-lb__nopreview">{t("图片加载失败：链接可能已过期（Seedream 的链接 24 小时内有效）或没有访问权限。")}</p>}
        {count > 1 && (
          <>
            <button className="nf-lb__nav nf-lb__nav--prev" onClick={() => onStep(-1)} aria-label={t("上一张")}>
              ‹
            </button>
            <button className="nf-lb__nav nf-lb__nav--next" onClick={() => onStep(1)} aria-label={t("下一张")}>
              ›
            </button>
          </>
        )}
      </div>

      <footer className="nf-lb__bar">
        <div className="nf-lb__caption">
          {item.title && <p className="nf-lb__title">{item.title}</p>}
          <p className="nf-lb__meta">
            {count > 1 && `${index + 1} / ${count}　`}
            {natural && `${natural.w}×${natural.h}　`}
            {item.sub}
          </p>
        </div>
        {isImage && (
          <div className="nf-lb__zoom">
            <button onClick={() => zoomAt(view.scale / 1.25)} aria-label={t("缩小")}>−</button>
            <span>{pct}%</span>
            <button onClick={() => zoomAt(view.scale * 1.25)} aria-label={t("放大")}>+</button>
            <button onClick={fit} data-on={view.fit || undefined}>{t("适应窗口")}</button>
            <button onClick={() => zoomAt(1)} data-on={!view.fit && pct === 100 ? true : undefined}>
              1:1
            </button>
          </div>
        )}
        <a className="nf-lb__btn" href={url} target="_blank" rel="noreferrer">
          
          {t("打开原文件")}
        </a>
        <button className="nf-lb__btn" onClick={onClose}>
          
          {t("关闭")}
        </button>
      </footer>
    </div>
  );
}
