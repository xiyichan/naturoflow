/**
 * Render a value for a log line: JSON for objects, raw text for strings. Long strings inside
 * (e.g. base64 image data) are shortened, and the whole line is capped, so a single response
 * can't flood the run log.
 */
export function preview(value: unknown, maxLen = 4000, maxString = 400): string {
  const shorten = (s: string) => (s.length > maxString ? `${s.slice(0, maxString)}…(+${s.length - maxString} chars)` : s);
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, (_k, v) => (typeof v === "string" ? shorten(v) : v), 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n…(truncated, ${text.length} chars total)` : text;
}

/** Deep copy with long strings shortened, for storing request/response traces. */
export function clip(value: unknown, maxString = 2000): unknown {
  if (typeof value === "string") return value.length > maxString ? `${value.slice(0, maxString)}…(+${value.length - maxString} chars)` : value;
  if (Array.isArray(value)) return value.map((v) => clip(v, maxString));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, maxString)]));
  }
  return value;
}

const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|cookie|set-cookie|x-auth-token)$/i;

/** Headers safe to store: sensitive ones keep only their scheme, e.g. "Bearer ****". */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => {
      if (!SENSITIVE_HEADERS.test(k)) return [k, v];
      const scheme = /^(Bearer|Basic|Token)\s/i.exec(v)?.[1];
      return [k, scheme ? `${scheme} ****` : "****"];
    }),
  );
}
