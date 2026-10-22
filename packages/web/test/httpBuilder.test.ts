import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService } from "../../core/src/index.ts";
import { parseCurl, shellWords } from "../src/curl.ts";
import { fromCurl, liveRequest, previewPollUrl, toDef, type BuilderState } from "../src/httpBuilder.ts";

describe("curl", () => {
  it("splits shell words with quotes, escapes and continuations", () => {
    expect(shellWords(`curl -H 'A: b c' \\\n  -d "{\\"x\\": 1}" $'a\\nb'`)).toEqual(["curl", "-H", "A: b c", "-d", '{"x": 1}', "a\nb"]);
  });

  it("parses a typical API example", () => {
    const r = parseCurl(`curl -X POST https://api.example.com/v1/tasks?mode=fast \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer sk-123" \\
      -d '{"model": "m1", "content": {"prompt": "a cat", "seconds": 5}, "tags": ["x"]}'`);
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.example.com/v1/tasks?mode=fast");
    expect(r.headers).toContainEqual(["Authorization", "Bearer sk-123"]);
    expect(JSON.parse(r.body!)).toMatchObject({ model: "m1" });
  });

  it("handles --json, -G data, -u and flags with values", () => {
    expect(parseCurl(`curl --json '{"a":1}' api.x.io/p`)).toMatchObject({ method: "POST", url: "https://api.x.io/p" });
    expect(parseCurl(`curl -G https://x.io/s -d q=hello%20world -d n=2`).url).toBe("https://x.io/s?q=hello+world&n=2");
    expect(parseCurl(`curl -u user:pw -o out.json https://x.io`).headers).toContainEqual(["Authorization", `Basic ${btoa("user:pw")}`]);
    expect(parseCurl(`curl https://x.io -F file=@a.png`).ignored).toEqual(["-F file=@a.png"]);
    expect(() => parseCurl("wget https://x.io")).toThrow(/not a curl/);
  });
});

describe("builder", () => {
  const curl = `curl -X POST https://api.example.com/v1/tasks?mode=fast -H "Authorization: Bearer sk-123" -H "Content-Type: application/json" -d '{"model": "m1", "content": {"prompt": "a cat", "seconds": 5}, "tags": ["x"]}'`;

  it("turns body and query values into params, and the auth header into a credential", () => {
    const s = fromCurl(parseCurl(curl));
    expect(s.url).toBe("https://api.example.com/v1/tasks");
    expect(s.auth).toMatchObject({ enabled: true, header: "Authorization", prefix: "Bearer ", secret: "sk-123" });
    expect(s.headers).toEqual([]);
    expect(s.fields.map((f) => [f.where, f.name, f.type])).toEqual([
      ["query", "mode", "string"],
      ["body", "model", "string"],
      ["body", "prompt", "string"],
      ["body", "seconds", "integer"],
      ["body", "tags", "json"],
    ]);
    // The test request uses the real values and key; the node type uses templates and a credential.
    const live = liveRequest(s);
    expect(live.headers.Authorization).toBe("Bearer sk-123");
    expect(JSON.parse(live.body!)).toEqual({ model: "m1", content: { prompt: "a cat", seconds: 5 }, tags: ["x"] });
    const def = toDef(s) as { executor: Record<string, unknown>; params: { properties: Record<string, unknown> } };
    expect(JSON.stringify(def)).not.toContain("sk-123");
    expect(def.executor.headers).toEqual({ Authorization: "Bearer {{credential.api_key}}" });
    expect(def.executor.body).toEqual({ model: "{{params.model}}", content: { prompt: "{{params.prompt}}", seconds: "{{params.seconds}}" }, tags: "{{params.tags}}" });
    expect(def.params.properties.prompt).toEqual({ type: "string", format: "multiline", default: "a cat" });
  });

  it("opens up arrays of objects so a nested prompt becomes its own param", () => {
    const s = fromCurl(parseCurl(`curl https://x.io/t -d '{"content": [{"type": "text", "text": "a cat"}, {"type": "image_url", "image_url": {"url": "u"}}], "tags": ["a"]}'`));
    expect(s.fields.map((f) => `${f.name}=${JSON.stringify(f.value)}`)).toEqual(['type="text"', 'text="a cat"', 'content_type="image_url"', 'url="u"', 'tags=["a"]']);
    s.fields[0].mode = "fixed";
    expect((toDef(s).executor as { body: unknown }).body).toEqual({
      content: [{ type: "text", text: "{{params.text}}" }, { type: "{{params.content_type}}", image_url: { url: "{{params.url}}" } }],
      tags: "{{params.tags}}",
    });
  });

  it("fills a poll URL preview from a sample submit response", () => {
    const s = fromCurl(parseCurl(curl));
    s.poll = { ...s.poll, enabled: true, url: "https://api.example.com/v1/tasks/{{submit.body.data.id}}" };
    expect(previewPollUrl(s, { data: { id: "t9" } })).toBe("https://api.example.com/v1/tasks/t9");
  });
});

// The generated definition must run as-is: submit, poll, outputs, credential.
describe("generated node type", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-builder-"));
  let svc: NaturoflowService;
  let server: http.Server;
  let base = "";
  const seen: { key?: string | string[]; body?: unknown }[] = [];
  let polls = 0;

  beforeAll(async () => {
    svc = new NaturoflowService({ home, allowedBins: [], concurrency: 2, nodeDirs: [] });
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ key: req.headers["x-api-key"], body: body ? JSON.parse(body) : undefined });
        res.writeHead(200, { "content-type": "application/json" });
        if (req.method === "POST") return res.end(JSON.stringify({ data: { id: "t1" } }));
        polls++;
        res.end(JSON.stringify(polls < 2 ? { state: "RUNNING" } : { state: "DONE", output: { video_url: "https://cdn/x.mp4" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    svc.close();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("submits with the credential, polls, and returns the chosen fields", async () => {
    const s: BuilderState = fromCurl(parseCurl(`curl ${base}/v1/video -H "x-api-key: real" -d '{"prompt": "a dog", "duration": 5}'`));
    s.id = "my.video";
    s.name = "My video";
    s.fields.find((f) => f.name === "prompt")!.mode = "input";
    s.poll = { ...s.poll, enabled: true, url: `${base}/v1/video/{{submit.body.data.id}}`, interval: "200ms", statusPath: "state", done: "done", failed: "failed, error" };
    s.outputs = [
      { name: "video_url", from: "result", path: ["output", "video_url"], type: "string" },
      { name: "task_id", from: "submit", path: ["data", "id"], type: "string" },
    ];
    const def = svc.saveNodeType(toDef(s), "create");
    const cred = svc.createCredential({ type: def.id, name: "k", data: { api_key: "from-credential" } });
    const run = await svc.runWorkflow({
      id: "v",
      name: "v",
      nodes: [
        { id: "p", type: "core.const", params: { value: "a cat" } },
        { id: "vid", type: "my.video", params: { duration: 8 }, credential: cred.id },
      ],
      edges: [{ from: { node: "p", port: "value" }, to: { node: "vid", port: "prompt" } }],
    });
    expect(run.nodes.vid.error).toBeUndefined();
    expect(run.nodes.vid.outputs).toEqual({ video_url: "https://cdn/x.mp4", task_id: "t1" });
    // The prompt came in through the input port; the key came from the credential, on every request.
    expect(seen[0]).toEqual({ key: "from-credential", body: { prompt: "a cat", duration: 8 } });
    expect(seen.length).toBe(3);
    expect(seen.every((r) => r.key === "from-credential")).toBe(true);
  });
});
