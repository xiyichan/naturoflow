import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService } from "../src/index.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-poll-"));
let svc: NaturoflowService;
let server: http.Server;
let base: string;

/** A fake async task API: POST /tasks starts a task; GET /tasks/:id walks it through a script of replies. */
const tasks = new Map<string, { replies: [number, unknown][]; seen: number }>();
const authSeen: string[] = [];

beforeAll(async () => {
  svc = new NaturoflowService({ home, allowedBins: [], concurrency: 4, nodeDirs: [] });
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      authSeen.push(String(req.headers.authorization));
      const send = (code: number, v: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (req.method === "POST" && req.url === "/tasks") {
        const { script } = JSON.parse(body) as { script: string };
        const id = `t${tasks.size + 1}`;
        const scripts: Record<string, [number, unknown][]> = {
          ok: [
            [200, { status: "queued" }],
            [503, { message: "busy" }],
            [200, { status: "Running" }],
            [200, { status: "SUCCEEDED", result: { url: "https://cdn.example/v.mp4" } }],
          ],
          fail: [
            [200, { status: "running" }],
            [200, { status: "failed", error: { message: "content policy" } }],
          ],
          forever: [[200, { status: "running" }]],
        };
        tasks.set(id, { replies: scripts[script], seen: 0 });
        return send(200, { id });
      }
      const m = /^\/tasks\/(\w+)$/.exec(req.url ?? "");
      const task = m && tasks.get(m[1]);
      if (!task) return send(404, { message: "no such task" });
      const [code, reply] = task.replies[Math.min(task.seen++, task.replies.length - 1)];
      send(code, reply);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  svc.saveNodeType({
    id: "test.async",
    name: "async task",
    params: { type: "object", properties: { script: { type: "string" }, maxWait: { type: "string" } } },
    outputs: { url: { type: "string" }, task_id: { type: "string" } },
    executor: {
      kind: "http",
      method: "POST",
      url: `${base}/tasks`,
      headers: { authorization: "Bearer secret-token" },
      body: { script: "{{params.script}}" },
      poll: {
        url: `${base}/tasks/{{submit.body.id}}`,
        interval: "200ms",
        status: "{{body.status}}",
        done: ["succeeded"],
        failed: ["failed"],
        error: "{{body.error.message}}",
        maxWait: "1s",
      },
      outputs: { url: "{{body.result.url}}", task_id: "{{submit.body.id}}" },
    },
  });
});

afterAll(() => {
  svc.close();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const wf = (script: string) => ({ id: `poll-${script}`, name: script, nodes: [{ id: "task", type: "test.async", params: { script } }] });

describe("http poll", () => {
  it("submits, waits out busy replies, and maps outputs from the finished task", async () => {
    authSeen.length = 0;
    const run = await svc.runWorkflow(wf("ok"));
    const n = run.nodes.task;
    expect(n.status).toBe("success");
    expect(n.outputs).toEqual({ url: "https://cdn.example/v.mp4", task_id: expect.stringMatching(/^t\d+$/) });
    // Status changes are logged once each; auth carried over to the status queries.
    expect(n.logs.filter((l) => l.startsWith("status:")).map((l) => l.split(" ")[1])).toEqual(["queued", "Running", "SUCCEEDED"]);
    expect(authSeen.every((a) => a === "Bearer secret-token")).toBe(true);
    expect(n.trace?.poll).toMatchObject({ attempts: 4, response: { status: 200 } });
  });

  it("fails with the API's message when the task fails", async () => {
    const run = await svc.runWorkflow(wf("fail"));
    expect(run.nodes.task.status).toBe("failed");
    expect(run.nodes.task.error).toContain("task failed: content policy");
  });

  it("gives up after maxWait", async () => {
    const run = await svc.runWorkflow(wf("forever"));
    expect(run.nodes.task.error).toMatch(/still not finished after \d+s \(last status: running\)/);
  });

  it("stops polling when the run is cancelled", async () => {
    const started = svc.runWorkflow(wf("forever"), {}, { wait: false });
    const { id } = await started;
    await new Promise((r) => setTimeout(r, 300));
    svc.cancelRun(id);
    const t0 = Date.now();
    let run = svc.getRun(id);
    while (run.status === "running" && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 20));
      run = svc.getRun(id);
    }
    expect(run.status).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
