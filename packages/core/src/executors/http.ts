import fs from "node:fs";
import path from "node:path";
import { preview, redactHeaders } from "../logfmt.ts";
import { render } from "../template.ts";
import type { HttpExecutor } from "../types.ts";
import type { z } from "zod";
import { templateScope, type ExecArgs } from "./types.ts";

type Spec = z.infer<typeof HttpExecutor>;

export async function runHttp(spec: Spec, args: ExecArgs): Promise<Record<string, unknown>> {
  const scope = templateScope(args);
  const method = String(render(spec.method, scope)).toUpperCase();
  const url = new URL(String(render(spec.url, scope)));
  for (const [k, v] of Object.entries((render(spec.query ?? {}, scope) as Record<string, unknown>) ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const headers = new Headers(
    Object.entries((render(spec.headers ?? {}, scope) as Record<string, unknown>) ?? {}).map(([k, v]): [string, string] => [k, String(v)]),
  );

  let body: BodyInit | undefined;
  if (spec.body !== undefined && method !== "GET" && method !== "HEAD") {
    const b = render(spec.body, scope);
    if (spec.bodyType === "json") {
      body = JSON.stringify(pruneUnset(b));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (spec.bodyType === "form") {
      body = new URLSearchParams(b as Record<string, string>);
    } else body = typeof b === "string" ? b : JSON.stringify(b);
  }

  args.ctx.log(`${method} ${url}`);
  const sentBody = body === undefined ? undefined : typeof body === "string" ? tryJson(body) : String(body);
  args.ctx.trace({
    request: { method, url: url.toString(), headers: redactHeaders(Object.fromEntries(headers)), ...(sentBody !== undefined ? { body: sentBody } : {}) },
  });
  const res = await fetch(url, { method, headers, body, signal: args.ctx.signal });
  args.ctx.log(`-> ${res.status} ${res.statusText}`);

  let resBody: unknown;
  if (spec.responseType === "file") {
    const name = path.basename(url.pathname) || "download";
    const file = path.join(args.ctx.outDir, name);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buf);
    args.ctx.log(`saved ${file} (${buf.length} bytes, ${res.headers.get("content-type") ?? "unknown type"})`);
    resBody = file;
  } else {
    const text = await res.text();
    if (spec.responseType === "json") {
      try {
        resBody = text === "" ? null : JSON.parse(text);
      } catch {
        resBody = text;
      }
    } else resBody = text;
    if (res.ok) args.ctx.log(`response: ${preview(resBody)}`);
  }

  args.ctx.trace({
    response: {
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type") ?? undefined,
      body: spec.responseType === "file" ? { savedTo: resBody } : resBody,
    },
  });

  if (spec.failOnError && !res.ok) {
    const snippet = typeof resBody === "string" ? resBody : JSON.stringify(resBody);
    throw new Error(`HTTP ${res.status}: ${snippet?.slice(0, 500)}`);
  }

  const result = { status: res.status, headers: Object.fromEntries(res.headers), body: resBody };
  return mapOutputs(spec.outputs, { ...scope, ...result, result }, { body: resBody, status: res.status, headers: result.headers });
}

/** Apply an executor's `outputs` map; when absent, fall back to the default result. */
export function mapOutputs(
  outputs: Record<string, unknown> | undefined,
  scope: Record<string, unknown>,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (!outputs) return fallback;
  return Object.fromEntries(Object.entries(outputs).map(([port, tpl]) => [port, render(tpl, scope)]));
}

/**
 * Drop fields whose value is null/undefined (unset optional params), and objects left empty by
 * that, so APIs only receive the fields the user actually set. Array items are kept as-is.
 */
export function pruneUnset(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruneUnset);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || x === null) continue;
    const pruned = pruneUnset(x);
    const emptied = pruned && typeof pruned === "object" && !Array.isArray(pruned) && Object.keys(pruned).length === 0 && Object.keys(x as object).length > 0;
    if (!emptied) out[k] = pruned;
  }
  return out;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
