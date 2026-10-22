import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * AES-256-GCM encryption for credential values at rest. The key lives in <home>/secret.key
 * (mode 600), so copying the database alone does not expose stored API keys.
 */
export class SecretBox {
  private key: Buffer;

  constructor(home: string) {
    const file = path.join(home, "secret.key");
    if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    this.key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (this.key.length !== 32) throw new Error(`${file} is not a valid 32-byte key`);
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  decrypt<T = unknown>(blob: string): T {
    const buf = Buffer.from(blob, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8"));
  }
}
