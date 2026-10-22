import path from "node:path";

/**
 * Minimal `{{ path | filter }}` templates.
 * - A string that is exactly one `{{...}}` returns the raw value (keeps numbers/objects/FileRefs).
 * - Otherwise each `{{...}}` is stringified and interpolated.
 * - Objects/arrays are rendered recursively.
 * Supported filters: json, fromjson, get:<path>, default:<literal>, basename, string, number.
 */
const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const PART = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function render(tpl: unknown, scope: Record<string, unknown>): unknown {
  if (typeof tpl === "string") {
    const whole = WHOLE.exec(tpl);
    if (whole) return evalExpr(whole[1], scope);
    return tpl.replace(PART, (_, expr) => stringify(evalExpr(expr, scope)));
  }
  if (Array.isArray(tpl)) return tpl.map((t) => render(t, scope));
  if (tpl && typeof tpl === "object") {
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, render(v, scope)]));
  }
  return tpl;
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    if ((v as { $file?: boolean }).$file) return (v as { path: string }).path;
    return JSON.stringify(v);
  }
  return String(v);
}

export function evalExpr(expr: string, scope: Record<string, unknown>): unknown {
  const [head, ...filters] = splitPipes(expr);
  let value = getPath(scope, head.trim());
  for (const f of filters) value = applyFilter(f.trim(), value);
  return value;
}

function splitPipes(expr: string): string[] {
  // Split on `|` that are not inside quotes.
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of expr) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "|") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Resolve `a.b[0].c` (also `a["b c"]`) against an object. */
export function getPath(obj: unknown, p: string): unknown {
  if (p === "" || p === "$") return obj;
  const tokens = p.replace(/^\$\.?/, "").match(/[^.[\]]+|\[(\d+|"[^"]*"|'[^']*')\]/g) ?? [];
  let cur: unknown = obj;
  for (let t of tokens) {
    if (cur === undefined || cur === null) return undefined;
    if (t.startsWith("[")) t = t.slice(1, -1).replace(/^["']|["']$/g, "");
    cur = (cur as Record<string, unknown>)[t];
  }
  return cur;
}

function applyFilter(f: string, v: unknown): unknown {
  const idx = f.indexOf(":");
  const name = idx === -1 ? f : f.slice(0, idx).trim();
  const arg = idx === -1 ? undefined : parseLiteral(f.slice(idx + 1).trim());
  switch (name) {
    case "json":
      return JSON.stringify(v);
    case "fromjson":
      return typeof v === "string" ? JSON.parse(v) : v;
    case "get":
      return getPath(v, String(arg));
    case "default":
      return v === undefined || v === null || v === "" ? arg : v;
    case "basename":
      return path.basename(stringify(v));
    case "string":
      return stringify(v);
    case "number":
      return Number(v);
    default:
      throw new Error(`unknown template filter "${name}"`);
  }
}

function parseLiteral(s: string): unknown {
  if (/^["'].*["']$/.test(s)) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}
