import fs from "node:fs";
import path from "node:path";
import type { FileRef } from "./types.ts";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

export function guessMime(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

export function isFileRef(v: unknown): v is FileRef {
  return !!v && typeof v === "object" && (v as FileRef).$file === true;
}

export function toFileRef(v: unknown): FileRef {
  if (isFileRef(v)) return v;
  const p = typeof v === "string" ? v : (v as { path?: string })?.path;
  if (typeof p !== "string") throw new Error(`expected a file path, got ${JSON.stringify(v)}`);
  const abs = path.resolve(p);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error(`file not found: ${abs}`);
  return { $file: true, path: abs, size: st.size, mime: guessMime(abs) };
}
