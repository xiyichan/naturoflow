// Seedream image generation (BytePlus ModelArk), following
// https://docs.byteplus.com/en/docs/modelark/image-generation-api
//
// Text-to-image, image-to-image, multi-image blending, interactive editing (<bbox> in the prompt),
// layer decomposition, transparent background, sequential generation. Only parameters that are set
// are sent. Reference images may be URLs, data URLs or local files (sent as base64). Generated
// images are downloaded into the node's output directory unless `download` is off.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
const IMAGE_MIME = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp", ".bmp": "bmp", ".tif": "tiff", ".tiff": "tiff", ".gif": "gif", ".heic": "heic", ".heif": "heif" };

/** Flatten port/param image values into a list of strings/file refs. */
function collectImages(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(collectImages);
  if (typeof value === "object" && value.$file) return [value];
  if (typeof value === "string") {
    // A param may hold several, one per line.
    return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  throw new Error(`unsupported image value: ${JSON.stringify(value).slice(0, 100)}`);
}

/** URL / data URL pass through; local files become data:image/<fmt>;base64,... */
function toApiImage(img) {
  const p = typeof img === "object" ? img.path : img;
  if (/^(https?:|data:)/i.test(p)) return p;
  const file = p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p;
  if (!fs.existsSync(file)) throw new Error(`reference image not found: ${p} (use a URL, a data URL, or a local file path)`);
  const fmt = IMAGE_MIME[path.extname(file).toLowerCase()];
  if (!fmt) throw new Error(`unsupported image format: ${path.basename(file)}`);
  return `data:image/${fmt};base64,${fs.readFileSync(file).toString("base64")}`;
}

const short = (s, n = 120) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s);

/** For logs/history: shorten base64 so a response doesn't flood them. */
function forDisplay(v) {
  if (typeof v === "string") return v.startsWith("data:") || v.length > 2000 ? short(v) : v;
  if (Array.isArray(v)) return v.map(forDisplay);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "b64_json" ? short(x, 40) : forDisplay(x)]));
  return v;
}

export default async ({ inputs, params, ctx }) => {
  const apiKey = ctx.credential?.api_key;
  if (!apiKey) throw new Error("no API key: select or create a BytePlus ModelArk credential on this node");
  const base = (ctx.credential.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");

  // Order matters ("图1", "图2" in prompts): ports image, image_2, image_3, image_4, then param lines.
  // The same image arriving twice (e.g. from a port and pasted into the param) is sent once.
  const images = [...new Set([inputs.image, inputs.image_2, inputs.image_3, inputs.image_4, params.image].flatMap(collectImages).map(toApiImage))];

  // Build the body from set values only.
  const body = { model: params.model };
  const set = (k, v) => {
    if (v !== undefined && v !== null && v !== "") body[k] = v;
  };
  set("prompt", params.prompt);
  if (images.length) body.image = images.length === 1 ? images[0] : images;
  set("layer_decomposition", params.layer_decomposition);
  set("size", params.size);
  if (params.optimize_prompt_mode) body.optimize_prompt_options = { mode: params.optimize_prompt_mode };
  set("output_format", params.output_format);
  set("background", params.background);
  set("response_format", params.response_format);
  set("sequential_image_generation", params.sequential_image_generation);
  if (params.max_images !== undefined && params.max_images !== null && params.max_images !== "") {
    body.sequential_image_generation_options = { max_images: Number(params.max_images) };
  }
  set("watermark", params.watermark);

  if (!body.prompt && !body.layer_decomposition) throw new Error("prompt is required (only layer decomposition can run without one)");
  if (body.layer_decomposition && images.length !== 1) throw new Error(`layer decomposition needs exactly one image, got ${images.length}`);

  const url = `${base}/images/generations`;
  ctx.log(`POST ${url}`);
  ctx.log(`request: ${JSON.stringify(forDisplay(body), null, 2)}`);
  ctx.trace({ request: { method: "POST", url, headers: { "content-type": "application/json", authorization: "Bearer ****" }, body: forDisplay(body) } });

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  ctx.log(`-> ${res.status} ${res.statusText}`);
  ctx.trace({ response: { status: res.status, statusText: res.statusText, body: json ? forDisplay(json) : short(text, 2000) } });
  if (!res.ok || !json) {
    const msg = json?.error?.message ?? text.slice(0, 800);
    throw new Error(`HTTP ${res.status}: ${msg}${json?.error?.code ? ` (${json.error.code})` : ""}`);
  }
  ctx.log(`response: ${JSON.stringify(forDisplay(json), null, 2)}`);

  const data = Array.isArray(json.data) ? json.data : [];
  for (const [i, d] of data.entries()) if (d.error) ctx.log(`image ${i} failed: ${d.error.code ?? ""} ${d.error.message ?? ""}`);
  const ok = data.filter((d) => !d.error && (d.url || d.b64_json));
  if (!ok.length) throw new Error("the API returned no images");

  // Save every image locally (URLs expire after 24 hours).
  const files = [];
  if (params.download !== false) {
    for (const [i, d] of ok.entries()) {
      const ext = (d.output_format === "jpeg" ? "jpg" : d.output_format) || (d.z_index > 0 ? "png" : "jpg");
      const name = ok.length === 1 ? `image.${ext}` : d.z_index !== undefined ? `layer_${String(d.z_index).padStart(2, "0")}.${ext}` : `image_${i + 1}.${ext}`;
      const file = path.join(ctx.outDir, name);
      if (d.b64_json) fs.writeFileSync(file, Buffer.from(d.b64_json, "base64"));
      else {
        const r = await fetch(d.url);
        if (!r.ok) throw new Error(`downloading image ${i + 1} failed: HTTP ${r.status}`);
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      }
      ctx.log(`saved ${file}`);
      files.push(file);
    }
  }

  // Keep base64 out of stored outputs; the files hold the pixels.
  const imagesOut = data.map((d, i) => {
    const { b64_json, ...rest } = d;
    return { ...rest, ...(b64_json ? { b64_json: `(${b64_json.length} chars, saved to file)` } : {}), ...(files[ok.indexOf(d)] ? { file: files[ok.indexOf(d)] } : {}) };
  });
  const layers = body.layer_decomposition
    ? imagesOut.filter((d) => d.z_index !== undefined).map(({ z_index, name, description, bounding_box, size, url, file }) => ({ z_index, name, description, bounding_box, size, url, file }))
    : undefined;

  return {
    file: files[0],
    files,
    url: ok[0].url,
    urls: ok.map((d) => d.url).filter(Boolean),
    images: imagesOut,
    ...(layers ? { layers } : {}),
    usage: json.usage,
  };
};
