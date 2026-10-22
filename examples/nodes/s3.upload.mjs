// Upload files to S3 or any S3-compatible storage (e.g. as an image host) and return their URLs.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { objectUrl, presignGet, sha256, signRequest } from "./s3-sign.mjs";

function filesFrom(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(filesFrom);
  if (typeof value === "object" && value.$file) return [value];
  if (typeof value === "string") return [{ path: value, mime: undefined }];
  throw new Error(`expected a file or a list of files, got ${JSON.stringify(value).slice(0, 80)}`);
}

/** Fill {date} {time} {uuid} {name} {ext} {index} in the key template. */
function keyFor(template, file, index, now) {
  const base = path.basename(file.path);
  const ext = path.extname(base).replace(/^\./, "");
  const name = ext ? base.slice(0, -(ext.length + 1)) : base;
  const pad = (n) => String(n).padStart(2, "0");
  const vars = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    uuid: randomUUID(),
    name,
    ext,
    filename: base,
    index: String(index + 1),
  };
  const key = template.replace(/\{(\w+)\}/g, (m, v) => vars[v] ?? m).replace(/^\/+/, "");
  // A template without {name}/{filename}/{uuid} would overwrite itself on multi-file uploads.
  return key;
}

export default async ({ inputs, params, ctx }) => {
  const c = ctx.credential ?? {};
  const accessKeyId = c.access_key_id;
  const secretAccessKey = c.secret_access_key;
  if (!accessKeyId || !secretAccessKey) throw new Error("select or create an S3 credential on this node");
  if (!c.endpoint) throw new Error("the S3 credential has no endpoint");
  const region = c.region || "us-east-1";
  const bucket = params.bucket || c.bucket;
  if (!bucket) throw new Error("no bucket: set it on this node or as the credential's default bucket");
  const pathStyle = c.addressing !== "virtual-hosted";

  const files = filesFrom(inputs.file);
  if (!files.length) throw new Error("nothing to upload: connect a file");
  const template = params.key || "naturoflow/{date}/{name}-{uuid}.{ext}";
  const now = new Date();
  const uploads = [];

  for (const [i, f] of files.entries()) {
    if (!fs.existsSync(f.path)) throw new Error(`file not found: ${f.path}`);
    const body = fs.readFileSync(f.path);
    const key = keyFor(template, f, i, now);
    const url = objectUrl({ endpoint: c.endpoint, bucket, key, pathStyle });
    const headers = { "content-type": params.content_type || f.mime || "application/octet-stream" };
    if (params.acl) headers["x-amz-acl"] = params.acl;
    if (params.cache_control) headers["cache-control"] = params.cache_control;

    const signed = signRequest({ method: "PUT", url, headers, payloadHash: sha256(body), accessKeyId, secretAccessKey, region });
    ctx.log(`PUT ${url} (${body.length} bytes, ${headers["content-type"]})`);
    ctx.trace({
      request: { method: "PUT", url: url.toString(), headers: { ...headers, authorization: "AWS4-HMAC-SHA256 ****" }, body: `(${body.length} bytes from ${f.path})` },
    });
    const res = await fetch(url, { method: "PUT", headers: signed, body });
    const text = await res.text();
    ctx.log(`-> ${res.status} ${res.statusText}`);
    ctx.trace({ response: { status: res.status, statusText: res.statusText, etag: res.headers.get("etag") ?? undefined, body: text.slice(0, 2000) || undefined } });
    if (!res.ok) {
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
      throw new Error(`S3 upload failed: HTTP ${res.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : text ? `: ${text.slice(0, 300)}` : ""}`);
    }

    // Public URL: a configured public base (CDN / custom domain) or the object's own URL.
    const publicUrl = c.public_base_url ? `${c.public_base_url.replace(/\/+$/, "")}/${url.pathname.split("/").slice(pathStyle ? 2 : 1).join("/")}` : url.toString();
    const presigned = params.presign === false ? undefined : presignGet({ url: url.toString(), accessKeyId, secretAccessKey, region, expires: Number(params.presign_expires ?? 604800) });
    uploads.push({ bucket, key, url: publicUrl, ...(presigned ? { presigned_url: presigned } : {}), etag: res.headers.get("etag") ?? undefined, size: body.length, content_type: headers["content-type"], file: f.path });
    ctx.log(`uploaded ${key} -> ${publicUrl}`);
  }

  return {
    url: uploads[0].url,
    urls: uploads.map((u) => u.url),
    presigned_url: uploads[0].presigned_url,
    presigned_urls: uploads.map((u) => u.presigned_url).filter(Boolean),
    keys: uploads.map((u) => u.key),
    uploads,
  };
};
