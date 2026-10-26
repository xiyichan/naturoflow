// Remove a solid-color background (green screen, blue, any flat color) with ffmpeg's chromakey,
// then take the background's color cast off the edges (despill). The color is detected from the
// image when not given.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const toPath = (v) => (typeof v === "string" ? v : v?.path);

/**
 * The most common color on a ring just inside the image edge (3% in, which also skips
 * screenshot frames), averaged within its bucket.
 */
async function detectColor(sharp, src) {
  const { data, info } = await sharp(src).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const inset = Math.max(1, Math.round(Math.min(w, h) * 0.03));
  const buckets = new Map();
  const add = (x, y) => {
    const i = (y * w + x) * 3;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const s = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    s.n++, (s.r += r), (s.g += g), (s.b += b);
    buckets.set(key, s);
  };
  for (let x = inset; x < w - inset; x++) add(x, inset), add(x, h - 1 - inset);
  for (let y = inset; y < h - inset; y++) add(inset, y), add(w - 1 - inset, y);
  const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  const ring = 2 * (w - 2 * inset) + 2 * (h - 2 * inset);
  return { rgb: [best.r, best.g, best.b].map((v, i, a) => Math.round(v / best.n)), share: best.n / ring };
}

const hex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

function parseColor(s) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim());
  if (!m) throw new Error(`color must look like #00ff00, got "${s}"`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

export default async ({ inputs, params, ctx }) => {
  const src = toPath(inputs.image);
  if (!src) throw new Error("connect an image to the image input");

  let rgb;
  if (params.color && params.color !== "auto") rgb = parseColor(params.color);
  else {
    const { default: sharp } = await import("sharp");
    const found = await detectColor(sharp, src);
    rgb = found.rgb;
    ctx.log(`background color #${hex(rgb)} (${Math.round(found.share * 100)}% of the border)`);
    if (found.share < 0.4) ctx.log("the border isn't one solid color; set the color param if the result is wrong");
  }

  // Despill only makes sense for a clearly green or blue background.
  const [r, g, b] = rgb;
  const spill = params.despill === false ? undefined : g - Math.max(r, b) > 40 ? "green" : b - Math.max(r, g) > 40 ? "blue" : undefined;

  const similarity = params.tolerance ?? 0.1;
  const blend = params.softness ?? 0.05;
  const filters = [
    "format=rgba",
    `chromakey=color=0x${hex(rgb)}:similarity=${similarity}:blend=${blend}`,
    ...(spill ? [`despill=type=${spill}:mix=${params.despill_strength ?? 0.5}:expand=0`] : []),
    "format=rgba",
  ].join(",");

  const name = path.basename(src).replace(/\.[^.]+$/, "") || "image";
  const out = path.join(ctx.outDir, `${name}.png`);
  const mask = path.join(ctx.outDir, `${name}.mask.png`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vf", filters, "-frames:v", "1", out]);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", out, "-vf", "alphaextract", "-frames:v", "1", mask]);
  ctx.log(`keyed #${hex(rgb)}${spill ? ` with ${spill} despill` : ""} → ${out}`);
  return { image: out, mask, color: `#${hex(rgb)}` };
};
