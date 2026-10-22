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
