import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService, type WorkflowInput } from "../src/index.ts";

// Exercises examples/nodes/gemini.image against a mock of the generateContent API.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-gemini-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");
let svc: NaturoflowService;
let server: http.Server;
let base: string;
let credId: string;
let requests: { url?: string; key?: string; body: Record<string, any> }[] = [];
let reply: () => { status: number; json: unknown } = () => ({ status: 200, json: {} });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ url: req.url, key: req.headers["x-goog-api-key"] as string, body: JSON.parse(raw) });
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
  credId = svc.createCredential({ type: "gemini", name: "test", data: { api_key: "g-test-key", base_url: `${base}/v1beta/` } }).id;
});

afterAll(() => {
  svc.close();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function wf(params: Record<string, unknown>, imageFrom?: unknown): WorkflowInput {
  return {
    id: "gm",
    name: "gm",
    nodes: [
      ...(imageFrom !== undefined ? [{ id: "ref", type: "core.const", params: { value: imageFrom } }] : []),
      { id: "gen", type: "gemini.image", credential: credId, params },
    ],
    edges: imageFrom !== undefined ? [{ from: { node: "ref", port: "value" }, to: { node: "gen", port: "image" } }] : [],
  };
}

const answer = {
  candidates: [
    {
      content: {
        parts: [
          { text: "thinking about apples", thought: true },
          { inlineData: { mimeType: "image/png", data: b64("draft") }, thought: true },
          { inlineData: { mimeType: "image/png", data: b64("final") } },
          { text: "Here is your apple." },
        ],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { totalTokenCount: 1750 },
};

describe("gemini.image", () => {
  it("sends the prompt, references and image settings; saves only the final image", async () => {
    requests = [];
    reply = () => ({ status: 200, json: answer });
    const local = path.join(home, "ref.png");
    fs.writeFileSync(local, PNG);
    const run = await svc.runWorkflow(wf({ prompt: "an apple", aspect_ratio: "16:9", image_size: "2K", image: `${base}/ref.png` }, local));
    const n = run.nodes.gen;
    expect(n.error).toBeUndefined();

    const [req] = requests;
    expect(req.url).toBe("/v1beta/models/gemini-nano-banana-2.1:generateContent");
    expect(req.key).toBe("g-test-key");
    expect(req.body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" } });
    const parts = req.body.contents[0].parts;
    expect(parts[0]).toEqual({ text: "an apple" });
    // The local file and the URL both arrive inline, in order.
    expect(parts.slice(1).map((p: any) => p.inlineData.mimeType)).toEqual(["image/png", "image/png"]);
    expect(parts[1].inlineData.data).toBe(PNG.toString("base64"));

    const out = n.outputs as Record<string, any>;
    expect(fs.readFileSync(out.file.path, "utf8")).toBe("final");
    expect(out.files).toHaveLength(1);
    expect(out.text).toBe("Here is your apple.");
    expect(out.thoughts).toBe("thinking about apples");
    expect(out.drafts).toBeUndefined();
    expect(out.usage).toEqual({ totalTokenCount: 1750 });
    // Base64 never lands in the history trace.
    expect(JSON.stringify(n.trace)).not.toContain(b64("final"));
  });

  it("keeps drafts on request and omits unset settings", async () => {
    requests = [];
    reply = () => ({ status: 200, json: answer });
    const run = await svc.runWorkflow(wf({ prompt: "an apple", keep_drafts: true, image_only: true }));
    expect(requests[0].body.generationConfig).toEqual({ responseModalities: ["IMAGE"] });
    expect(requests[0].body.contents[0].parts).toHaveLength(1);
    const out = run.nodes.gen.outputs as Record<string, any>;
    expect(fs.readFileSync(out.drafts[0].path, "utf8")).toBe("draft");
  });

  it("reports API errors, blocked prompts and image-less answers clearly", async () => {
    reply = () => ({ status: 400, json: { error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } } });
    expect((await svc.runWorkflow(wf({ prompt: "x" }))).nodes.gen.error).toContain("HTTP 400: API key not valid");

    reply = () => ({ status: 200, json: { promptFeedback: { blockReason: "SAFETY" } } });
    expect((await svc.runWorkflow(wf({ prompt: "x" }))).nodes.gen.error).toContain("prompt blocked: SAFETY");

    reply = () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: "I can't draw that." }] }, finishReason: "IMAGE_SAFETY" }] } });
    expect((await svc.runWorkflow(wf({ prompt: "x" }))).nodes.gen.error).toContain("no image (finishReason: IMAGE_SAFETY): I can't draw that.");
  });
});
