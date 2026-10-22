import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import YAML from "yaml";
import { api, ApiError } from "./api.ts";
import { parseCurl } from "./curl.ts";
import {
  emptyState,
  fromCurl,
  idFrom,
  liveRequest,
  outputType,
  pathText,
  previewPollUrl,
  slug,
  toDef,
  type BuilderState,
  type Field,
  type FieldMode,
  type Output,
  type Path,
  type ValueType,
} from "./httpBuilder.ts";
import { t } from "./i18n.ts";
import { useStore } from "./store.ts";

interface Probe {
  status?: number;
  ok?: boolean;
  ms?: number;
  body?: unknown;
  error?: string;
}

const CATEGORIES: [string, string][] = [
  ["network", t("网络")],
  ["ai", t("AI 模型")],
  ["media", t("媒体")],
  ["data", t("数据")],
  ["general", t("其他")],
];

/** Make a custom HTTP node without writing YAML: paste curl, choose params, outputs, polling. */
export function HttpBuilder() {
  const editor = useStore((s) => s.editor);
  const setEditor = useStore((s) => s.setEditor);
  const notify = useStore((s) => s.notify);
  const loadNodeTypes = useStore((s) => s.loadNodeTypes);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = editor?.mode === "http";

  const [s, setS] = useState<BuilderState>(emptyState);
  const [curl, setCurl] = useState("");
  const [curlNote, setCurlNote] = useState<{ error?: boolean; text: string } | null>(null);
  const [idTouched, setIdTouched] = useState(false);
  const [submit, setSubmit] = useState<Probe | null>(null);
  const [pollProbe, setPollProbe] = useState<Probe | null>(null);
  const [busy, setBusy] = useState<"" | "submit" | "poll" | "save">("");
  const [saveKey, setSaveKey] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return dialog.current?.close();
    setS(emptyState());
    setCurl("");
    setCurlNote(null);
    setIdTouched(false);
    setSubmit(null);
    setPollProbe(null);
    setError(null);
    dialog.current?.showModal();
  }, [open]);

  const up = (patch: Partial<BuilderState>) => setS((cur) => ({ ...cur, ...patch }));
  const upPoll = (patch: Partial<BuilderState["poll"]>) => setS((cur) => ({ ...cur, poll: { ...cur.poll, ...patch } }));
  const upAuth = (patch: Partial<BuilderState["auth"]>) => setS((cur) => ({ ...cur, auth: { ...cur.auth, ...patch } }));
  const upField = (i: number, patch: Partial<Field>) => setS((cur) => ({ ...cur, fields: cur.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const upOutput = (i: number, patch: Partial<Output>) => setS((cur) => ({ ...cur, outputs: cur.outputs.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));

  const importCurl = () => {
    try {
      const req = parseCurl(curl);
      const next = fromCurl(req, { ...s, id: idTouched ? s.id : "", name: s.name });
      setS(next);
      setSubmit(null);
      setPollProbe(null);
      setCurlNote({
        text:
          t("已识别：{0} 个参数{1}", [next.fields.length, next.auth.enabled ? t("，API Key 在请求头 {0}", [next.auth.header]) : ""]) +
          (req.ignored.length ? t("。暂不支持上传文件的写法，已忽略：{0}", [req.ignored.join(" ")]) : ""),
      });
    } catch (e) {
      setCurlNote({ error: true, text: t("无法解析：{0}", [(e as Error).message]) });
    }
  };

  const send = async (which: "submit" | "poll") => {
    setBusy(which);
    try {
      const req =
        which === "submit"
          ? liveRequest(s)
          : { method: "GET", url: previewPollUrl(s, submit?.body), headers: (({ ["Content-Type"]: _c, ...h }) => h)(liveRequest(s).headers) };
      const res = (await api.probe(req)) as Probe;
      (which === "submit" ? setSubmit : setPollProbe)(res);
    } catch (e) {
      (which === "submit" ? setSubmit : setPollProbe)({ error: (e as Error).message });
    } finally {
      setBusy("");
    }
  };

  const addOutput = (from: Output["from"], path: Path, value: unknown) => {
    const taken = new Set(s.outputs.map((o) => o.name));
    const keys = path.filter((k) => typeof k === "string") as string[];
    let name = slug(keys.at(-1) ?? "result");
    for (let i = 2; taken.has(name); i++) name = `${slug(keys.at(-1) ?? "result")}_${i}`;
    up({ outputs: [...s.outputs, { name, from, path, type: outputType(value) }] });
  };

  const def = useMemo(() => toDef(s), [s]);
  const yaml = useMemo(() => YAML.stringify(def), [def]);

  const problems = [
    !s.name.trim() && t("填写节点名称"),
    !/^[a-zA-Z0-9_.-]+$/.test(s.id) && t("节点 id 只能包含字母、数字和 _ . -"),
    !/^https?:\/\//.test(s.url) && t("填写请求地址（http 或 https 开头）"),
    s.poll.enabled && !/^https?:\/\//.test(s.poll.url) && t("填写查询状态的地址"),
    s.poll.enabled && !s.poll.done.trim() && t("填写表示完成的状态值"),
    new Set(s.fields.filter((f) => f.mode !== "fixed").map((f) => f.name)).size !== s.fields.filter((f) => f.mode !== "fixed").length && t("参数和输入端口的名字不能重复"),
  ].filter(Boolean) as string[];

  const save = async () => {
    if (problems.length) return setError(problems[0]);
    setBusy("save");
    setError(null);
    try {
      const saved = await api.createNodeType(def);
      if (s.auth.enabled && saveKey && s.auth.secret) {
        await api.createCredential(saved.id, t("来自 curl"), { api_key: s.auth.secret });
      }
      await loadNodeTypes();
      notify("info", t("已创建节点 {0}，在节点库里拖到画布上就能用", [s.name]));
      setEditor(null);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === "CONFLICT" ? t("id “{0}” 已被占用，换一个 id 再保存", [s.id]) : err.message);
    } finally {
      setBusy("");
    }
  };

  const tidKey = s.poll.url.match(/\{\{\s*submit\.body\.?([^}|\s]*)\s*\}\}/)?.[1];

  return (
    <dialog ref={dialog} className="nf-dialog nf-hb" onClose={() => setEditor(null)} aria-labelledby="hb-title">
      <header className="nf-dialog__head">
        <h2 id="hb-title">{t("新建 HTTP 节点")}</h2>
        <button className="nf-btn nf-btn--ghost" onClick={() => setEditor(null)}>
          {t("关闭")}
        </button>
      </header>

      <div className="nf-hb__body">
        <Section title={t("从 curl 导入")} hint={t("API 文档里的请求示例，或浏览器开发者工具里「复制为 cURL」。可选，也可以直接在下面填写。")}>
          <textarea
            className="nf-input nf-code"
            rows={4}
            spellCheck={false}
            placeholder={`curl -X POST https://api.example.com/v1/tasks \\\n  -H "Authorization: Bearer sk-..." \\\n  -d '{"prompt": "a cat"}'`}
            value={curl}
            onChange={(e) => setCurl(e.target.value)}
          />
          <div className="nf-row">
            <button className="nf-btn" onClick={importCurl} disabled={!curl.trim()}>
              {t("解析 curl")}
            </button>
            {curlNote && <span className={curlNote.error ? "nf-field__error" : "nf-muted"}>{curlNote.text}</span>}
          </div>
        </Section>

        <Section title={t("基本信息")}>
          <div className="nf-hb__grid">
            <Labeled label={t("名称")}>
              <input
                className="nf-input"
                value={s.name}
                placeholder={t("例如：Seedance 生成视频")}
                onChange={(e) => up({ name: e.target.value, ...(idTouched ? {} : { id: idFrom(e.target.value) }) })}
              />
            </Labeled>
            <Labeled label="id">
              <input
                className="nf-input nf-code"
                value={s.id}
                onChange={(e) => {
                  setIdTouched(true);
                  up({ id: e.target.value });
                }}
              />
            </Labeled>
            <Labeled label={t("分类")}>
              <select className="nf-input" value={s.category} onChange={(e) => up({ category: e.target.value })}>
                {CATEGORIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Labeled>
          </div>
          <Labeled label={t("说明（可选）")}>
            <input className="nf-input" value={s.description} onChange={(e) => up({ description: e.target.value })} />
          </Labeled>
        </Section>

        <Section title={t("请求")}>
          <div className="nf-hb__req">
            <select className="nf-input" value={s.method} onChange={(e) => up({ method: e.target.value })} aria-label={t("请求方法")}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <input className="nf-input nf-code" value={s.url} placeholder="https://api.example.com/v1/..." onChange={(e) => up({ url: e.target.value })} aria-label={t("请求地址")} />
          </div>

          <h4>{t("API Key")}</h4>
          <label className="nf-hb__check">
            <input type="checkbox" className="nf-check" checked={s.auth.enabled} onChange={(e) => upAuth({ enabled: e.target.checked })} />
            {t("需要 API Key（保存为凭据，不会写进节点定义）")}
          </label>
          {s.auth.enabled && (
            <>
              <div className="nf-hb__grid">
                <Labeled label={t("放在哪个请求头")}>
                  <input className="nf-input nf-code" value={s.auth.header} onChange={(e) => upAuth({ header: e.target.value })} />
                </Labeled>
                <Labeled label={t("前缀")}>
                  <input className="nf-input nf-code" value={s.auth.prefix} placeholder="Bearer " onChange={(e) => upAuth({ prefix: e.target.value })} />
                </Labeled>
                <Labeled label={t("Key（测试请求时使用）")}>
                  <input className="nf-input nf-code" type="password" autoComplete="off" value={s.auth.secret} onChange={(e) => upAuth({ secret: e.target.value })} />
                </Labeled>
              </div>
              {s.auth.secret && (
                <label className="nf-hb__check">
                  <input type="checkbox" className="nf-check" checked={saveKey} onChange={(e) => setSaveKey(e.target.checked)} />
                  {t("保存节点时，把这个 Key 存为一条凭据")}
                </label>
              )}
            </>
          )}

          <h4>{t("其他请求头")}</h4>
          {s.headers.map((h, i) => (
            <div key={i} className="nf-hb__kv">
              <input className="nf-input nf-code" value={h.key} placeholder={t("名称")} onChange={(e) => up({ headers: s.headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
              <input className="nf-input nf-code" value={h.value} placeholder={t("值")} onChange={(e) => up({ headers: s.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              <button className="nf-btn nf-btn--ghost" onClick={() => up({ headers: s.headers.filter((_, j) => j !== i) })} aria-label={t("删除")}>
                ×
              </button>
            </div>
          ))}
          <button className="nf-btn nf-btn--ghost nf-hb__add" onClick={() => up({ headers: [...s.headers, { key: "", value: "" }] })}>
            {t("＋ 添加请求头")}
          </button>

          {s.bodyKind === "text" && (
            <Labeled label={t("请求体（原文发送，可以写 {{params.名字}}）")}>
              <textarea className="nf-input nf-code" rows={4} value={s.bodyText} onChange={(e) => up({ bodyText: e.target.value })} />
            </Labeled>
          )}
        </Section>

        <Section
          title={t("参数")}
          hint={t("请求里的每个值可以：固定不变；做成参数（在节点上填写，默认是现在的值）；或做成输入端口（从上游节点接进来，比如图片地址、提示词）。")}
        >
          {s.fields.length === 0 ? (
            <p className="nf-muted">{t("先在上面粘贴 curl，请求体和地址里的值会列在这里。")}</p>
          ) : (
            <table className="nf-hb__fields">
              <thead>
                <tr>
                  <th>{t("位置")}</th>
                  <th>{t("用作")}</th>
                  <th>{t("名字")}</th>
                  <th>{t("类型")}</th>
                  <th>{t("值 / 默认值")}</th>
                  <th>{t("必填")}</th>
                </tr>
              </thead>
              <tbody>
                {s.fields.map((f, i) => (
                  <tr key={`${f.where}:${pathText(f.path)}`}>
                    <td>
                      <code>{f.where === "query" ? `?${pathText(f.path)}` : pathText(f.path) || t("（整个请求体）")}</code>
                    </td>
                    <td>
                      <div className="nf-seg nf-hb__mode" role="radiogroup">
                        {(
                          [
                            ["fixed", t("固定")],
                            ["param", t("参数")],
                            ["input", t("输入")],
                          ] as [FieldMode, string][]
                        ).map(([m, l]) => (
                          <button key={m} role="radio" aria-checked={f.mode === m} onClick={() => upField(i, { mode: m, ...(m === "input" && f.mode !== "input" ? { required: true } : {}) })}>
                            {l}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td>
                      <input className="nf-input nf-code" value={f.name} disabled={f.mode === "fixed"} onChange={(e) => upField(i, { name: slug(e.target.value) })} />
                    </td>
                    <td>
                      <select className="nf-input" value={f.type} onChange={(e) => upField(i, { type: e.target.value as ValueType })}>
                        {(["string", "number", "integer", "boolean", "json"] as ValueType[]).map((v) => (
                          <option key={v} value={v}>
                            {TYPE_NAMES()[v]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <ValueInput field={f} onChange={(value) => upField(i, { value })} />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        className="nf-check"
                        checked={f.required}
                        disabled={f.mode === "fixed"}
                        onChange={(e) => upField(i, { required: e.target.checked })}
                        aria-label={t("必填")}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={t("测试请求")} hint={t("用上面的值和 Key 真实发送一次，看看返回什么。点返回里的字段，把它加为节点的输出。")}>
          <div className="nf-row">
            <button className="nf-btn" onClick={() => send("submit")} disabled={!/^https?:\/\//.test(s.url) || busy === "submit"}>
              {busy === "submit" ? t("发送中…") : t("发送测试请求")}
            </button>
            {s.poll.enabled && <span className="nf-muted">{t("异步任务：这一步会真的提交一个任务（可能计费）")}</span>}
          </div>
          {submit && (
            <ProbeView
              probe={submit}
              actions={(path, value) => (
                <>
                  <button className="nf-link" onClick={() => addOutput("submit", path, value)}>
                    {t("＋ 输出")}
                  </button>
                  {s.poll.enabled && (
                    <button
                      className="nf-link"
                      onClick={() => upPoll({ url: `${s.poll.url.replace(/\{\{\s*submit\.body[^}]*\}\}/g, "").replace(/\/?$/, "/")}{{submit.body.${pathText(path)}}}` })}
                    >
                      {t("用作任务 id")}
                    </button>
                  )}
                </>
              )}
            />
          )}
        </Section>

        <Section title={t("异步任务")}>
          <label className="nf-hb__check">
            <input
              type="checkbox"
              className="nf-check"
              checked={s.poll.enabled}
              onChange={(e) => {
                upPoll({ enabled: e.target.checked, url: s.poll.url || s.url.replace(/\/?$/, "/") });
                if (e.target.checked && (!s.timeout || s.timeout === "60s")) up({ timeout: "30m" });
              }}
            />
            {t("提交后要等结果：反复查询任务状态，直到完成（视频生成等）")}
          </label>
          {s.poll.enabled && (
            <>
              <Labeled label={t("查询状态的地址（GET，请求头和 Key 跟上面一样）")}>
                <input className="nf-input nf-code" value={s.poll.url} onChange={(e) => upPoll({ url: e.target.value })} />
              </Labeled>
              <p className="nf-muted">
                {tidKey !== undefined
                  ? t("任务 id 取自提交返回的 {0}。", [tidKey || "body"])
                  : t("在地址里用 {{submit.body.字段}} 引用提交返回的任务 id，或者发送测试请求后在返回里点「用作任务 id」。")}
              </p>
              <div className="nf-hb__grid">
                <Labeled label={t("状态字段")}>
                  <input className="nf-input nf-code" value={s.poll.statusPath} placeholder="status" onChange={(e) => upPoll({ statusPath: e.target.value })} />
                </Labeled>
                <Labeled label={t("表示完成的值")}>
                  <input className="nf-input nf-code" value={s.poll.done} placeholder="succeeded, completed" onChange={(e) => upPoll({ done: e.target.value })} />
                </Labeled>
                <Labeled label={t("表示失败的值")}>
                  <input className="nf-input nf-code" value={s.poll.failed} placeholder="failed, cancelled" onChange={(e) => upPoll({ failed: e.target.value })} />
                </Labeled>
                <Labeled label={t("错误信息字段（可选）")}>
                  <input className="nf-input nf-code" value={s.poll.errorPath} placeholder="error.message" onChange={(e) => upPoll({ errorPath: e.target.value })} />
                </Labeled>
                <Labeled label={t("查询间隔")}>
                  <input className="nf-input nf-code" value={s.poll.interval} placeholder="3s" onChange={(e) => upPoll({ interval: e.target.value })} />
                </Labeled>
                <Labeled label={t("最长等待")}>
                  <input className="nf-input nf-code" value={s.timeout} placeholder="30m" onChange={(e) => up({ timeout: e.target.value })} />
                </Labeled>
              </div>
              <div className="nf-row">
                <button className="nf-btn" onClick={() => send("poll")} disabled={!submit?.body || !/^https?:\/\//.test(s.poll.url) || busy === "poll"}>
                  {busy === "poll" ? t("查询中…") : t("查询一次状态")}
                </button>
                {!submit?.body && <span className="nf-muted">{t("先发送测试请求拿到任务 id")}</span>}
                {submit?.body !== undefined && <code className="nf-hb__url">{previewPollUrl(s, submit.body)}</code>}
              </div>
              {pollProbe && (
                <ProbeView
                  probe={pollProbe}
                  highlight={s.poll.statusPath}
                  actions={(path, value) => (
                    <>
                      <button className="nf-link" onClick={() => addOutput("result", path, value)}>
                        {t("＋ 输出")}
                      </button>
                      <button className="nf-link" onClick={() => upPoll({ statusPath: pathText(path) })}>
                        {t("用作状态")}
                      </button>
                      <button className="nf-link" onClick={() => upPoll({ errorPath: pathText(path) })}>
                        {t("用作错误信息")}
                      </button>
                    </>
                  )}
                />
              )}
            </>
          )}
        </Section>

        <Section
          title={t("输出")}
          hint={s.outputs.length ? undefined : t("没有选输出时，整个返回内容会作为 response 输出。")}
        >
          {s.outputs.map((o, i) => (
            <div key={i} className="nf-hb__out">
              <input className="nf-input nf-code" value={o.name} aria-label={t("输出名")} onChange={(e) => upOutput(i, { name: slug(e.target.value) })} />
              {s.poll.enabled && (
                <select className="nf-input" value={o.from} onChange={(e) => upOutput(i, { from: e.target.value as Output["from"] })} aria-label={t("来自")}>
                  <option value="result">{t("任务结果")}</option>
                  <option value="submit">{t("提交返回")}</option>
                </select>
              )}
              <input
                className="nf-input nf-code"
                value={pathText(o.path)}
                aria-label={t("字段")}
                placeholder="data[0].url"
                onChange={(e) => upOutput(i, { path: (e.target.value.match(/[^.[\]]+/g) ?? []).map((k) => (/^\d+$/.test(k) ? Number(k) : k)) })}
              />
              <select className="nf-input" value={o.type} onChange={(e) => upOutput(i, { type: e.target.value as Output["type"] })} aria-label={t("类型")}>
                {(["string", "number", "boolean", "json"] as const).map((v) => (
                  <option key={v} value={v}>
                    {TYPE_NAMES()[v]}
                  </option>
                ))}
              </select>
              <button className="nf-btn nf-btn--ghost" onClick={() => up({ outputs: s.outputs.filter((_, j) => j !== i) })} aria-label={t("删除")}>
                ×
              </button>
            </div>
          ))}
          <button className="nf-btn nf-btn--ghost nf-hb__add" onClick={() => up({ outputs: [...s.outputs, { name: `out_${s.outputs.length + 1}`, from: "result", path: [], type: "json" }] })}>
            {t("＋ 手动添加输出")}
          </button>
          <p className="nf-muted">{t("返回的是图片或视频链接时，可以在后面接「下载链接为文件」节点保存到本地。")}</p>
        </Section>

        <details className="nf-hb__yaml">
          <summary>{t("查看生成的 YAML")}</summary>
          <pre className="nf-log">{yaml}</pre>
        </details>
      </div>

      <footer className="nf-dialog__foot">
        {error ? <p className="nf-field__error">{error}</p> : problems.length > 0 && <p className="nf-muted">{problems[0]}</p>}
        <span className="nf-spacer" />
        <button className="nf-btn nf-btn--ghost" onClick={() => setEditor(null)}>
          {t("取消")}
        </button>
        <button className="nf-btn nf-btn--primary" onClick={save} disabled={busy === "save"}>
          {t("保存节点")}
        </button>
      </footer>
    </dialog>
  );
}

const TYPE_NAMES = (): Record<string, string> => ({
  string: t("文本"),
  number: t("数字"),
  integer: t("整数"),
  boolean: t("布尔"),
  json: "JSON",
});

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="nf-hb__sec">
      <h3>{title}</h3>
      {hint && <p className="nf-muted">{hint}</p>}
      {children}
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="nf-field">
      <span className="nf-field__label">{label}</span>
      {children}
    </label>
  );
}

function ValueInput({ field, onChange }: { field: Field; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => (field.type === "json" || typeof field.value === "object" ? JSON.stringify(field.value) : String(field.value ?? "")));
  const [bad, setBad] = useState(false);
  if (field.type === "boolean") {
    return (
      <select className="nf-input" value={String(!!field.value)} onChange={(e) => onChange(e.target.value === "true")}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  return (
    <input
      className="nf-input nf-code"
      data-bad={bad || undefined}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (field.type === "json") {
          try {
            onChange(JSON.parse(v));
            setBad(false);
          } catch {
            setBad(true);
          }
        } else if (field.type === "number" || field.type === "integer") {
          const n = Number(v);
          setBad(v !== "" && Number.isNaN(n));
          if (!Number.isNaN(n)) onChange(v === "" ? undefined : n);
        } else onChange(v);
      }}
    />
  );
}

/** A response with every field clickable. */
function ProbeView({ probe, actions, highlight }: { probe: Probe; actions: (path: Path, value: unknown) => ReactNode; highlight?: string }) {
  if (probe.error) return <p className="nf-field__error">{probe.error}</p>;
  return (
    <div className="nf-hb__probe">
      <p className="nf-hb__status" data-ok={probe.ok || undefined}>
        HTTP {probe.status} · {probe.ms} ms
      </p>
      {probe.body !== null && typeof probe.body === "object" ? (
        <ul className="nf-tree">
          <Tree value={probe.body} path={[]} actions={actions} highlight={highlight} />
        </ul>
      ) : (
        <pre className="nf-log">{String(probe.body ?? "")}</pre>
      )}
    </div>
  );
}

function Tree({ value, path, actions, highlight }: { value: unknown; path: Path; actions: (path: Path, value: unknown) => ReactNode; highlight?: string }) {
  const entries: [string | number, unknown][] = Array.isArray(value) ? value.slice(0, 5).map((v, i) => [i, v]) : Object.entries(value as object);
  return (
    <>
      {entries.map(([k, v]) => {
        const p = [...path, k];
        const nested = v !== null && typeof v === "object" && Object.keys(v).length > 0;
        return (
          <li key={String(k)} data-hit={highlight === pathText(p) || undefined}>
            <div className="nf-tree__row">
              <span className="nf-tree__key">{typeof k === "number" ? `[${k}]` : k}</span>
              {!nested && <span className="nf-tree__val">{preview(v)}</span>}
              <span className="nf-tree__acts">{actions(p, v)}</span>
            </div>
            {nested && (
              <ul>
                <Tree value={v} path={p} actions={actions} highlight={highlight} />
                {Array.isArray(v) && v.length > 5 && <li className="nf-muted">{t("…还有 {0} 项", [v.length - 5])}</li>}
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

function preview(v: unknown): string {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
