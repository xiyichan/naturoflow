import { useEffect, useState } from "react";
import { api, type NodeTypeDef, type WorkflowNode } from "./api.ts";
import { t } from "./i18n.ts";
import { useStore } from "./store.ts";

const MIRROR_KEY = "naturoflow.hfMirror";

function readMirror() {
  try {
    return localStorage.getItem(MIRROR_KEY) ?? "";
  } catch {
    return "";
  }
}

const mb = (bytes?: number) => (bytes === undefined ? "" : `${Math.round(bytes / 1e6)} MB`);

/**
 * Models a node type needs, shown on its panel: download on request (with progress), cancel,
 * delete. Nothing downloads until someone clicks here (or an AI calls download_model).
 */
export function ModelPanel({ def, node }: { def: NodeTypeDef; node: WorkflowNode }) {
  const models = useStore((s) => s.models);
  const setModels = useStore((s) => s.setModels);
  const notify = useStore((s) => s.notify);
  const [mirror, setMirror] = useState(readMirror);
  const [showMirror, setShowMirror] = useState(() => !!readMirror());

  useEffect(() => {
    api.models(def.id).then(setModels).catch(() => {});
  }, [def.id, setModels]);

  const specs = def.models ?? [];
  const props = (def.params.properties ?? {}) as Record<string, { default?: unknown }>;
  const chosenId = String(node.params.model ?? props.model?.default ?? specs[0]?.id);
  const fromHf = specs.some((m) => m.url.startsWith("https://huggingface.co"));

  const saveMirror = (v: string) => {
    setMirror(v);
    try {
      if (v.trim()) localStorage.setItem(MIRROR_KEY, v.trim());
      else localStorage.removeItem(MIRROR_KEY);
    } catch {
      // storage unavailable: applies to this page only
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      notify("error", (e as Error).message);
    }
  };

  return (
    <section className="nf-models" aria-label={t("模型")}>
      <h4>{t("模型")}</h4>
      <ul>
        {specs.map((spec) => {
          const st = models[spec.id];
          const p = st?.progress;
          const pct = p?.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : undefined;
          const inUse = spec.id === chosenId;
          return (
            <li key={spec.id} data-in-use={inUse || undefined}>
              <div className="nf-models__row">
                <div className="nf-models__name">
                  <strong>{spec.name ?? spec.id}</strong>
                  <span className="nf-muted">
                    {st?.downloaded ? mb(st.bytes) : spec.size ? t("约 {0} MB", [spec.size]) : ""}
                    {inUse ? t("，当前节点使用") : ""}
                  </span>
                </div>
                {!st ? (
                  <span className="nf-muted">{t("检查中…")}</span>
                ) : st.downloaded ? (
                  <>
                    <span className="nf-models__ok">{t("✓ 已下载")}</span>
                    <button
                      className="nf-btn nf-btn--ghost"
                      onClick={() => confirm(t("删除模型 {0}？之后要用时需要重新下载。", [st.name])) && act(() => api.deleteModel(spec.id))}
                    >
                      {t("删除")}
                    </button>
                  </>
                ) : p ? (
                  <button className="nf-btn nf-btn--ghost" onClick={() => act(() => api.cancelModel(spec.id))}>
                    {t("取消")}
                  </button>
                ) : (
                  <button className={`nf-btn${inUse ? " nf-btn--primary" : ""}`} onClick={() => act(() => api.downloadModel(spec.id, mirror.trim() || undefined).then((m) => setModels([m])))}>
                    {t("下载模型")}
                  </button>
                )}
              </div>
              {p && (
                <div className="nf-models__progress">
                  <progress max={100} value={pct} aria-label={t("下载进度")} />
                  <span className="nf-muted">
                    {pct !== undefined ? `${pct}%` : ""} {mb(p.received)}
                    {p.total ? ` / ${mb(p.total)}` : ""}
                  </span>
                </div>
              )}
              {st?.error && !p && <p className="nf-field__error">{st.error === "cancelled" ? t("已取消下载") : t("下载失败：{0}", [st.error])}</p>}
            </li>
          );
        })}
      </ul>
      {fromHf &&
        (showMirror ? (
          <label className="nf-field">
            <span className="nf-field__label">{t("下载镜像（可选）")}</span>
            <input className="nf-input nf-code" value={mirror} placeholder="https://hf-mirror.com" onChange={(e) => saveMirror(e.target.value)} />
            <small className="nf-field__help">{t("替换 huggingface.co，国内下载慢时可以填。")}</small>
          </label>
        ) : (
          <button className="nf-link nf-models__mirror" onClick={() => setShowMirror(true)}>
            {t("下载慢？使用镜像")}
          </button>
        ))}
    </section>
  );
}
