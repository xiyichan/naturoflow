import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NaturoflowService, loadConfig } from "@naturoflow/core";
import { createApp } from "./app.ts";
import { createMcpServer } from "./mcp.ts";

export { createApp } from "./app.ts";
export { createMcpServer, summarizeRun } from "./mcp.ts";

export const DEFAULT_PORT = 7788;

export interface ServerInfo {
  url: string;
  token: string;
  pid: number;
}

export interface RunningServer extends ServerInfo {
  svc: NaturoflowService;
  close: () => Promise<void>;
}

const infoFile = (home: string) => path.join(home, "server.json");

/** Start the HTTP server (REST + SSE + /mcp) on 127.0.0.1 and advertise it in <home>/server.json. */
export async function startServer(
  opts: { svc?: NaturoflowService; port?: number; token?: string; advertise?: boolean } = {},
): Promise<RunningServer> {
  const svc = opts.svc ?? new NaturoflowService();
  const token = opts.token ?? process.env.NATUROFLOW_TOKEN ?? randomBytes(24).toString("base64url");
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const app = createApp(svc, { token, webDir });
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? DEFAULT_PORT, hostname: "127.0.0.1" }, () => resolve(s));
    s.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const info: ServerInfo = { url: `http://127.0.0.1:${port}`, token, pid: process.pid };
  if (opts.advertise !== false) {
    fs.writeFileSync(infoFile(svc.config.home), JSON.stringify(info, null, 2), { mode: 0o600 });
  }
  return {
    ...info,
    svc,
    close: async () => {
      if (opts.advertise !== false) {
        const cur = readInfoFile(svc.config.home);
        if (cur?.pid === process.pid) fs.rmSync(infoFile(svc.config.home), { force: true });
      }
      (server as import("node:http").Server).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function readInfoFile(home: string): ServerInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(infoFile(home), "utf8"));
  } catch {
    return undefined;
  }
}

/** Find a live naturoflow server advertised in <home>/server.json. */
export async function findRunningServer(home = loadConfig().home): Promise<ServerInfo | undefined> {
  const info = readInfoFile(home);
  if (!info) return undefined;
  try {
    process.kill(info.pid, 0);
    const res = await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok && (await res.json()).name === "naturoflow") return info;
  } catch {}
  return undefined;
}

const log = (...a: unknown[]) => console.error("[naturoflow]", ...a);

/**
 * MCP over stdio (for Claude Desktop / Claude Code / Cursor).
 * If a naturoflow server is already running, proxy to its /mcp so edits show up live on that
 * server's canvas. Otherwise start an embedded server in this process (stdio + HTTP).
 */
export async function runStdio(): Promise<void> {
  const stdio = new StdioServerTransport();
  const running = await findRunningServer();

  if (running) {
    log(`proxying stdio to ${running.url}/mcp`);
    const http = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${running.token}` } },
    });
    stdio.onmessage = (m) => http.send(m).catch((e) => log("upstream error:", e.message));
    http.onmessage = (m) => stdio.send(m).catch((e) => log("stdout error:", e.message));
    http.onerror = (e) => log("upstream error:", e.message);
    stdio.onclose = () => http.close();
    http.onclose = () => stdio.close();
    await http.start();
    await stdio.start();
    return;
  }

  const svc = new NaturoflowService();
  let embedded: RunningServer | undefined;
  try {
    embedded = await startServer({ svc });
    log(`embedded server; open the canvas at ${embedded.url}/auth?token=${embedded.token}`);
  } catch (e) {
    log(`HTTP server not started (${(e as Error).message}); serving MCP over stdio only`);
  }
  const server = createMcpServer(svc);
  stdio.onclose = async () => {
    await embedded?.close();
    svc.close();
  };
  // MCP clients usually just kill the process, so make sure the advertisement is removed.
  const cleanup = () => {
    if (readInfoFile(svc.config.home)?.pid === process.pid) fs.rmSync(infoFile(svc.config.home), { force: true });
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
  await server.connect(stdio);
}
