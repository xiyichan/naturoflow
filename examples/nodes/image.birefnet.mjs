// Background removal with BiRefNet (MIT) or RMBG-2.0 (BiRefNet-based, CC BY-NC), run locally through onnxruntime.
// The models are declared in the YAML and downloaded from the node's panel into ctx.modelsDir.
import fs from "node:fs";
import path from "node:path";

const SIDE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const toPath = (v) => (typeof v === "string" ? v : v?.path);

export default async ({ inputs, params, ctx }) => {
  const src = toPath(inputs.image);
  if (!src) throw new Error("connect an image to the image input");
  const [{ default: sharp }, ort] = await Promise.all([import("sharp"), import("onnxruntime-node")]);

  const model = params.model || "birefnet-lite";
  const modelPath = path.join(ctx.modelsDir ?? "", `${model}.onnx`);
  if (!ctx.modelsDir || !fs.existsSync(modelPath)) {
    throw new Error(`model "${model}" isn't downloaded yet: open this node and click download model`);
  }

  // Oriented pixels of the original, and the 1024×1024 model input.
  const { data: rgb, info } = await sharp(src).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const small = await sharp(rgb, { raw: { width, height, channels: 3 } }).resize(SIDE, SIDE, { fit: "fill", kernel: "cubic" }).raw().toBuffer();
  const plane = SIDE * SIDE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (small[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }

  const t0 = Date.now();
  // CPU only: the CoreML provider can take only part of this graph and stalls on it.
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
  const t1 = Date.now();
  const result = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, SIDE, SIDE]) });
  const raw = result[session.outputNames[0]].data;
  ctx.log(`model loaded in ${((t1 - t0) / 1000).toFixed(1)}s, ran in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Logits or probabilities, depending on the export: squash to 0..1 either way.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < raw.length; i += 997) {
    lo = Math.min(lo, raw[i]);
    hi = Math.max(hi, raw[i]);
  }
  const logits = lo < -0.01 || hi > 1.01;
  const mask1024 = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) {
    const p = logits ? 1 / (1 + Math.exp(-raw[i])) : raw[i];
    mask1024[i] = Math.max(0, Math.min(255, Math.round(p * 255)));
  }
  const gray = { raw: { width, height, channels: 1 } };
  let mask = await sharp(mask1024, { raw: { width: SIDE, height: SIDE, channels: 1 } }).resize(width, height, { fit: "fill", kernel: "cubic" })
    // Resizing a one-channel raw image comes back as sRGB (3 channels) unless told otherwise.
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  // Edge clean-up, in order: hard threshold or soft cutoff, shrink, feather.
  const cut = params.threshold;
  if (cut !== undefined && cut !== null) {
    for (let i = 0; i < mask.length; i++) mask[i] = mask[i] >= cut * 255 ? 255 : 0;
  } else {
    const c = Math.max(0, Math.min(0.49, params.edge_cutoff ?? 0.1)) * 255;
    if (c > 0) for (let i = 0; i < mask.length; i++) mask[i] = Math.max(0, Math.min(255, Math.round(((mask[i] - c) * 255) / (255 - 2 * c))));
  }
  const shrink = Math.round(params.edge_shrink ?? 0);
  if (shrink > 0) mask = erode(mask, width, height, shrink);
  const feather = params.edge_feather ?? 0;
  if (feather >= 0.3) mask = await sharp(mask, gray).blur(feather).toColourspace("b-w").raw().toBuffer();

  // Take the old background's color out of semi-transparent edge pixels, so no halo remains.
  const pixels = params.decontaminate === false ? rgb : await decontaminate(sharp, rgb, mask, width, height);

  const name = path.basename(src).replace(/\.[^.]+$/, "") || "image";
  const imageOut = path.join(ctx.outDir, `${name}.png`);
  const maskOut = path.join(ctx.outDir, `${name}.mask.png`);
  await sharp(pixels, { raw: { width, height, channels: 3 } }).joinChannel(mask, gray).png().toFile(imageOut);
  await sharp(mask, gray).png().toFile(maskOut);
  ctx.log(`saved ${imageOut}`);
  return { image: imageOut, mask: maskOut };
};

/** Shrink the opaque area by r pixels (separable minimum filter). */
function erode(mask, w, h, r) {
  const tmp = Buffer.alloc(mask.length);
  const out = Buffer.alloc(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e && m; k++) if (mask[row + k] < m) m = mask[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 255;
      for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e && m; k++) if (tmp[k * w + x] < m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Color decontamination: estimate the background color near each edge pixel (a blur of the
 * background, weighted by transparency), then solve image = a·F + (1−a)·B for the foreground F.
 */
async function decontaminate(sharp, rgb, mask, w, h) {
  const n = w * h;
  const weighted = Buffer.alloc(n * 3);
  const weight = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const bw = 255 - mask[i];
    weight[i] = bw;
    for (let c = 0; c < 3; c++) weighted[i * 3 + c] = Math.round((rgb[i * 3 + c] * bw) / 255);
  }
  const sigma = Math.max(3, Math.min(w, h) / 120);
  const [bgSum, wSum] = await Promise.all([
    sharp(weighted, { raw: { width: w, height: h, channels: 3 } }).blur(sigma).raw().toBuffer(),
    sharp(weight, { raw: { width: w, height: h, channels: 1 } }).blur(sigma).toColourspace("b-w").raw().toBuffer(),
  ]);
  const out = Buffer.from(rgb);
  for (let i = 0; i < n; i++) {
    const a = mask[i] / 255;
    if (a <= 0.01 || a >= 0.99 || wSum[i] < 4) continue;
    const f = Math.max(a, 0.15);
    for (let c = 0; c < 3; c++) {
      const bg = (bgSum[i * 3 + c] * 255) / wSum[i];
      out[i * 3 + c] = Math.max(0, Math.min(255, Math.round((rgb[i * 3 + c] - (1 - a) * bg) / f)));
    }
  }
  return out;
}
