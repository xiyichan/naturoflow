import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService, type ModelStatus, type ServiceEvent } from "../src/index.ts";

// Model downloads on request: declared by node types, fetched by ModelManager, checked by validation.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-models-"));
const BYTES = Buffer.alloc(64 * 1024, 7);
let svc: NaturoflowService;
let server: http.Server;
let base: string;
let hold: (() => void) | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok/model.onnx" || req.url === "/x/resolve/main/model.onnx") return res.writeHead(200, { "content-length": String(BYTES.length) }).end(BYTES);
    if (req.url === "/short/model.onnx") {
      res.writeHead(200, { "content-length": String(BYTES.length) });
      res.write(BYTES.subarray(0, 2048));
      return res.destroy();
    }
    if (req.url === "/slow/model.onnx") {
      res.writeHead(200, { "content-length": String(BYTES.length) });
      res.write(BYTES.subarray(0, 1024));
      hold = () => res.end(BYTES.subarray(1024));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  svc = new NaturoflowService({ home, allowedBins: [], concurrency: 1, nodeDirs: [], watch: false });
  svc.saveNodeType({
    id: "test.modeled",
    name: "modeled",
    params: { type: "object", properties: { model: { type: "string", default: "m-ok" } } },
    outputs: { dir: { type: "string" } },
    models: [
      { id: "m-ok", url: `${base}/ok/model.onnx`, size: 1 },
      { id: "m-short", url: `${base}/short/model.onnx` },
      { id: "m-slow", url: `${base}/slow/model.onnx` },
      { id: "m-hf", url: "https://huggingface.co/x/resolve/main/model.onnx" },
    ],
    executor: { kind: "script", language: "js", code: "export default async ({ ctx }) => ({ dir: ctx.modelsDir });" },
  });
});

afterAll(() => {
  hold?.();
  svc.close();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const wf = (model?: string) => ({ id: "w", name: "w", nodes: [{ id: "n", type: "test.modeled", params: model ? { model } : {} }] });

describe("models", () => {
  it("flags nodes whose chosen model isn't downloaded, then clears once it is", async () => {
    expect(svc.validateWorkflow(wf()).map((i) => [i.code, i.args?.model])).toEqual([["MISSING_MODEL", "m-ok"]]);
    expect(svc.validateWorkflow(wf("m-short"))[0].args?.model).toBe("m-short");

    const events: ModelStatus[] = [];
    svc.on("event", (e: ServiceEvent) => e.type === "model.changed" && events.push(e.model));
    const { done } = svc.models.download("m-ok");
    const st = await done;
    expect(st).toMatchObject({ downloaded: true, bytes: BYTES.length, nodeTypes: ["test.modeled"] });
    expect(fs.readFileSync(path.join(home, "models", "m-ok.onnx"))).toEqual(BYTES);
    expect(events.at(-1)?.downloaded).toBe(true);
    expect(svc.validateWorkflow(wf())).toEqual([]);
    // Scripts are told where models live.
    expect((await svc.testNodeType("test.modeled")).nodes.node.outputs).toEqual({ dir: path.join(home, "models") });
  });

  it("keeps no partial file when a download is cut short", async () => {
    const st = await svc.models.download("m-short").done;
    expect(st.downloaded).toBe(false);
    expect(st.error).toMatch(/incomplete|terminated|other side closed|fetch failed/i);
    expect(fs.readdirSync(path.join(home, "models")).filter((f) => f.includes("m-short"))).toEqual([]);
  });

  it("reports progress while downloading, and can be cancelled", async () => {
    const { status, done } = svc.models.download("m-slow");
    expect(status.progress).toBeDefined();
    // A second request joins the running download instead of starting another.
    expect(svc.models.download("m-slow").status.progress).toBeDefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.models.list("test.modeled").find((m) => m.id === "m-slow")?.progress?.received).toBeGreaterThan(0);
    expect(svc.models.cancel("m-slow")).toBe(true);
    expect((await done).error).toBe("cancelled");
    hold?.();
  });

  it("downloads Hugging Face models through a mirror, and deletes them", async () => {
    const st = await svc.models.download("m-hf", { mirror: `${base}/` }).done;
    expect(st.downloaded).toBe(true);
    expect(svc.models.remove("m-hf").downloaded).toBe(false);
    expect(() => svc.models.download("nope")).toThrow(/no node type declares a model "nope"/);
  });
});
