import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService, type WorkflowInput } from "../src/index.ts";

// Exercises examples/nodes/seedream.generate against a mock of the ModelArk API.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-seedream-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let svc: NaturoflowService;
let server: http.Server;
let base: string;
let credId: string;
let requests: { auth?: string; body: Record<string, unknown> }[] = [];
let reply: (body: Record<string, unknown>) => { status: number; json: unknown } = () => ({ status: 200, json: {} });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ auth: req.headers.authorization, body });
      const { status, json } = reply(body);
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
  credId = svc.createCredential({ type: "byteplus-ark", name: "test", data: { api_key: "ark-test-key-123", base_url: `${base}/api/v3/` } }).id;
});

afterAll(() => {
  svc.close();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const img = (name: string, extra: Record<string, unknown> = {}) => ({ url: `${base}/out/${name}`, size: "2048x2048", ...extra });

function wf(params: Record<string, unknown>, imageFrom?: unknown): WorkflowInput {
  return {
    id: "sd",
    name: "sd",
    nodes: [
      ...(imageFrom !== undefined ? [{ id: "ref", type: "core.const", params: { value: imageFrom } }] : []),
      { id: "gen", type: "seedream.generate", credential: credId, params },
    ],
    edges: imageFrom !== undefined ? [{ from: { node: "ref", port: "value" }, to: { node: "gen", port: "image" } }] : [],
  };
}

describe("seedream.generate", () => {
  it("sends the documented interactive-editing request and saves the image", async () => {
    requests = [];
    reply = () => ({ status: 200, json: { data: [img("a.png", { output_format: "png" })], usage: { generated_images: 1 } } });
    const prompt = "Edit the image based on the hand-drawn sketch. Keep the composition unchanged.";
    const run = await svc.runWorkflow(
      wf({
        prompt,
        image: "https://arkdocs-en.tos-ap-southeast-1.volces.com/images/image-generation/seedream_50_pro_input2.png",
        size: "2K",
        output_format: "png",
        watermark: true,
      }),
    );
    expect(run.status).toBe("success");
    // Exactly the documented body: nothing unset is sent.
    expect(requests[0].body).toEqual({
      model: "dola-seedream-5-0-pro-260628",
      prompt,
      image: "https://arkdocs-en.tos-ap-southeast-1.volces.com/images/image-generation/seedream_50_pro_input2.png",
      size: "2K",
      output_format: "png",
      watermark: true,
    });
    expect(requests[0].auth).toBe("Bearer ark-test-key-123");
    const out = run.nodes.gen.outputs!;
    expect((out.file as { mime: string }).mime).toBe("image/png");
    expect(fs.readFileSync((out.file as { path: string }).path)).toEqual(PNG);
    expect(out.urls).toEqual([`${base}/out/a.png`]);
    // History trace is masked.
    expect(JSON.stringify(run.nodes.gen.trace)).not.toContain("ark-test-key-123");
    expect(run.nodes.gen.trace?.request).toMatchObject({ method: "POST", url: `${base}/api/v3/images/generations` });
  });

  it("merges port and param images; local files go as base64 data URLs", async () => {
    requests = [];
    reply = () => ({ status: 200, json: { data: [img("b.jpeg")] } });
    const local = path.join(home, "ref.png");
    const bigPng = Buffer.concat([PNG, Buffer.alloc(3000, 7)]);
    fs.writeFileSync(local, bigPng);
    const run = await svc.runWorkflow(
      wf({ prompt: "blend", image: "https://x/1.png\nhttps://x/2.png", optimize_prompt_mode: "fast" }, { $file: true, path: local, size: bigPng.length, mime: "image/png" }),
    );
    expect(run.status).toBe("success");
    expect(requests[0].body.image).toEqual([`data:image/png;base64,${bigPng.toString("base64")}`, "https://x/1.png", "https://x/2.png"]);
    expect(requests[0].body.optimize_prompt_options).toEqual({ mode: "fast" });
    // The stored request shortens the base64.
    expect(JSON.stringify(run.nodes.gen.trace?.request)).not.toContain(bigPng.toString("base64"));
    expect(run.nodes.gen.trace?.request).toMatchObject({ body: { image: [expect.stringMatching(/^data:image\/png;base64,.*chars\)$/), "https://x/1.png", "https://x/2.png"] } });
  });

  it("numbered image ports keep their order (图1, 图2) and accept S3 URLs", async () => {
    requests = [];
    reply = () => ({ status: 200, json: { data: [img("c.png")] } });
    const local = path.join(home, "hoodie.png");
    fs.writeFileSync(local, PNG);
    const run = await svc.runWorkflow({
      id: "multi",
      name: "multi",
      nodes: [
        { id: "hoodie", type: "core.file", params: { path: local } },
        { id: "design", type: "core.const", params: { value: "https://cdn.example.com/cat.png" } },
        { id: "gen", type: "seedream.generate", credential: credId, params: { prompt: "把图2印到图1的卫衣胸前" } },
      ],
      edges: [
        { from: { node: "design", port: "value" }, to: { node: "gen", port: "image_2" } },
        { from: { node: "hoodie", port: "file" }, to: { node: "gen", port: "image" } },
      ],
    });
    expect(run.status).toBe("success");
    expect(requests[0].body.image).toEqual([`data:image/png;base64,${PNG.toString("base64")}`, "https://cdn.example.com/cat.png"]);

    // The same link pasted into the param as well is not sent twice.
    requests = [];
    await svc.runWorkflow({
      id: "dup",
      name: "dup",
      nodes: [
        { id: "design", type: "core.const", params: { value: "https://cdn.example.com/cat.png" } },
        { id: "gen", type: "seedream.generate", credential: credId, params: { prompt: "p", image: "https://cdn.example.com/cat.png\nhttps://cdn.example.com/hoodie.png" } },
      ],
      edges: [{ from: { node: "design", port: "value" }, to: { node: "gen", port: "image_2" } }],
    });
    expect(requests[0].body.image).toEqual(["https://cdn.example.com/cat.png", "https://cdn.example.com/hoodie.png"]);
  });

  it("layer decomposition downloads the base image and every layer", async () => {
    requests = [];
    reply = () => ({
      status: 200,
      json: {
        data: [
          img("base.jpeg", { output_format: "jpeg", z_index: 0 }),
          img("l1.png", { output_format: "png", z_index: 1, name: "title", description: "yellow text", bounding_box: { absolute: [1, 2, 3, 4] } }),
          img("l2.png", { output_format: "png", z_index: 2, name: "parrot" }),
        ],
        usage: { input_images: 1, generated_images: 3 },
      },
    });
    const run = await svc.runWorkflow(wf({ layer_decomposition: true, size: "auto" }, "https://x/in.png"));
    expect(run.status).toBe("success");
    expect(requests[0].body).toEqual({ model: "dola-seedream-5-0-pro-260628", image: "https://x/in.png", layer_decomposition: true, size: "auto" });
    const out = run.nodes.gen.outputs!;
    expect((out.files as { path: string }[]).map((f) => path.basename(f.path))).toEqual(["layer_00.jpg", "layer_01.png", "layer_02.png"]);
    expect(out.layers).toMatchObject([{ z_index: 0 }, { z_index: 1, name: "title", bounding_box: { absolute: [1, 2, 3, 4] } }, { z_index: 2, name: "parrot" }]);
  });

  it("b64_json responses are decoded to files and kept out of outputs", async () => {
    reply = () => ({ status: 200, json: { data: [{ b64_json: PNG.toString("base64"), output_format: "png" }] } });
    const run = await svc.runWorkflow(wf({ prompt: "p", response_format: "b64_json" }));
    const out = run.nodes.gen.outputs!;
    expect(fs.readFileSync((out.file as { path: string }).path)).toEqual(PNG);
    expect(JSON.stringify(out.images)).not.toContain(PNG.toString("base64"));
  });

  it("reports API errors and rejects invalid combinations before calling", async () => {
    reply = () => ({ status: 400, json: { error: { code: "InvalidParameter", message: "The parameter `size` is invalid" } } });
    const bad = await svc.runWorkflow(wf({ prompt: "p", size: "9K" }));
    expect(bad.nodes.gen.error).toBe("HTTP 400: The parameter `size` is invalid (InvalidParameter)");

    requests = [];
    const twoForLayers = await svc.runWorkflow(wf({ layer_decomposition: true, image: "https://x/1.png\nhttps://x/2.png" }));
    expect(twoForLayers.nodes.gen.error).toMatch(/exactly one image, got 2/);
    const noPrompt = await svc.runWorkflow(wf({}));
    expect(noPrompt.nodes.gen.error).toMatch(/prompt is required/);
    expect(requests).toHaveLength(0);
  });
});
