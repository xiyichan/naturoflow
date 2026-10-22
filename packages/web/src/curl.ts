// Parse a curl command line (as copied from API docs or browser dev tools) into a request.

export interface ParsedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
  /** Flags we read but can't represent (e.g. multipart -F), to tell the user. */
  ignored: string[];
}

/** Split a shell command into words: quotes, backslash escapes, line continuations, $'...'. */
export function shellWords(src: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  const s = src.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " "); // bash and Windows cmd continuations
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
      i++;
    } else if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end === -1 ? s.length : end);
      has = true;
      i = end === -1 ? s.length : end + 1;
    } else if (ch === "$" && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const e = s[i + 1];
          cur += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
        } else cur += s[i++];
      }
      i++;
      has = true;
    } else if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
        } else cur += s[i++];
      }
      i++;
      has = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      has = true;
      i += 2;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) words.push(cur);
  return words;
}

const DATA = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--json"]);
/** Flags that take a value we don't need. */
const SKIP_VALUE = new Set(["-o", "--output", "-m", "--max-time", "--connect-timeout", "-A", "--user-agent", "-e", "--referer", "-x", "--proxy", "-w", "--write-out", "--retry", "-b", "--cookie", "-c", "--cookie-jar"]);

export function parseCurl(src: string): ParsedRequest {
  const words = shellWords(src.trim());
  if (words[0] !== "curl") throw new Error("not a curl command");
  let method: string | undefined;
  let url = "";
  const headers: [string, string][] = [];
  const data: string[] = [];
  const ignored: string[] = [];
  let getMode = false;
  let json = false;

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const flag = eq > 0 ? w.slice(0, eq) : w;
    const next = () => (eq > 0 ? w.slice(eq + 1) : words[++i] ?? "");
    if (flag === "-X" || flag === "--request") method = next().toUpperCase();
    else if (/^-X[A-Z]+$/.test(w)) method = w.slice(2);
    else if (flag === "-H" || flag === "--header") {
      const h = next();
      const c = h.indexOf(":");
      if (c > 0) headers.push([h.slice(0, c).trim(), h.slice(c + 1).trim()]);
    } else if (DATA.has(flag)) {
      if (flag === "--json") json = true;
      data.push(next());
    } else if (flag === "--data-urlencode") data.push(next());
    else if (flag === "-u" || flag === "--user") headers.push(["Authorization", `Basic ${btoa(next())}`]);
    else if (flag === "-G" || flag === "--get") getMode = true;
    else if (flag === "--url") url = next();
    else if (flag === "-F" || flag === "--form") ignored.push(`${flag} ${next()}`);
    else if (SKIP_VALUE.has(flag)) next();
    else if (w.startsWith("-")) continue; // -s, -L, -k, --compressed, ...
    else if (!url) url = w;
  }
  if (!url) throw new Error("no URL in the curl command");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  let body: string | undefined = data.length ? data.join("&") : undefined;
  if (getMode && body) {
    const u = new URL(url);
    for (const part of body.split("&")) {
      const [k, v = ""] = part.split("=");
      u.searchParams.append(decodeURIComponent(k), decodeURIComponent(v));
    }
    url = u.toString();
    body = undefined;
  }
  if (json) {
    if (!headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", "application/json"]);
    if (!headers.some(([k]) => k.toLowerCase() === "accept")) headers.push(["Accept", "application/json"]);
  }
  return { method: method ?? (body !== undefined ? "POST" : "GET"), url, headers, body, ignored };
}
