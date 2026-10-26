import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService } from "../src/index.ts";

// examples/nodes/image.birefnet. Models live in <home>/models; the real-model case runs only when
// the lite model is already downloaded on this machine.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-birefnet-"));
const realModel = path.join(os.homedir(), ".naturoflow", "models", "birefnet-lite.onnx");
const src = path.join(home, "in.png");
let svc: NaturoflowService;

beforeAll(() => {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=white:s=256x256", "-vf", "drawbox=x=64:y=64:w=128:h=128:color=0x3050c0:t=fill", "-frames:v", "1", src]);
  svc = new NaturoflowService({ home, allowedBins: [], concurrency: 1, nodeDirs: [path.resolve(import.meta.dirname, "../../../examples/nodes")], watch: false });
});

afterAll(() => {
  svc.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const run = (params: Record<string, unknown>) => svc.testNodeType("image.birefnet", { image: src }, params);
const alphaAt = (file: string, x: number, y: number) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"])[3];

describe("image.birefnet", () => {
  it("asks for the model to be downloaded instead of fetching it mid-run", async () => {
    const wf = { id: "b", name: "b", nodes: [{ id: "cut", type: "image.birefnet", params: { model: "birefnet" } }] };
    expect(svc.validateWorkflow(wf).find((i) => i.code === "MISSING_MODEL")?.args).toMatchObject({ model: "birefnet", size: 973 });
    expect(svc.models.list("image.birefnet").map((m) => m.id)).toEqual(["birefnet-lite", "birefnet"]);
    const n = (await run({})).nodes.node;
    expect(n.error).toContain(`model "birefnet-lite" isn't downloaded yet`);
  });

  it.skipIf(!fs.existsSync(realModel))("cuts the subject out with the real lite model", async () => {
    fs.mkdirSync(path.join(home, "models"), { recursive: true });
    fs.symlinkSync(realModel, path.join(home, "models", "birefnet-lite.onnx"));
    expect(svc.models.isDownloaded("birefnet-lite")).toBe(true);
    const n = (await run({ threshold: 0.5 })).nodes.node;
    expect(n.error).toBeUndefined();
    const out = n.outputs as { image: { path: string }; mask: { path: string } };
    expect(alphaAt(out.image.path, 4, 4)).toBe(0);
    expect(alphaAt(out.image.path, 128, 128)).toBe(255);
    expect(fs.existsSync(out.mask.path)).toBe(true);
  }, 60_000);
});
