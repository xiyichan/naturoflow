// Gemini image generation (Nano Banana) through generateContent.
// Reference images are sent inline as base64; generated images come back as inlineData and are
// saved into the node's output directory. Parts marked `thought` are the model's drafts.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif" };
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Flatten port/param image values into a list of strings/file refs. */
function collectImages(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(collectImages);
  if (typeof value === "object" && value.$file) return [value];
  if (typeof value === "string") return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  throw new Error(`unsupported image value: ${JSON.stringify(value).slice(0, 100)}`);
}

/** A reference image as an inlineData part: local files and URLs are read and base64-encoded. */
async function toPart(img, signal) {
  const p = typeof img === "object" ? img.path : img;
  const data = /^data:([^;]+);base64,(.*)$/s.exec(p);
  if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
  if (/^https?:/i.test(p)) {
    const res = await fetch(p, { signal });
    if (!res.ok) throw new Error(`downloading reference image failed: HTTP ${res.status} ${p.slice(0, 120)}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const mimeType = type.startsWith("image/") ? type : MIME[path.extname(new URL(p).pathname).toLowerCase()] ?? "image/png";
    return { inlineData: { mimeType, data: Buffer.from(await res.arrayBuffer()).toString("base64") } };
  }
  const file = p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p;
  if (!fs.existsSync(file)) throw new Error(`reference image not found: ${p} (use a URL or a local file path)`);
  const mimeType = MIME[path.extname(file).toLowerCase()];
  if (!mimeType) throw new Error(`unsupported image format: ${path.basename(file)}`);
  return { inlineData: { mimeType, data: fs.readFileSync(file).toString("base64") } };
}

/** For logs/history: replace base64 with its length. */
function forDisplay(v) {
  if (Array.isArray(v)) return v.map(forDisplay);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "data" && typeof x === "string" ? `(${x.length} chars base64)` : forDisplay(x)]));
  return v;
}

export default async ({ inputs, params, ctx }) => {
  const apiKey = ctx.credential?.api_key;
  if (!apiKey) throw new Error("no API key: select or create a Gemini credential on this node");
  const base = (ctx.credential.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const prompt = typeof inputs.prompt === "string" && inputs.prompt.trim() ? inputs.prompt : params.prompt;
  if (!prompt?.trim()) throw new Error("write a prompt (param prompt, or connect the prompt input)");

  // Ports in order, then param lines; the same image arriving twice is sent once.
  const refs = [...new Set([inputs.image, inputs.image_2, inputs.image_3, inputs.image_4, params.image].flatMap(collectImages).map((x) => (typeof x === "object" ? x.path : x)))];
  const parts = [{ text: prompt }];
  for (const r of refs) parts.push(await toPart(r, ctx.signal));

  const generationConfig = { responseModalities: params.image_only ? ["IMAGE"] : ["TEXT", "IMAGE"] };
  const imageConfig = {};
  if (params.aspect_ratio) imageConfig.aspectRatio = params.aspect_ratio;
  if (params.image_size) imageConfig.imageSize = params.image_size;
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  if (params.temperature !== undefined && params.temperature !== null) generationConfig.temperature = params.temperature;
  if (params.seed !== undefined && params.seed !== null) generationConfig.seed = params.seed;

  const body = { contents: [{ role: "user", parts }], generationConfig };
  if (params.system?.trim()) body.systemInstruction = { parts: [{ text: params.system }] };

  const url = `${base}/models/${encodeURIComponent(params.model)}:generateContent`;
  ctx.log(`POST ${url} (${refs.length} reference image${refs.length === 1 ? "" : "s"})`);
  ctx.trace({ request: { method: "POST", url, body: forDisplay(body) } });

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  ctx.trace({ response: { status: res.status, body: forDisplay(json) } });
  if (!res.ok) {
    const msg = json?.error?.message ?? (typeof json === "string" ? json.slice(0, 500) : JSON.stringify(json).slice(0, 500));
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  if (json?.promptFeedback?.blockReason) throw new Error(`prompt blocked: ${json.promptFeedback.blockReason}`);

  const candidate = json?.candidates?.[0];
  const outParts = candidate?.content?.parts ?? [];
  const finals = [];
  const drafts = [];
  const texts = [];
  const thoughts = [];
  for (const part of outParts) {
    if (part.inlineData?.data) (part.thought ? drafts : finals).push(part.inlineData);
    else if (typeof part.text === "string") (part.thought ? thoughts : texts).push(part.text);
  }
  if (!finals.length) {
    const reason = candidate?.finishReason && candidate.finishReason !== "STOP" ? ` (finishReason: ${candidate.finishReason})` : "";
    throw new Error(`the model returned no image${reason}${texts.length ? `: ${texts.join(" ").slice(0, 300)}` : ""}`);
  }

  const save = (list, prefix) =>
    list.map((d, i) => {
      const file = path.join(ctx.outDir, `${prefix}${list.length > 1 ? `_${i + 1}` : ""}.${EXT[d.mimeType] ?? "png"}`);
      fs.writeFileSync(file, Buffer.from(d.data, "base64"));
      ctx.log(`saved ${file}`);
      return file;
    });
  const files = save(finals, "image");
  const draftFiles = params.keep_drafts ? save(drafts, "draft") : undefined;
  if (texts.length) ctx.log(`text: ${texts.join("\n").slice(0, 500)}`);

  return {
    file: files[0],
    files,
    ...(texts.length ? { text: texts.join("\n") } : {}),
    ...(thoughts.length ? { thoughts: thoughts.join("\n") } : {}),
    ...(draftFiles ? { drafts: draftFiles } : {}),
    ...(json.usageMetadata ? { usage: json.usageMetadata } : {}),
  };
};
