// Minimal AWS Signature Version 4 for S3-compatible storage (no SDK).
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
import { createHash, createHmac } from "node:crypto";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as S3 expects; `/` kept when encoding an object key path. */
export function uriEncode(str, keepSlash = false) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, "/");
}

export function amzDate(d = new Date()) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signingKey(secret, date, region) {
  const kDate = hmac(`AWS4${secret}`, date);
  return hmac(hmac(hmac(kDate, region), "s3"), "aws4_request");
}

/** Path for a key: path-style `/bucket/key` or virtual-hosted `/key`. */
export function objectUrl({ endpoint, bucket, key, pathStyle = true }) {
  const base = new URL(endpoint);
  const encodedKey = uriEncode(key, true);
  if (pathStyle) return new URL(`${base.origin}/${uriEncode(bucket)}/${encodedKey}`);
  return new URL(`${base.protocol}//${bucket}.${base.host}/${encodedKey}`);
}

function canonicalQuery(params) {
  return [...params.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * Sign a request with an Authorization header. `headers` are lowercase names; host and
 * x-amz-date / x-amz-content-sha256 are added. Returns the headers to send.
 */
export function signRequest({ method, url, headers = {}, payloadHash, accessKeyId, secretAccessKey, region = "us-east-1", date = new Date() }) {
  const t = amzDate(date);
  const day = t.slice(0, 8);
  const all = { ...headers, host: url.host, "x-amz-date": t, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const canonical = [
    method,
    url.pathname,
    canonicalQuery(url.searchParams),
    names.map((h) => `${h}:${lower[h]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", t, scope, sha256(canonical)].join("\n");
  const signature = hmac(signingKey(secretAccessKey, day, region), toSign).toString("hex");
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/** A presigned GET URL valid for `expires` seconds (max 7 days). */
export function presignGet({ url, accessKeyId, secretAccessKey, region = "us-east-1", expires = 604800, date = new Date() }) {
  const t = amzDate(date);
  const day = t.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const u = new URL(url);
  u.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  u.searchParams.set("X-Amz-Credential", `${accessKeyId}/${scope}`);
  u.searchParams.set("X-Amz-Date", t);
  u.searchParams.set("X-Amz-Expires", String(Math.min(Math.max(1, Math.floor(expires)), 604800)));
  u.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonical = ["GET", u.pathname, canonicalQuery(u.searchParams), `host:${u.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", t, scope, sha256(canonical)].join("\n");
  const signature = hmac(signingKey(secretAccessKey, day, region), toSign).toString("hex");
  return `${u.origin}${u.pathname}?${canonicalQuery(u.searchParams)}&X-Amz-Signature=${signature}`;
}

export { sha256 };
