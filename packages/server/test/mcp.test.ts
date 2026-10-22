import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { NaturoflowService } from "@naturoflow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-mcp-"));
let srv: RunningServer;
let client: Client;

type Text = { content: { text: string }[]; isError?: boolean };
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await c.callTool({ name, arguments: args })) as Text;
  const value = JSON.parse(res.content[0].text);
  if (res.isError) throw Object.assign(new Error(value.error.message), value.error);
  return value;
}

beforeAll(async () => {
  const svc = new NaturoflowService({
    home,
    allowedBins: ["ffmpeg", "ffprobe", "echo"],
    concurrency: 4,
    nodeDirs: [path.join(root, "examples/nodes")],
  });
  srv = await startServer({ svc, port: 0 });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${srv.token}` } },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await srv?.close();
  srv?.svc.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("HTTP auth", () => {
  it("rejects missing token and foreign Host headers", async () => {
    expect((await fetch(`${srv.url}/api/workflows`)).status).toBe(401);
    // fetch() drops custom Host headers, so use node:http to simulate DNS rebinding.
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(`${srv.url}/api/workflows`, { headers: { Authorization: `Bearer ${srv.token}`, Host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        })
        .on("error", reject);
    });
    expect(status).toBe(403);
    expect((await fetch(`${srv.url}/health`)).status).toBe(200);
  });
});

describe("uploads", () => {
  it("accepts multipart files and serves them back", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }), "ref.png");
    const res = await fetch(`${srv.url}/api/uploads`, { method: "POST", body: form, headers: { Authorization: `Bearer ${srv.token}` } });
    expect(res.status).toBe(201);
    const [ref] = await res.json();
    expect(ref).toMatchObject({ $file: true, size: 3, mime: "image/png" });
    const file = await fetch(`${srv.url}/api/files?path=${encodeURIComponent(ref.path)}`, { headers: { Authorization: `Bearer ${srv.token}` } });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    const outside = await fetch(`${srv.url}/api/files?path=${encodeURIComponent("/etc/hosts")}`, { headers: { Authorization: `Bearer ${srv.token}` } });
    expect(outside.status).toBe(400);
  });
});

describe("MCP over Streamable HTTP", () => {
  it("exposes tools and the node type spec", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["create_node_type", "apply_workflow_patch", "run_workflow", "get_node_run_logs"]) {
      expect(names).toContain(n);
    }
    const spec = await client.readResource({ uri: "naturoflow://docs/node-type-spec" });
    expect((spec.contents[0] as { text: string }).text).toContain("executor");
  });

  it("an agent can define a node, build a workflow and run it", async () => {
    // A new node type, written as YAML like an agent would.
    await call(client, "create_node_type", {
      definition: `
id: text.shout
name: Shout
inputs:
  text: { type: string }
outputs:
  text: { type: string }
executor:
  kind: script
  language: js
  code: |
    export default async ({ inputs }) => ({ text: inputs.text.toUpperCase() + "!" });
`,
    });
    const dup = await client.callTool({ name: "create_node_type", arguments: { definition: { id: "text.shout", name: "x", executor: { kind: "builtin", name: "const" } } } });
    expect(dup.isError).toBe(true);

    const { workflow } = await call(client, "create_workflow", { id: "shout", name: "shout" });
    expect(workflow.version).toBe(1);

    // Live canvas sync: the SSE stream should see the patch.
    const events = await fetch(`${srv.url}/api/events`, { headers: { Authorization: `Bearer ${srv.token}` } });
    const reader = events.body!.getReader();

    const patched = await call(client, "apply_workflow_patch", {
      workflowId: "shout",
      ops: [
        { op: "add_node", node: { id: "in", type: "core.input", params: { key: "msg" } } },
        { op: "add_node", node: { id: "shout", type: "text.shout" } },
        { op: "add_node", node: { id: "out", type: "core.output", params: { key: "result" } } },
        { op: "connect", edge: { from: { node: "in", port: "value" }, to: { node: "shout", port: "text" } } },
        { op: "connect", edge: { from: { node: "shout", port: "text" }, to: { node: "out", port: "value" } } },
      ],
    });
    expect(patched.issues).toEqual([]);
    expect(patched.version).toBe(2);

    let sse = "";
    while (!sse.includes("workflow.changed")) sse += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    await expect(call(client, "add_node", { workflowId: "shout", node: { id: "x", type: "core.const" }, expectedVersion: 1 })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });

    await call(client, "auto_layout", { id: "shout" });
    const wf = await call(client, "get_workflow", { id: "shout" });
    expect(wf.nodes.find((n: { id: string }) => n.id === "out").position.x).toBe(600);

    const run = await call(client, "run_workflow", { id: "shout", inputs: { msg: "hello" } });
    expect(run.status).toBe("success");
    expect(run.outputs).toEqual({ result: "HELLO!" });

    const logs = await call(client, "get_node_run_logs", { runId: run.id, nodeId: "shout" });
    expect(logs.outputs).toEqual({ text: "HELLO!" });
  });

  it("returns structured validation errors", async () => {
    await call(client, "create_workflow", {
      id: "broken",
      name: "broken",
      nodes: [{ id: "gif", type: "ffmpeg.to-gif" }],
    });
    const v = await call(client, "validate_workflow", { id: "broken" });
    expect(v.valid).toBe(false);
    expect(v.issues[0]).toMatchObject({ code: "UNCONNECTED_INPUT", nodeId: "gif" });
    const res = await client.callTool({ name: "run_workflow", arguments: { id: "broken" } });
    expect(res.isError).toBe(true);
  });

  it("test_node_type runs a command node", async () => {
    const r = await call(client, "test_node_type", { id: "ffmpeg.testsrc", params: { duration: 1 } });
    expect(r.status).toBe("success");
    expect(r.outputs.video.mime).toBe("video/mp4");
  });
});

describe("published workflows", () => {
  it("become MCP tools that clients can call, and disappear when unpublished", async () => {
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChanged++;
    });
    // "shout" (from the earlier test) has a core.input "msg" and output "result".
    await call(client, "update_node", { workflowId: "shout", id: "in", params: { type: "string", description: "text to shout" } });
    const pub = await call(client, "publish_workflow", { id: "shout", name: "shout_text", description: "Uppercases text" });
    expect(pub.interface.inputs).toEqual([{ key: "msg", type: "string", description: "text to shout", required: true }]);

    const tool = (await client.listTools()).tools.find((t) => t.name === "shout_text");
    expect(tool?.description).toContain("Uppercases text");
    expect(tool?.inputSchema.required).toEqual(["msg"]);
    expect(listChanged).toBeGreaterThan(0);

    const res = await call(client, "shout_text", { msg: "hey" });
    expect(res.outputs).toEqual({ result: "HEY!" });

    const bad = await client.callTool({ name: "publish_workflow", arguments: { id: "broken", name: "run_workflow" } });
    expect(bad.isError).toBe(true);

    await call(client, "unpublish_workflow", { id: "shout" });
    expect((await client.listTools()).tools.some((t) => t.name === "shout_text")).toBe(false);
  });

  it("rerun_from_node reuses upstream outputs", async () => {
    const run = await call(client, "run_workflow", { id: "shout", inputs: { msg: "a" } });
    const rerun = await call(client, "rerun_from_node", { runId: run.id, nodeId: "shout" });
    expect(rerun.status).toBe("success");
    expect(rerun.outputs).toEqual({ result: "A!" });
  });
});

describe("MCP over stdio", () => {
  it("proxies to the running server so changes are shared", async () => {
    const stdio = new Client({ name: "stdio-test", version: "0" });
    await stdio.connect(
      new StdioClientTransport({
        command: path.join(root, "node_modules/.bin/tsx"),
        args: [path.join(root, "packages/cli/src/index.ts"), "mcp"],
        env: { ...process.env, NATUROFLOW_HOME: home, NODE_NO_WARNINGS: "1" } as Record<string, string>,
        stderr: "pipe",
      }),
    );
    const list = await call(stdio, "list_workflows");
    expect(list.map((w: { id: string }) => w.id)).toContain("shout");
    // Edits through stdio land in the HTTP server's service.
    await call(stdio, "create_workflow", { id: "via-stdio", name: "via stdio" });
    expect(srv.svc.getWorkflow("via-stdio").name).toBe("via stdio");
    await stdio.close();
  }, 20_000);
});
