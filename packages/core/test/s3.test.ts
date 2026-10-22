import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService } from "../src/index.ts";
// @ts-expect-error plain JS module shared with the s3.upload node
import { objectUrl, presignGet, sha256, signRequest, uriEncode } from "../../../examples/nodes/s3-sign.mjs";

// Test vectors from the AWS SigV4 documentation (example credentials, not real ones).
const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
const date = new Date("2013-05-24T00:00:00Z");

describe("SigV4 signing", () => {
  it("matches the AWS 'GET Object' header-signing example", () => {
    const headers = signRequest({
      ...creds,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: sha256(""),
      date,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("matches the AWS presigned URL example", () => {
    const url = presignGet({ ...creds, url: "https://examplebucket.s3.amazonaws.com/test.txt", expires: 86400, date });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("builds path-style and virtual-hosted object URLs with encoded keys", () => {
    expect(objectUrl({ endpoint: "https://s3.example.com", bucket: "pics", key: "a b/猫(1).png" }).toString()).toBe(
      "https://s3.example.com/pics/a%20b/%E7%8C%AB%281%29.png",
    );
    expect(objectUrl({ endpoint: "https://s3.example.com", bucket: "pics", key: "x.png", pathStyle: false }).toString()).toBe(
      "https://pics.s3.example.com/x.png",
    );
    expect(uriEncode("a/b c")).toBe("a%2Fb%20c");
  });
});

describe("s3.upload node", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-s3-"));
  const SECRET = "test-secret-key-0000";
  const stored = new Map<string, { body: Buffer; headers: http.IncomingHttpHeaders }>();
  let server: http.Server;
  let endpoint: string;
  let svc: NaturoflowService;
  let cred: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url!, endpoint);
        if (url.pathname.startsWith("/denied/")) {
          res.writeHead(403, { "content-type": "application/xml" });
          return res.end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
        }
        // Re-sign with the server's copy of the secret; the signature must match.
        const auth = String(req.headers.authorization);
        const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)![1].split(";");
        const amzDate = String(req.headers["x-amz-date"]);
        const expected = signRequest({
          method: req.method,
          url: new URL(req.url!, `http://${req.headers.host}`),
          headers: Object.fromEntries(signedHeaders.filter((h) => !["host", "x-amz-date", "x-amz-content-sha256"].includes(h)).map((h) => [h, String(req.headers[h])])),
          payloadHash: sha256(body),
          accessKeyId: "AKIDTEST",
          secretAccessKey: SECRET,
          region: "us-east-1",
          date: new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`),
        });
        if (expected.authorization !== auth || req.headers["x-amz-content-sha256"] !== sha256(body)) {
          res.writeHead(403);
          return res.end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
        }
        stored.set(decodeURIComponent(url.pathname), { body, headers: req.headers });
        res.writeHead(200, { etag: '"abc123"' });
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    svc = new NaturoflowService({ home, allowedBins: [], concurrency: 2, nodeDirs: [path.resolve(import.meta.dirname, "../../../examples/nodes")], watch: false });
    cred = svc.createCredential({ type: "s3", name: "test", data: { access_key_id: "AKIDTEST", secret_access_key: SECRET, endpoint, bucket: "pics" } }).id;
  });

  afterAll(() => {
    svc.close();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const fileRef = (name: string, data: string) => {
    const p = path.join(home, name);
    fs.writeFileSync(p, data);
    return { $file: true, path: p, size: data.length, mime: "image/png" };
  };

  const run = (value: unknown, params: Record<string, unknown> = {}, credential = cred) =>
    svc.runWorkflow({
      id: "s3",
      name: "s3",
      nodes: [
        { id: "f", type: "core.const", params: { value } },
        { id: "up", type: "s3.upload", credential, params },
      ],
      edges: [{ from: { node: "f", port: "value" }, to: { node: "up", port: "file" } }],
    });

  it("uploads a file with a valid signature and returns its URLs", async () => {
    const r = await run(fileRef("cat 猫.png", "PNGDATA"), { key: "img/{name}.{ext}", acl: "public-read" });
    expect(r.status).toBe("success");
    const out = r.nodes.up.outputs!;
    expect(out.keys).toEqual(["img/cat 猫.png"]);
    expect(out.public_url).toBe(`${endpoint}/pics/img/cat%20%E7%8C%AB.png`);
    // By default `url` is the presigned link, which works for private buckets.
    expect(out.url).toBe(out.presigned_url);
    expect(String(out.url).startsWith(`${endpoint}/pics/img/cat%20%E7%8C%AB.png?X-Amz-Algorithm=AWS4-HMAC-SHA256`)).toBe(true);
    const obj = stored.get("/pics/img/cat 猫.png")!;
    expect(obj.body.toString()).toBe("PNGDATA");
    expect(obj.headers["content-type"]).toBe("image/png");
    expect(obj.headers["x-amz-acl"]).toBe("public-read");
    expect(String(out.presigned_url)).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    // The secret never shows up in the run record.
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("uploads every file of a list and uses the public base URL", async () => {
    const cdn = svc.createCredential({ type: "s3", name: "cdn", data: { access_key_id: "AKIDTEST", secret_access_key: SECRET, endpoint, bucket: "pics", public_base_url: "https://img.example.com/" } }).id;
    const r = await run([fileRef("a.png", "A"), fileRef("b.png", "B")], { key: "batch/{index}-{name}.{ext}", url_type: "public" }, cdn);
    expect(r.status).toBe("success");
    expect(r.nodes.up.outputs!.urls).toEqual(["https://img.example.com/batch/1-a.png", "https://img.example.com/batch/2-b.png"]);
    expect(r.nodes.up.outputs!.presigned_urls).toHaveLength(2);
  });

  it("reports S3 errors and a missing bucket clearly", async () => {
    const denied = await run(fileRef("x.png", "X"), { bucket: "denied" });
    expect(denied.nodes.up.error).toBe("S3 upload failed: HTTP 403 AccessDenied: Access Denied");
    const nobucket = svc.createCredential({ type: "s3", name: "nb", data: { access_key_id: "AKIDTEST", secret_access_key: SECRET, endpoint } }).id;
    const nb = await run(fileRef("y.png", "Y"), {}, nobucket);
    expect(nb.nodes.up.error).toMatch(/no bucket/);
  }, 30_000); // each failure is retried once after 3s
});
