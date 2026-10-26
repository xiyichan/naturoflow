// Background removal with BiRefNet (MIT), run locally through onnxruntime.
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
  const cut = params.threshold;
  const mask1024 = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) {
    let p = logits ? 1 / (1 + Math.exp(-raw[i])) : raw[i];
    if (cut !== undefined && cut !== null) p = p >= cut ? 1 : 0;
    mask1024[i] = Math.max(0, Math.min(255, Math.round(p * 255)));
  }
  const mask = await sharp(mask1024, { raw: { width: SIDE, height: SIDE, channels: 1 } }).resize(width, height, { fit: "fill", kernel: "cubic" })
    // Resizing a one-channel raw image comes back as sRGB (3 channels) unless told otherwise.
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const name = path.basename(src).replace(/\.[^.]+$/, "") || "image";
  const imageOut = path.join(ctx.outDir, `${name}.png`);
  const maskOut = path.join(ctx.outDir, `${name}.mask.png`);
  await sharp(rgb, { raw: { width, height, channels: 3 } }).joinChannel(mask, { raw: { width, height, channels: 1 } }).png().toFile(imageOut);
  await sharp(mask, { raw: { width, height, channels: 1 } }).png().toFile(maskOut);
  ctx.log(`saved ${imageOut}`);
  return { image: imageOut, mask: maskOut };
};
