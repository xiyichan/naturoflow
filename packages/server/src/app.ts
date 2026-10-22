import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { NfError, guessMime, type NaturoflowService, type ServiceEvent } from "@naturoflow/core";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { createMcpServer } from "./mcp.ts";

export interface AppOptions {
  token: string;
  /** Hostnames allowed in the Host header (DNS-rebinding protection). */
  allowedHosts?: string[];
  /** Directory with the built web UI (packages/web/dist). */
  webDir?: string;
}

const STATUS: Record<string, number> = {
  NODE_TYPE_NOT_FOUND: 404,
  WORKFLOW_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  CREDENTIAL_NOT_FOUND: 404,
  MISSING_INPUT: 422,
  NO_HISTORY_PARAMS: 422,
  NODE_NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  READONLY: 403,
};

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(svc: NaturoflowService, opts: AppOptions) {
  const app = new Hono();
  const allowedHosts = opts.allowedHosts ?? ["127.0.0.1", "localhost", "[::1]"];

  app.onError((e, c) => {
    if (e instanceof NfError) return c.json({ error: e.toJSON() }, (STATUS[e.code] ?? 400) as 400);
    const issues = (e as { issues?: unknown }).issues;
    if (issues) return c.json({ error: { code: "INVALID", message: e.message, issues } }, 400);
    return c.json({ error: { code: "ERROR", message: e.message } }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, name: "naturoflow" }));

  // DNS-rebinding protection: only answer requests addressed to localhost.
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!allowedHosts.includes(host)) return c.json({ error: { code: "FORBIDDEN_HOST", message: host } }, 403);
    return next();
  });

  const valid = (t: string | undefined) => !!t && safeEqual(t, opts.token);

  // Open /auth?token=... once (the link `serve` prints); the browser then uses an httpOnly cookie.
  app.get("/auth", (c) => {
    if (!valid(c.req.query("token"))) return c.text("invalid token", 401);
    setCookie(c, "nf_token", opts.token, { httpOnly: true, sameSite: "Strict", path: "/" });
    return c.redirect("/");
  });

  const requireToken = async (c: Context, next: () => Promise<void>) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!valid(bearer ?? getCookie(c, "nf_token"))) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid token" } }, 401);
    }
    return next();
  };
  app.use("/mcp", requireToken);
  app.use("/api/*", requireToken);

  // ---------- MCP (Streamable HTTP) ----------
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  app.all("/mcp", async (c) => {
    const sid = c.req.header("mcp-session-id");
    if (sid) {
      const transport = sessions.get(sid);
      if (!transport) return c.json(rpcError("unknown or expired session"), 404);
      return transport.handleRequest(c.req.raw);
    }
    if (c.req.method !== "POST") return c.json(rpcError("missing mcp-session-id"), 400);
    const body = await c.req.json().catch(() => undefined);
    if (!isInitializeRequest(body)) return c.json(rpcError("first request must be initialize"), 400);

    const server = createMcpServer(svc);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      server.close();
    };
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { parsedBody: body });
  });

  // ---------- REST (used by the canvas UI) ----------
  const api = new Hono();

  api.get("/node-types", (c) => c.json(svc.listNodeTypes()));
  api.get("/node-types/:id", (c) => c.json(svc.getNodeType(c.req.param("id"))));
  api.post("/node-types", async (c) => c.json(svc.saveNodeType(await body(c), "create"), 201));
  api.put("/node-types/:id", async (c) => {
    const def = (await body(c)) as Record<string, unknown>;
    if (def.id !== c.req.param("id")) throw new NfError("INVALID_ARGUMENT", "id in body must match the URL");
    return c.json(svc.saveNodeType(def, "update"));
  });
  api.delete("/node-types/:id", (c) => {
    svc.deleteNodeType(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/node-types/:id/test", async (c) => {
    const { inputs, params } = (await body(c)) as { inputs?: Record<string, unknown>; params?: Record<string, unknown> };
    return c.json(await svc.testNodeType(c.req.param("id"), inputs, params));
  });
  api.post("/node-types/reload", (c) => c.json(svc.reloadNodeTypes()));

  api.get("/workflows", (c) => c.json(svc.listWorkflows()));
  api.post("/workflows", async (c) => c.json(svc.createWorkflow((await body(c)) as { name: string }), 201));
  api.get("/workflows/:id", (c) => c.json(svc.getWorkflow(c.req.param("id"))));
  api.put("/workflows/:id", async (c) => {
    const wf = (await body(c)) as { id?: string; version?: number };
    const expected = c.req.header("if-match");
    return c.json(svc.saveWorkflow({ ...wf, id: c.req.param("id") } as never, expected ? Number(expected) : undefined));
  });
  api.delete("/workflows/:id", (c) => {
    svc.deleteWorkflow(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/workflows/:id/patch", async (c) => {
    const { ops, expectedVersion } = (await body(c)) as { ops: never[]; expectedVersion?: number };
    return c.json(svc.applyPatch(c.req.param("id"), ops, expectedVersion));
  });
  api.get("/workflows/:id/validate", (c) => c.json(svc.validateWorkflow(c.req.param("id"))));
  api.post("/workflows/:id/layout", (c) => c.json(svc.autoLayout(c.req.param("id"))));
  api.post("/workflows/:id/run", async (c) => {
    const { inputs, useCache } = ((await body(c)) ?? {}) as { inputs?: Record<string, unknown>; useCache?: boolean };
    const run = await svc.runWorkflow(c.req.param("id"), inputs ?? {}, { wait: false, useCache });
    return c.json({ id: run.id, status: run.status }, 202);
  });

  api.post("/workflows/:id/nodes/:nodeId/run", async (c) => {
    const opts = ((await body(c)) ?? {}) as {
      fromRunId?: string;
      inputs?: Record<string, unknown>;
      params?: "current" | "history";
      useCache?: boolean;
    };
    const run = await svc.runSingleNode(c.req.param("id"), c.req.param("nodeId"), { ...opts, wait: false });
    return c.json({ id: run.id, status: run.status }, 202);
  });
  api.get("/workflows/:id/nodes/:nodeId/history", (c) =>
    c.json(
      svc.nodeHistory(c.req.param("id"), c.req.param("nodeId"), {
        limit: Number(c.req.query("limit") ?? 20),
        before: c.req.query("before") ? Number(c.req.query("before")) : undefined,
      }),
    ),
  );
  api.get("/workflows/:id/interface", (c) => c.json(svc.getWorkflowInterface(c.req.param("id"))));
  api.post("/runs/:id/rerun", async (c) => {
    const { nodeId } = ((await body(c)) ?? {}) as { nodeId?: string };
    if (!nodeId) throw new NfError("INVALID_ARGUMENT", "nodeId is required");
    const run = await svc.rerunFromNode(c.req.param("id"), nodeId, { wait: false });
    return c.json({ id: run.id, status: run.status }, 202);
  });
  // Credentials: values go in, never come out.
  api.get("/credentials", (c) => c.json(svc.listCredentials(c.req.query("type") || undefined)));
  api.get("/credential-types/:type", (c) => {
    const spec = svc.credentialSpec(c.req.param("type"));
    if (!spec) throw new NfError("NOT_FOUND", "unknown credential type");
    return c.json(spec);
  });
  api.post("/credentials", async (c) => c.json(svc.createCredential((await body(c)) as never), 201));
  api.put("/credentials/:id", async (c) => c.json(svc.updateCredential(c.req.param("id"), (await body(c)) as never)));
  api.get("/credentials/:id/usage", (c) => c.json(svc.credentialUsage(c.req.param("id"))));
  api.delete("/credentials/:id", (c) => {
    svc.deleteCredential(c.req.param("id"));
    return c.body(null, 204);
  });
  api.delete("/cache", (c) => c.json({ cleared: svc.clearCache() }));
  api.get("/runs", (c) => c.json(svc.listRuns(c.req.query("workflowId"), Number(c.req.query("limit") ?? 20))));
  api.get("/runs/:id", (c) => c.json(svc.getRun(c.req.param("id"))));
  api.post("/runs/:id/cancel", (c) => c.json({ cancelled: svc.cancelRun(c.req.param("id")) }));

  // Serve run output files (previews); restricted to the runs directory.
  api.get("/files", (c) => {
    const runsDir = path.resolve(svc.config.home, "runs");
    const p = path.resolve(c.req.query("path") ?? "");
    if (!p.startsWith(runsDir + path.sep) || !fs.existsSync(p)) throw new NfError("NOT_FOUND", "file not found");
    return new Response(fs.createReadStream(p) as never, { headers: { "content-type": guessMime(p) } });
  });

  // Server-sent events: workflow/node-type changes and run progress, for live canvas updates.
  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServiceEvent[] = [];
      let wake: (() => void) | undefined;
      const onEvent = (e: ServiceEvent) => {
        queue.push(e);
        wake?.();
      };
      svc.on("event", onEvent);
      stream.onAbort(() => {
        svc.off("event", onEvent);
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15_000)]);
          wake = undefined;
          if (!queue.length) {
            await stream.writeSSE({ event: "ping", data: "{}" });
            continue;
          }
        }
        const e = queue.shift()!;
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      }
    }),
  );

  app.route("/api", api);

  // The canvas UI (static build of packages/web). Assets hold no data, so they need no token.
  if (opts.webDir && fs.existsSync(path.join(opts.webDir, "index.html"))) {
    const webDir = opts.webDir;
    app.get("*", (c) => {
      const rel = path.normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, "");
      const file = path.join(webDir, rel);
      if (rel && file.startsWith(webDir + path.sep) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
        return new Response(fs.readFileSync(file), {
          headers: { "content-type": guessMime(file), "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" },
        });
      }
      // Read per request so a rebuild of the UI is picked up without restarting.
      return c.html(fs.readFileSync(path.join(webDir, "index.html"), "utf8"));
    });
  } else {
    app.get("/", (c) => c.text("naturoflow server is running. Build the UI with `pnpm web:build` to use the canvas."));
  }
  return app;
}

async function body(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new NfError("INVALID_JSON", "request body is not valid JSON");
  }
}

function rpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}
