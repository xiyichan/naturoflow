// Render an SVG to a transparent PNG at a chosen width.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Width / height ratio from the viewBox, else the width / height attributes. */
function aspect(svg) {
  const vb = svg.match(/<svg[^>]*\sviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i);
  if (vb && +vb[1] > 0 && +vb[2] > 0) return +vb[1] / +vb[2];
  const w = svg.match(/<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i);
  const h = svg.match(/<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i);
  if (w && h && +w[1] > 0 && +h[1] > 0) return +w[1] / +h[1];
  return 1;
}

/** Set the root element's width / height so renderers rasterize at that size. */
function sized(svg, width, height) {
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) throw new Error("not an SVG file (no <svg> element)");
  let tag = open[0].replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  tag = tag.replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`);
  return svg.replace(open[0], tag);
}

async function has(bin) {
  try {
    await run("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

export default async ({ inputs, params, ctx }) => {
  const src = typeof inputs.file === "string" ? inputs.file : inputs.file?.path;
  if (!src) throw new Error("connect an SVG file to the file input");
  const svg = fs.readFileSync(src, "utf8");
  const width = Math.round(params.width ?? 2048);
  const height = Math.max(1, Math.round(width / aspect(svg)));

  const name = path.basename(src).replace(/\.svg$/i, "") || "image";
  const tmp = path.join(ctx.outDir, `${name}.render.svg`);
  const out = path.join(ctx.outDir, `${name}.png`);
  fs.writeFileSync(tmp, sized(svg, width, height));

  if (process.platform === "darwin") {
    await run("sips", ["-s", "format", "png", tmp, "--out", out]);
  } else if (await has("rsvg-convert")) {
    await run("rsvg-convert", ["-w", String(width), "-h", String(height), "-f", "png", "-o", out, tmp]);
  } else {
    throw new Error("no SVG renderer found: install rsvg-convert (librsvg)");
  }
  fs.rmSync(tmp, { force: true });
  if (!fs.existsSync(out)) throw new Error("the renderer produced no PNG");
  ctx.log(`rendered ${width}x${height} → ${out}`);
  return { file: out, width, height };
};
