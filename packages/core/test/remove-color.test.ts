import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService } from "../src/index.ts";

// examples/nodes/image.remove-color on a generated green-screen picture: a black block (like
// lettering) with a green gap inside it, and a purple block (like the character).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-rmcolor-"));
const src = path.join(home, "green.png");
let svc: NaturoflowService;

const rgbaAt = (file: string, x: number, y: number) =>
  [...execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"])];

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=0x0BBA3A:s=160x120",
    "-vf", "drawbox=x=20:y=20:w=50:h=80:color=black:t=fill,drawbox=x=40:y=40:w=10:h=40:color=0x0BBA3A:t=fill,drawbox=x=90:y=20:w=50:h=80:color=0x7a5cc0:t=fill",
    "-frames:v", "1", src,
  ]);
  svc = new NaturoflowService({ home, allowedBins: [], concurrency: 1, nodeDirs: [path.resolve(import.meta.dirname, "../../../examples/nodes")], watch: false });
});

afterAll(() => {
  svc.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("image.remove-color", () => {
  it("detects the green, clears it everywhere (gaps too) and keeps black and purple", async () => {
    const n = (await svc.testNodeType("image.remove-color", { image: src })).nodes.node;
    expect(n.error).toBeUndefined();
    const out = n.outputs as { image: { path: string }; mask: { path: string }; color: string };
    expect(out.color).toMatch(/^#0[a-f0-9]b[a-f0-9]3[a-f0-9]$/i);
    expect(rgbaAt(out.image.path, 5, 5)[3]).toBe(0); // background
    expect(rgbaAt(out.image.path, 45, 60)[3]).toBe(0); // green gap inside the black block
    expect(rgbaAt(out.image.path, 30, 60)[3]).toBe(255); // black
    expect(rgbaAt(out.image.path, 115, 60)[3]).toBe(255); // purple
    expect(fs.existsSync(out.mask.path)).toBe(true);
    expect(n.logs.some((l) => l.includes("green despill"))).toBe(true);
  });

  it("uses a given color, and rejects a malformed one", async () => {
    const keyed = (await svc.testNodeType("image.remove-color", { image: src }, { color: "#7a5cc0" })).nodes.node;
    const out = keyed.outputs as { image: { path: string } };
    expect(rgbaAt(out.image.path, 115, 60)[3]).toBe(0); // purple keyed out instead
    expect(rgbaAt(out.image.path, 5, 5)[3]).toBe(255);
    expect((await svc.testNodeType("image.remove-color", { image: src }, { color: "green" })).nodes.node.error).toContain("color must look like #00ff00");
  });
});
