// UI translations. Chinese source text is the key; `en` maps it to English.
// Placeholders {0}, {1}… are filled from the args array.
import { en } from "./i18n.en.ts";

export type Lang = "zh" | "en";
const KEY = "naturoflow.lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // storage unavailable
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const lang: Lang = detect();
/** BCP 47 locale for dates and numbers, so they follow the interface language, not the browser's. */
export const locale = lang === "zh" ? "zh-CN" : "en-US";

const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
const timeOnly = new Intl.DateTimeFormat(locale, { timeStyle: "medium" });

export function formatDateTime(ts: number | string | Date): string {
  return dateTime.format(new Date(ts));
}

export function formatTime(ts: number | string | Date): string {
  return timeOnly.format(new Date(ts));
}

const shortTimeFmt = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
const shortDayFmt = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Compact, for lists: "1:10 AM" today, "10/23, 1:10 AM" otherwise. */
export function formatShort(ts: number | string | Date): string {
  const d = new Date(ts);
  return (d.toDateString() === new Date().toDateString() ? shortTimeFmt : shortDayFmt).format(d);
}

/** Time only for today, date and time otherwise. */
export function formatWhen(ts: number | string | Date): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? timeOnly.format(d) : dateTime.format(d);
}
document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

/** Switch language; the page reloads so every label (including module-level ones) updates. */
export function setLang(next: Lang) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // storage unavailable: still reload in the requested language for this session
  }
  location.reload();
}

const missing = new Set<string>();

export function t(text: string, args: unknown[] = []): string {
  let out = text;
  if (lang === "en") {
    const hit = en[text];
    if (hit !== undefined) out = hit;
    else if (import.meta.env.DEV && !missing.has(text)) {
      missing.add(text);
      console.warn("[i18n] missing en:", text);
    }
  }
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] === undefined ? m : String(args[Number(i)]))) : out;
}

interface NodeTypeText {
  name?: string;
  description?: string;
  params?: Record<string, string>;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  credentials?: { name?: string; fields?: Record<string, { label?: string; description?: string }> };
}

type Described = { description?: string };

function overlay<T extends Described>(map: Record<string, T> | undefined, text: Record<string, string> | undefined) {
  if (!map || !text) return map;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, text[k] ? { ...v, description: text[k] } : v]));
}

/**
 * A node type with its texts in the current language. Node type YAML can carry
 * `i18n: { en: { name, description, params: {key: help}, inputs, outputs, credentials } }`.
 */
export function localizeDef<T extends { name: string; i18n?: Record<string, NodeTypeText> }>(def: T): T {
  const tr = def.i18n?.[lang];
  if (!tr) return def;
  const d = def as T & {
    description?: string;
    params?: { properties?: Record<string, Described> };
    inputs?: Record<string, Described>;
    outputs?: Record<string, Described>;
    credentials?: { name?: string; fields?: Record<string, { label?: string; description?: string }> };
  };
  const fields = d.credentials?.fields;
  const ct = tr.credentials?.fields;
  return {
    ...d,
    name: tr.name ?? d.name,
    description: tr.description ?? d.description,
    params: d.params && { ...d.params, properties: overlay(d.params.properties, tr.params) },
    inputs: overlay(d.inputs, tr.inputs),
    outputs: overlay(d.outputs, tr.outputs),
    credentials: d.credentials && {
      ...d.credentials,
      name: tr.credentials?.name ?? d.credentials.name,
      fields: fields && ct ? Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { ...f, ...ct[k] }])) : fields,
    },
  };
}

/** What to fix by hand after importing a workflow. */
export function importWarningText(w: { code: string; nodeId?: string; args: Record<string, string> }): string {
  switch (w.code) {
    case "NODE_TYPE_ADDED": return t("已添加节点类型 {0}", [w.args.type]);
    case "MISSING_NODE_TYPE": return t("{0} 的节点类型 {1} 在这里不存在", [w.nodeId, w.args.type]);
    case "CHOOSE_CREDENTIAL": return t("{0} 需要选择凭据", [w.nodeId]);
    case "MISSING_FILE": return t("{0} 的本地文件不存在，请重新选择", [w.nodeId]);
    case "TOOL_NAME_TAKEN": return t("MCP 工具名 {0} 已被占用，没有发布", [w.args.name]);
    default: return w.code;
  }
}

/** Validation issues come from the server in English; rebuild the text from their code and args. */
export function issueText(i: { code: string; message: string; args?: Record<string, string | number> }): string {
  const a = i.args;
  if (!a && !["DUPLICATE_NODE_ID", "CYCLE", "EDGE_NODE_NOT_FOUND"].includes(i.code)) return i.message;
  switch (i.code) {
    case "DUPLICATE_NODE_ID": return t("节点 id 不能重复");
    case "CYCLE": return t("工作流里有循环连线");
    case "EDGE_NODE_NOT_FOUND": return t("连线指向的节点不存在");
    case "NODE_TYPE_NOT_FOUND": return t("找不到节点类型“{0}”", [a!.type]);
    case "MISSING_PARAM": return t("参数“{0}”必须填写", [a!.param]);
    case "UNCONNECTED_INPUT": return t("输入“{0}”还没有连线", [a!.port]);
    case "MULTIPLE_EDGES": return t("输入“{0}”接了 {1} 条连线，只能接一条", [a!.port, a!.count]);
    case "PORT_NOT_FOUND": return a!.dir === "output" ? t("{0} 没有输出“{1}”", [a!.node, a!.port]) : t("{0} 没有输入“{1}”", [a!.node, a!.port]);
    case "TYPE_MISMATCH": return t("类型不匹配：{0}（{1}）→ {2}（{3}）", [a!.from, a!.fromType, a!.to, a!.toType]);
    case "MISSING_CREDENTIAL": return t("请选择 {0} 凭据", [a![`name_${lang}`] ?? a!.name]);
    case "CREDENTIAL_NOT_FOUND": return t("选择的凭据已被删除，请重新选择");
    case "CREDENTIAL_TYPE_MISMATCH": return t("凭据“{0}”的类型是 {1}，这里需要 {2}", [a!.name, a!.type, a!.expected]);
    default: return i.message;
  }
}
