// The no-code HTTP node builder's model: a request (usually from curl) plus choices about
// which values become params / input ports, which header holds the API key, whether to poll
// an async task, and which response fields become outputs. Turned into a node type definition.
import type { ParsedRequest } from "./curl.ts";

export type FieldMode = "fixed" | "param" | "input";
export type ValueType = "string" | "number" | "integer" | "boolean" | "json";
export type Path = (string | number)[];

export interface Field {
  where: "body" | "query";
  path: Path;
  value: unknown;
  mode: FieldMode;
  name: string;
  type: ValueType;
  required: boolean;
  description: string;
}

export interface Output {
  name: string;
  /** Which response the path is read from: the first request, or the finished task when polling. */
  from: "submit" | "result";
  path: Path;
  type: "string" | "number" | "boolean" | "json";
}

export interface BuilderState {
  name: string;
  id: string;
  category: string;
  description: string;
  method: string;
  /** Without the query string; query values live in `fields`. */
  url: string;
  headers: { key: string; value: string }[];
  bodyKind: "json" | "form" | "text" | "none";
  /** Raw body for bodyKind "text". */
  bodyText: string;
  /** Shape of a JSON body (leaves are replaced by field values / templates). */
  bodyShape: unknown;
  fields: Field[];
  auth: { enabled: boolean; header: string; prefix: string; secret: string };
  poll: {
    enabled: boolean;
    url: string;
    interval: string;
    statusPath: string;
    done: string;
    failed: string;
    errorPath: string;
    maxWait: string;
  };
  outputs: Output[];
  timeout: string;
}

const AUTH_HEADERS = ["authorization", "x-api-key", "api-key", "apikey", "x-goog-api-key", "x-auth-token", "x-access-token"];

export function emptyState(): BuilderState {
  return {
    name: "",
    id: "",
    category: "network",
    description: "",
    method: "POST",
    url: "",
    headers: [],
    bodyKind: "none",
    bodyText: "",
    bodyShape: undefined,
    fields: [],
    auth: { enabled: false, header: "Authorization", prefix: "Bearer ", secret: "" },
    poll: { enabled: false, url: "", interval: "3s", statusPath: "status", done: "succeeded", failed: "failed", errorPath: "", maxWait: "" },
    outputs: [],
    timeout: "60s",
  };
}

export const pathText = (p: Path) => p.map((k, i) => (typeof k === "number" ? `[${k}]` : i ? `.${k}` : k)).join("");

export function getAt(obj: unknown, p: Path): unknown {
  let cur = obj;
  for (const k of p) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Resolve "a.b[0].c" against an object (for previewing templates). */
export function getText(obj: unknown, p: string): unknown {
  const tokens = p.match(/[^.[\]]+/g) ?? [];
  return getAt(obj, tokens.map((t) => (/^\d+$/.test(t) ? Number(t) : t)));
}

function typeOf(v: unknown): ValueType {
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  return "json";
}

/**
 * Leaves of a JSON value. Objects and arrays of objects (like a chat-style `content: [{type, text}]`)
 * are opened up; arrays of plain values (tags, image URLs) and empty objects stay whole.
 */
function leaves(v: unknown, path: Path = []): { path: Path; value: unknown }[] {
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    return v.flatMap((x, i) => leaves(x, [...path, i]));
  }
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) {
    return Object.entries(v).flatMap(([k, x]) => leaves(x, [...path, k]));
  }
  return [{ path, value: v }];
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "value";

/** Unique, readable names for fields: the last key, or more of the path when keys repeat. */
function nameFields(fields: Field[]) {
  const taken = new Set<string>();
  for (const f of fields) {
    const keys = f.path.filter((k) => typeof k === "string") as string[];
    const last = slug(keys.at(-1) ?? "value");
    let n = taken.has(last) && keys.length > 1 ? slug(keys.slice(-2).join("_")) : last;
    for (let i = 2; taken.has(n); i++) n = `${last}_${i}`;
    taken.add(n);
    f.name = n;
  }
}

/** Build the form state from a parsed curl command. */
export function fromCurl(req: ParsedRequest, prev: BuilderState = emptyState()): BuilderState {
  const s: BuilderState = { ...prev, method: req.method, fields: [], outputs: [] };
  const u = new URL(req.url);
  s.url = `${u.origin}${u.pathname}`;
  const fields: Field[] = [...u.searchParams.entries()].map(([k, v]) => field("query", [k], v));

  s.headers = [];
  s.auth = { ...emptyState().auth };
  for (const [k, v] of req.headers) {
    if (!s.auth.enabled && AUTH_HEADERS.includes(k.toLowerCase())) {
      const m = /^(Bearer|Token|Basic|Key)\s+(.+)$/i.exec(v);
      s.auth = { enabled: true, header: k, prefix: m ? `${m[1]} ` : "", secret: m ? m[2] : v };
    } else s.headers.push({ key: k, value: v });
  }

  const ct = req.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  s.bodyShape = undefined;
  s.bodyText = "";
  if (req.body === undefined || req.body === "") s.bodyKind = "none";
  else {
    try {
      s.bodyShape = JSON.parse(req.body);
      s.bodyKind = "json";
      for (const l of leaves(s.bodyShape)) fields.push(field("body", l.path, l.value));
    } catch {
      if (/x-www-form-urlencoded/.test(ct) || /^[\w.%-]+=/.test(req.body)) {
        s.bodyKind = "form";
        for (const [k, v] of new URLSearchParams(req.body)) fields.push(field("body", [k], v));
      } else {
        s.bodyKind = "text";
        s.bodyText = req.body;
      }
    }
  }
  // The body type is set from bodyKind; a leftover content-type header would contradict it.
  if (s.bodyKind === "json" || s.bodyKind === "form") s.headers = s.headers.filter((h) => h.key.toLowerCase() !== "content-type");
  nameFields(fields);
  s.fields = fields;

  if (!s.name) {
    const last = u.pathname.split("/").filter(Boolean).slice(-2).join(" ");
    s.name = `${u.hostname.replace(/^(www|api)\./, "")} ${last}`.trim();
  }
  if (!s.id) s.id = idFrom(s.name);
  return s;
}

function field(where: Field["where"], path: Path, value: unknown): Field {
  return { where, path, value, mode: "param", name: "", type: typeOf(value), required: false, description: "" };
}

export const idFrom = (name: string) => `my.${slug(name).replace(/_/g, "-")}`.slice(0, 60);

const portType = (t: ValueType) => (t === "integer" ? "number" : t === "json" ? "any" : t);

/** The value each field takes: a template for params / inputs, or the value itself. */
function valueFor(f: Field, live: boolean): unknown {
  if (live || f.mode === "fixed") return f.value;
  return f.mode === "param" ? `{{params.${f.name}}}` : `{{inputs.${f.name}}}`;
}

function setAt(obj: unknown, p: Path, v: unknown): unknown {
  if (!p.length) return v;
  const [k, ...rest] = p;
  const copy = (Array.isArray(obj) ? [...obj] : { ...(obj as object) }) as Record<string | number, unknown>;
  copy[k] = setAt(copy[k], rest, v);
  return copy;
}

/** The body with field values (live: current values, for a test request) or templates (for the node type). */
export function buildBody(s: BuilderState, live: boolean): unknown {
  const body = s.fields.filter((f) => f.where === "body");
  if (s.bodyKind === "json") return body.reduce((acc, f) => setAt(acc, f.path, valueFor(f, live)), s.bodyShape);
  if (s.bodyKind === "form") return Object.fromEntries(body.map((f) => [String(f.path[0]), valueFor(f, live)]));
  if (s.bodyKind === "text") return s.bodyText;
  return undefined;
}

function buildQuery(s: BuilderState, live: boolean): Record<string, unknown> {
  return Object.fromEntries(s.fields.filter((f) => f.where === "query").map((f) => [String(f.path[0]), valueFor(f, live)]));
}

/** A ready-to-send request with the current values and the real key, for "send test request". */
export function liveRequest(s: BuilderState): { method: string; url: string; headers: Record<string, string>; body?: string } {
  const u = new URL(s.url);
  for (const [k, v] of Object.entries(buildQuery(s, true))) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = Object.fromEntries(s.headers.filter((h) => h.key).map((h) => [h.key, h.value]));
  if (s.auth.enabled && s.auth.secret) headers[s.auth.header] = `${s.auth.prefix}${s.auth.secret}`;
  const b = buildBody(s, true);
  let body: string | undefined;
  if (s.bodyKind === "json") {
    body = JSON.stringify(b);
    headers["Content-Type"] ??= "application/json";
  } else if (s.bodyKind === "form") {
    body = new URLSearchParams(b as Record<string, string>).toString();
    headers["Content-Type"] ??= "application/x-www-form-urlencoded";
  } else if (s.bodyKind === "text") body = String(b);
  return { method: s.method, url: u.toString(), headers, body };
}

/** Fill `{{submit.body.x}}` in the poll URL from a sample submit response, for a test status query. */
export function previewPollUrl(s: BuilderState, submitBody: unknown): string {
  return s.poll.url.replace(/\{\{\s*submit\.body\.?([^}|\s]*)\s*\}\}/g, (_, p: string) => String(p ? getText(submitBody, p) ?? "" : JSON.stringify(submitBody)));
}

const list = (s: string) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

/** The node type definition this form describes. */
export function toDef(s: BuilderState): Record<string, unknown> {
  const params = s.fields.filter((f) => f.mode === "param");
  const inputs = s.fields.filter((f) => f.mode === "input");
  const headers: Record<string, string> = Object.fromEntries(s.headers.filter((h) => h.key).map((h) => [h.key, h.value]));
  if (s.auth.enabled) headers[s.auth.header] = `${s.auth.prefix}{{credential.api_key}}`;
  const query = buildQuery(s, false);

  const out = (o: Output) => `{{${o.from === "submit" && s.poll.enabled ? "submit.body" : "body"}${o.path.length ? (typeof o.path[0] === "number" ? "" : ".") + pathText(o.path) : ""}}}`;
  const outputs = s.outputs.length ? s.outputs : [{ name: "response", from: "result", path: [], type: "json" } as Output];

  const executor: Record<string, unknown> = {
    kind: "http",
    method: s.method,
    url: s.url,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Object.keys(query).length ? { query } : {}),
    ...(s.bodyKind !== "none" ? { body: buildBody(s, false) } : {}),
    ...(s.bodyKind === "form" || s.bodyKind === "text" ? { bodyType: s.bodyKind } : {}),
  };
  if (s.poll.enabled) {
    executor.poll = {
      url: s.poll.url,
      interval: s.poll.interval || "3s",
      status: `{{body.${s.poll.statusPath}}}`,
      done: list(s.poll.done),
      ...(list(s.poll.failed).length ? { failed: list(s.poll.failed) } : {}),
      ...(s.poll.errorPath ? { error: `{{body.${s.poll.errorPath}}}` } : {}),
      ...(s.poll.maxWait ? { maxWait: s.poll.maxWait } : {}),
    };
  }
  executor.outputs = Object.fromEntries(outputs.map((o) => [o.name, out(o)]));

  const schema = (f: Field) => {
    const multiline = f.type === "string" && (String(f.value ?? "").length > 40 || /prompt|text|content|message/i.test(f.name));
    return {
      ...(f.type !== "json" ? { type: f.type } : {}),
      ...(multiline ? { format: "multiline" } : {}),
      ...(f.value !== undefined && f.value !== "" ? { default: f.value } : {}),
      ...(f.description ? { description: f.description } : {}),
    };
  };

  return {
    id: s.id,
    name: s.name,
    category: s.category,
    ...(s.description ? { description: s.description } : {}),
    ...(s.auth.enabled ? { credentials: { name: s.name, fields: { api_key: { label: "API Key" } } } } : {}),
    ...(inputs.length
      ? { inputs: Object.fromEntries(inputs.map((f) => [f.name, { type: portType(f.type), required: f.required, ...(f.description ? { description: f.description } : {}) }])) }
      : {}),
    params: {
      type: "object",
      ...(params.some((f) => f.required) ? { required: params.filter((f) => f.required).map((f) => f.name) } : {}),
      properties: Object.fromEntries(params.map((f) => [f.name, schema(f)])),
    },
    outputs: Object.fromEntries(outputs.map((o) => [o.name, { type: o.type }])),
    executor,
    // Async tasks are usually billed per submit, so never retried automatically.
    timeout: s.timeout || (s.poll.enabled ? "30m" : "60s"),
  };
}

export function outputType(v: unknown): Output["type"] {
  return typeof v === "string" ? "string" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "json";
}
