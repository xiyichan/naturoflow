import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService, portCompatible, render, type WorkflowInput } from "../src/index.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-test-"));
const examples = path.resolve(import.meta.dirname, "../../../examples/nodes");
let svc: NaturoflowService;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  svc = new NaturoflowService({ home, allowedBins: ["ffmpeg", "ffprobe", "echo", "sh"], concurrency: 4, nodeDirs: [examples] });
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/fail") {
        res.writeHead(500).end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  svc.close();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("template", () => {
  it("keeps raw values for whole-expression templates", () => {
    expect(render("{{a.b}}", { a: { b: [1, 2] } })).toEqual([1, 2]);
    expect(render("x={{a.b[1]}}", { a: { b: [1, 2] } })).toBe("x=2");
    expect(render({ k: ["{{n | default: 5}}"] }, {})).toEqual({ k: [5] });
    expect(render("{{s | fromjson | get:'x.y'}}", { s: '{"x":{"y":3}}' })).toBe(3);
  });
});

describe("validation", () => {
  it("loads every example node type", () => {
    expect(svc.registry.loadErrors).toEqual([]);
    expect(svc.registry.get("http.request")).toBeDefined();
  });

  it("checks port types", () => {
    expect(portCompatible("file", "file")).toBe(true);
    expect(portCompatible("number", "string")).toBe(true);
    expect(portCompatible("file", "json")).toBe(false);
  });

  it("reports unknown types, missing inputs, mismatches and cycles", () => {
    const issues = svc.validateWorkflow({
      id: "bad",
      name: "bad",
      nodes: [
        { id: "a", type: "nope" },
        { id: "gif", type: "ffmpeg.to-gif" },
        { id: "j1", type: "js.transform" },
        { id: "j2", type: "js.transform" },
      ],
      edges: [
        { from: { node: "j1", port: "result" }, to: { node: "j2", port: "input" } },
        { from: { node: "j2", port: "result" }, to: { node: "j1", port: "input" } },
      ],
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("NODE_TYPE_NOT_FOUND");
    expect(codes).toContain("UNCONNECTED_INPUT");
    expect(codes).toContain("CYCLE");
  });
});

describe("executors", () => {
  it("http: POSTs a JSON body and maps outputs", async () => {
    const wf: WorkflowInput = {
      id: "http",
      name: "http",
      nodes: [
        { id: "body", type: "core.const", params: { value: { hello: "world" } } },
        { id: "req", type: "http.request", params: { method: "POST", url: `${baseUrl}/echo` } },
        { id: "out", type: "core.output", params: { key: "res" } },
      ],
      edges: [
        { from: { node: "body", port: "value" }, to: { node: "req", port: "body" } },
        { from: { node: "req", port: "body" }, to: { node: "out", port: "value" } },
      ],
    };
    const run = await svc.runWorkflow(wf);
    expect(run.status).toBe("success");
    expect(run.outputs?.res).toEqual({ method: "POST", url: "/echo", body: { hello: "world" } });
  });

  it("http: non-2xx fails, retries, and skips downstream", async () => {
    const run = await svc.runWorkflow({
      id: "http-fail",
      name: "f",
      nodes: [
        { id: "req", type: "http.request", params: { url: `${baseUrl}/fail` } },
        { id: "out", type: "core.output" },
      ],
      edges: [{ from: { node: "req", port: "body" }, to: { node: "out", port: "value" } }],
    });
    expect(run.status).toBe("failed");
    expect(run.nodes.req.attempts).toBe(3);
    expect(run.nodes.req.error).toMatch(/HTTP 500/);
    expect(run.nodes.out.status).toBe("skipped");
  });

  it("command: refuses binaries outside the allowlist and never uses a shell", async () => {
    svc.saveNodeType({
      id: "test.echo",
      name: "echo",
      params: { type: "object", properties: { msg: { type: "string" } } },
      outputs: { text: { type: "string" } },
      executor: { kind: "command", bin: "echo", args: ["{{params.msg}}"], outputs: { text: "{{stdout}}" } },
    });
    const run = await svc.testNodeType("test.echo", {}, { msg: "hi; rm -rf /" });
    expect(run.nodes.node.outputs?.text).toBe("hi; rm -rf /\n");

    svc.saveNodeType({ id: "test.ls", name: "ls", executor: { kind: "command", bin: "ls" } });
    const bad = await svc.testNodeType("test.ls");
    expect(bad.nodes.node.error).toMatch(/not in allowedBins/);
  });

  it("script: js and python", async () => {
    const js = await svc.testNodeType("js.transform", { input: 20 }, { code: "return inputs.input + 1;" });
    expect(js.nodes.node.outputs?.result).toBe(21);
    const py = await svc.testNodeType("python.transform", { input: [1, 2, 3] }, { code: "result = sum(input)" });
    expect(py.nodes.node.outputs?.result).toBe(6);
  });

  it("timeout cancels a slow node", async () => {
    svc.saveNodeType({
      id: "test.sleep",
      name: "sleep",
      timeout: "200ms",
      executor: { kind: "command", bin: "sh", args: ["-c", "sleep 5"] },
    });
    const t0 = Date.now();
    const run = await svc.testNodeType("test.sleep");
    expect(run.nodes.node.error).toMatch(/timed out/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("service", () => {
  it("applies patches atomically and bumps the version", () => {
    svc.createWorkflow({ id: "p", name: "patch me" });
    const { workflow, issues } = svc.applyPatch("p", [
      { op: "add_node", node: { id: "c", type: "core.const", params: { value: 1 } } },
      { op: "add_node", node: { id: "o", type: "core.output" } },
      { op: "connect", edge: { from: { node: "c", port: "value" }, to: { node: "o", port: "value" } } },
    ]);
    expect(workflow.version).toBe(2);
    expect(issues).toEqual([]);
    // A failing op leaves the stored workflow untouched.
    expect(() =>
      svc.applyPatch("p", [{ op: "remove_node", id: "c" }, { op: "remove_node", id: "missing" }]),
    ).toThrow(/not found/);
    expect(svc.getWorkflow("p").nodes).toHaveLength(2);
    expect(() => svc.applyPatch("p", [], 1)).toThrow(/VERSION|version/);
  });

  it("persists runs", async () => {
    const run = await svc.runWorkflow("p");
    expect(svc.getRun(run.id).status).toBe("success");
    expect(svc.listRuns("p")[0].id).toBe(run.id);
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("ffmpeg end to end", () => {
  it("runs the example video-to-gif workflow", async () => {
    const wf = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../examples/workflows/video-to-gif.json"), "utf8"));
    const run = await svc.runWorkflow(wf);
    expect(run.status).toBe("success");
    const summary = run.outputs?.summary as { durationSec: number; gifBytes: number; gif: string };
    expect(summary.durationSec).toBe(2);
    expect(fs.statSync(summary.gif).size).toBe(summary.gifBytes);
  }, 30_000);
});
