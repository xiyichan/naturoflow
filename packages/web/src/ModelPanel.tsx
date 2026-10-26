import { useEffect, useState } from "react";
import { api, type CredentialInfo, type NodeTypeDef, type WorkflowNode } from "./api.ts";
import { modelErrorText, t } from "./i18n.ts";
import { useStore } from "./store.ts";

const MIRROR_KEY = "naturoflow.hfMirror";

function readMirror() {
  try {
    return localStorage.getItem(MIRROR_KEY) ?? "";
  } catch {
    return "";
  }
}

const HF_TYPE = "huggingface";

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
  const credVersion = useStore((s) => s.credVersion);
  const [hfCreds, setHfCreds] = useState<CredentialInfo[] | null>(null);

  useEffect(() => {
    api.models(def.id).then(setModels).catch(() => {});
  }, [def.id, setModels]);

  const specs = def.models ?? [];
  const needsToken = specs.some((m) => m.gated);
  useEffect(() => {
    if (needsToken) api.credentials(HF_TYPE).then(setHfCreds).catch(() => setHfCreds([]));
  }, [needsToken, credVersion]);
  const hasToken = !!hfCreds?.length;
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
                  {spec.license && <License spec={spec} />}
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
                  <button
                    className={`nf-btn${inUse ? " nf-btn--primary" : ""}`}
                    disabled={spec.gated && !hasToken}
                    title={spec.gated && !hasToken ? t("先在下面保存 Hugging Face token") : undefined}
                    onClick={() => act(() => api.downloadModel(spec.id, spec.gated ? undefined : mirror.trim() || undefined).then((m) => setModels([m])))}
                  >
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
              {st?.error && !p && <p className="nf-field__error">{modelErrorText(st.error)}</p>}
            </li>
          );
        })}
      </ul>
      {needsToken && hfCreds && <HfToken creds={hfCreds} page={specs.find((m) => m.gated)?.page} onError={(m) => notify("error", m)} />}
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

function License({ spec }: { spec: { license?: string; licenseUrl?: string; commercial?: boolean } }) {
  const text = spec.commercial === false ? t("仅限非商用 · {0}", [spec.license ?? ""]) : spec.commercial ? t("可商用 · {0}", [spec.license ?? ""]) : spec.license;
  return (
    <span className="nf-models__license" data-nc={spec.commercial === false || undefined}>
      {spec.licenseUrl ? (
        <a href={spec.licenseUrl} target="_blank" rel="noreferrer">
          {text}
        </a>
      ) : (
        text
      )}
    </span>
  );
}

/** The saved Hugging Face access token (encrypted like any credential), for gated models. */
function HfToken({ creds, page, onError }: { creds: CredentialInfo[]; page?: string; onError: (msg: string) => void }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const cur = creds[0];

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      if (cur) await api.updateCredential(cur.id, { data: { token: value.trim() } });
      else await api.createCredential(HF_TYPE, "Hugging Face", { token: value.trim() });
      setValue("");
      setEditing(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nf-models__token">
      <span className="nf-field__label">{t("Hugging Face token")}</span>
      {cur && !editing ? (
        <div className="nf-models__row">
          <span className="nf-models__ok">{t("✓ 已保存（加密）")}</span>
          <span className="nf-spacer" />
          <button className="nf-btn nf-btn--ghost" onClick={() => setEditing(true)}>
            {t("更换")}
          </button>
          <button
            className="nf-btn nf-btn--ghost"
            onClick={() => confirm(t("删除保存的 Hugging Face token？")) && api.deleteCredential(cur.id).catch((e) => onError((e as Error).message))}
          >
            {t("删除")}
          </button>
        </div>
      ) : (
        <div className="nf-models__row">
          <input
            className="nf-input nf-code"
            type="password"
            autoComplete="off"
            placeholder="hf_..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            aria-label={t("Hugging Face token")}
          />
          <button className="nf-btn" disabled={busy || !value.trim()} onClick={save}>
            {t("保存")}
          </button>
          {cur && (
            <button className="nf-btn nf-btn--ghost" onClick={() => setEditing(false)}>
              {t("取消")}
            </button>
          )}
        </div>
      )}
      <small className="nf-field__help">
        {page && (
          <>
            {t("需要先登录 Hugging Face，在")}{" "}
            <a href={page} target="_blank" rel="noreferrer">
              {t("模型页面")}
            </a>{" "}
            {t("同意使用条款；")}
          </>
        )}
        {t("token 在")}{" "}
        <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
          huggingface.co/settings/tokens
        </a>{" "}
        {t("创建，Read 权限即可。只发给 huggingface.co，不会发给镜像。")}
      </small>
    </div>
  );
}
