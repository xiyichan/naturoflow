import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService } from "../src/index.ts";

// examples/nodes/image.remove-white on a generated picture: white background, a black ring
// enclosing pure white (like a gap in lettering), and a pinkish-white patch (like an eye white).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-rmwhite-"));
const src = path.join(home, "in.png");
let svc: NaturoflowService;

const alphaAt = (file: string, x: number, y: number) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"])[3];

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=white:s=120x120",
    "-vf", "drawbox=x=20:y=20:w=80:h=80:color=black:t=fill,drawbox=x=30:y=30:w=25:h=60:color=white:t=fill,drawbox=x=65:y=30:w=25:h=60:color=0xFCF0F5:t=fill",
    "-frames:v", "1", src,
  ]);
  svc = new NaturoflowService({ home, allowedBins: ["ffmpeg"], concurrency: 1, nodeDirs: [path.resolve(import.meta.dirname, "../../../examples/nodes")], watch: false });
});

afterAll(() => {
  svc.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("image.remove-white", () => {
  it("clears the background and enclosed pure white, keeps the subject and tinted white", async () => {
    const out = (await svc.testNodeType("image.remove-white", { image: src })).nodes.node.outputs?.image as { path: string };
    expect(alphaAt(out.path, 5, 5)).toBe(0); // background
    expect(alphaAt(out.path, 40, 60)).toBe(0); // pure white enclosed by the ring
    expect(alphaAt(out.path, 75, 60)).toBe(255); // pinkish white, like an eye
    expect(alphaAt(out.path, 24, 60)).toBe(255); // the black ring
  });

  it("keeps enclosed white when the inner tolerance is turned down", async () => {
    const out = (await svc.testNodeType("image.remove-white", { image: src }, { inner_tolerance: 0.001 })).nodes.node.outputs?.image as { path: string };
    expect(alphaAt(out.path, 5, 5)).toBe(0);
    expect(alphaAt(out.path, 40, 60)).toBe(255);
  });
});
