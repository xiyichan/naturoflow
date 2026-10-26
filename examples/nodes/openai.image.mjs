// OpenAI image API (gpt-image models): POST /images/generations (JSON) without reference images,
// POST /images/edits (multipart) with them. Images come back as b64_json (or a URL from older
// models) and are saved into the node's output directory.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Flatten port/param image values into a list of paths/URLs. */
function collect(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(collect);
  if (typeof value === "object" && value.$file) return [value.path];
  if (typeof value === "string") return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  throw new Error(`unsupported image value: ${JSON.stringify(value).slice(0, 100)}`);
}

/** A reference image as a named Blob for multipart upload. */
async function toBlob(ref, signal) {
  const data = /^data:([^;]+);base64,(.*)$/s.exec(ref);
  if (data) return { blob: new Blob([Buffer.from(data[2], "base64")], { type: data[1] }), name: `image.${EXT[data[1]] ?? "png"}` };
  if (/^https?:/i.test(ref)) {
    const res = await fetch(ref, { signal });
    if (!res.ok) throw new Error(`downloading reference image failed: HTTP ${res.status} ${ref.slice(0, 120)}`);
    const urlName = path.basename(new URL(ref).pathname) || "image";
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim() || MIME[path.extname(urlName).toLowerCase()] || "image/png";
    return { blob: new Blob([await res.arrayBuffer()], { type }), name: path.extname(urlName) ? urlName : `${urlName}.${EXT[type] ?? "png"}` };
  }
  const file = ref.startsWith("~/") ? path.join(process.env.HOME ?? "", ref.slice(2)) : ref;
  if (!fs.existsSync(file)) throw new Error(`reference image not found: ${ref} (use a URL or a local file path)`);
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`unsupported image format: ${path.basename(file)} (use png, jpeg or webp)`);
  return { blob: new Blob([fs.readFileSync(file)], { type }), name: path.basename(file) };
}

/** For logs/history: shorten base64. */
function forDisplay(v) {
  if (Array.isArray(v)) return v.map(forDisplay);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "b64_json" && typeof x === "string" ? `(${x.length} chars base64)` : forDisplay(x)]));
  return v;
}

export default async ({ inputs, params, ctx }) => {
  const apiKey = ctx.credential?.api_key;
  if (!apiKey) throw new Error("no API key: select or create an OpenAI credential on this node");
  const base = (ctx.credential.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const prompt = typeof inputs.prompt === "string" && inputs.prompt.trim() ? inputs.prompt : params.prompt;
  if (!prompt?.trim()) throw new Error("write a prompt (param prompt, or connect the prompt input)");

  const refs = [...new Set([inputs.image, inputs.image_2, inputs.image_3, inputs.image_4, params.image].flatMap(collect))];
  const mask = collect(inputs.mask)[0];
  const mode = params.mode && params.mode !== "auto" ? params.mode : refs.length ? "edit" : "generate";
  if (mode === "edit" && !refs.length) throw new Error("edit mode needs at least one reference image");

  // Only fields that are set; some apply to one endpoint only.
  const fields = { model: params.model, prompt };
  const set = (k, v) => {
    if (v !== undefined && v !== null && v !== "") fields[k] = v;
  };
  for (const k of ["n", "size", "quality", "background", "output_format", "output_compression"]) set(k, params[k]);
  if (mode === "edit") set("input_fidelity", params.input_fidelity);
  else set("moderation", params.moderation);
  if (params.extra && typeof params.extra === "object") Object.assign(fields, params.extra);

  const url = `${base}/images/${mode === "edit" ? "edits" : "generations"}`;
  let body;
  const headers = { authorization: `Bearer ${apiKey}` };
  if (mode === "edit") {
    body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    // One image goes as `image`; several as repeated `image[]`.
    const key = refs.length > 1 ? "image[]" : "image";
    for (const ref of refs) {
      const { blob, name } = await toBlob(ref, ctx.signal);
      body.append(key, blob, name);
    }
    if (mask) {
      const { blob, name } = await toBlob(mask, ctx.signal);
      body.append("mask", blob, name);
    }
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(fields);
  }

  ctx.log(`POST ${url}${mode === "edit" ? ` (${refs.length} reference image${refs.length === 1 ? "" : "s"}${mask ? " + mask" : ""})` : ""}`);
  ctx.trace({ request: { method: "POST", url, body: { ...fields, ...(mode === "edit" ? { image: refs, ...(mask ? { mask } : {}) } : {}) } } });

  const res = await fetch(url, { method: "POST", headers, body, signal: ctx.signal });
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
  const data = Array.isArray(json?.data) ? json.data : [];
  if (!data.length) throw new Error(`the API returned no images: ${JSON.stringify(forDisplay(json)).slice(0, 300)}`);

  const format = json.output_format ?? params.output_format ?? "png";
  const ext = format === "jpeg" ? "jpg" : format;
  const files = [];
  for (const [i, d] of data.entries()) {
    const file = path.join(ctx.outDir, `image${data.length > 1 ? `_${i + 1}` : ""}.${ext}`);
    if (d.b64_json) fs.writeFileSync(file, Buffer.from(d.b64_json, "base64"));
    else if (d.url) {
      const r = await fetch(d.url, { signal: ctx.signal });
      if (!r.ok) throw new Error(`downloading image ${i + 1} failed: HTTP ${r.status}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    } else continue;
    ctx.log(`saved ${file}`);
    files.push(file);
  }
  if (!files.length) throw new Error("the API response had no image data (b64_json or url)");

  const revised = data.find((d) => d.revised_prompt)?.revised_prompt;
  return {
    file: files[0],
    files,
    ...(revised ? { revised_prompt: revised } : {}),
    ...(json.usage ? { usage: json.usage } : {}),
  };
};
