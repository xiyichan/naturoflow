import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService, type WorkflowInput } from "../src/index.ts";

// Exercises examples/nodes/openai.image against a mock of the OpenAI image API.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-openai-image-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");
let svc: NaturoflowService;
let server: http.Server;
let base: string;
let credId: string;

interface Seen {
  path?: string;
  auth?: string;
  json?: Record<string, unknown>;
  form?: Record<string, string>;
  files?: { field: string; name: string; type: string; size: number }[];
}
let seen: Seen[] = [];
let reply: () => { status: number; json: unknown } = () => ({ status: 200, json: {} });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const s: Seen = { path: req.url, auth: req.headers.authorization };
      if (String(req.headers["content-type"]).startsWith("multipart/")) {
        const fd = await new Request("http://x", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: raw }).formData();
        s.form = {};
        s.files = [];
        for (const [k, v] of fd.entries()) {
          if (typeof v === "string") s.form[k] = v;
          else s.files.push({ field: k, name: v.name, type: v.type, size: v.size });
        }
      } else s.json = JSON.parse(raw.toString());
      seen.push(s);
      const { status, json } = reply();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  svc = new NaturoflowService({
    home,
    allowedBins: [],
    concurrency: 2,
    nodeDirs: [path.resolve(import.meta.dirname, "../../../examples/nodes")],
    watch: false,
  });
  credId = svc.createCredential({ type: "openai", name: "test", data: { api_key: "sk-test", base_url: `${base}/v1/` } }).id;
});

afterAll(() => {
  svc.close();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function wf(params: Record<string, unknown>, refs: Record<string, unknown> = {}): WorkflowInput {
  const ports = Object.keys(refs);
  return {
    id: "oi",
    name: "oi",
    nodes: [
      ...ports.map((p) => ({ id: `in_${p}`, type: "core.const", params: { value: refs[p] } })),
      { id: "gen", type: "openai.image", credential: credId, params },
    ],
    edges: ports.map((p) => ({ from: { node: `in_${p}`, port: "value" }, to: { node: "gen", port: p } })),
  };
}

const ok = (n = 1) => () => ({
  status: 200,
  json: { created: 1, data: Array.from({ length: n }, (_, i) => ({ b64_json: b64(`img${i + 1}`) })), output_format: "png", usage: { total_tokens: 42 } },
});

describe("openai.image", () => {
  it("generates with JSON when there are no reference images, sending only set fields", async () => {
    seen = [];
    reply = ok(2);
    const run = await svc.runWorkflow(wf({ prompt: "a fox", n: 2, size: "1536x1024", quality: "high", moderation: "low", input_fidelity: "high" }));
    const n = run.nodes.gen;
    expect(n.error).toBeUndefined();
    expect(seen[0].path).toBe("/v1/images/generations");
    expect(seen[0].auth).toBe("Bearer sk-test");
    // input_fidelity is edit-only, so it isn't sent here.
    expect(seen[0].json).toEqual({ model: "gpt-image-1", prompt: "a fox", n: 2, size: "1536x1024", quality: "high", moderation: "low" });
    const out = n.outputs as Record<string, any>;
    expect(out.files.map((f: any) => fs.readFileSync(f.path, "utf8"))).toEqual(["img1", "img2"]);
    expect(out.usage).toEqual({ total_tokens: 42 });
    expect(JSON.stringify(n.trace)).not.toContain(b64("img1"));
  });

  it("edits with multipart when reference images are connected: image[] for several, plus mask", async () => {
    seen = [];
    reply = ok();
    const a = path.join(home, "a.png");
    const m = path.join(home, "mask.png");
    fs.writeFileSync(a, PNG);
    fs.writeFileSync(m, PNG);
    const run = await svc.runWorkflow(wf({ prompt: "put the fox on the shirt", input_fidelity: "high", background: "transparent" }, { image: a, image_2: `${base}/shirt.png`, mask: m }));
    expect(run.nodes.gen.error).toBeUndefined();
    const s = seen[0];
    expect(s.path).toBe("/v1/images/edits");
    expect(s.form).toEqual({ model: "gpt-image-1", prompt: "put the fox on the shirt", background: "transparent", input_fidelity: "high" });
    expect(s.files).toEqual([
      { field: "image[]", name: "a.png", type: "image/png", size: PNG.length },
      { field: "image[]", name: "shirt.png", type: "image/png", size: PNG.length },
      { field: "mask", name: "mask.png", type: "image/png", size: PNG.length },
    ]);
  });

  it("sends a single reference as `image`, downloads URL results, and reports API errors", async () => {
    seen = [];
    reply = () => ({ status: 200, json: { data: [{ url: `${base}/out.png`, revised_prompt: "a red fox" }] } });
    const a = path.join(home, "a.png");
    const run = await svc.runWorkflow(wf({ prompt: "fox", output_format: "jpeg" }, { image: a }));
    expect(seen[0].files?.map((f) => f.field)).toEqual(["image"]);
    const out = run.nodes.gen.outputs as Record<string, any>;
    expect(out.file.path).toMatch(/image\.jpg$/);
    expect(out.revised_prompt).toBe("a red fox");

    reply = () => ({ status: 400, json: { error: { message: "Invalid size", type: "invalid_request_error" } } });
    expect((await svc.runWorkflow(wf({ prompt: "fox" }))).nodes.gen.error).toContain("HTTP 400: Invalid size");
    expect((await svc.runWorkflow(wf({ prompt: "fox", mode: "edit" }))).nodes.gen.error).toContain("edit mode needs at least one reference image");
  });
});
