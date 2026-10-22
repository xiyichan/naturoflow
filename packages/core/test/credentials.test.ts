import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService, type WorkflowInput } from "../src/index.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-cred-"));
let svc: NaturoflowService;
let server: http.Server;
let base: string;
const seen: string[] = [];

beforeAll(async () => {
  svc = new NaturoflowService({ home, allowedBins: [], concurrency: 2, nodeDirs: [] });
  server = http.createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    const ok = req.headers.authorization === "Bearer key-one-secret" || req.headers.authorization === "Bearer key-two-secret";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { who: req.headers.authorization } : { error: `bad key ${req.headers.authorization}` }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  svc.saveNodeType({
    id: "test.api",
    name: "api",
    credentials: { type: "test-cred", name: "Test API", fields: { api_key: { label: "API Key" }, region: { secret: false, required: false } } },
    params: { type: "object", properties: { url: { type: "string" } } },
    outputs: { body: { type: "json" } },
    executor: {
      kind: "http",
      url: "{{params.url}}",
      headers: { Authorization: "Bearer {{credential.api_key}}" },
      outputs: { body: "{{body}}" },
    },
  });
});

afterAll(() => {
  svc.close();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const wf = (credential?: string): WorkflowInput => ({
  id: "w",
  name: "w",
  nodes: [
    { id: "call", type: "test.api", params: { url: base }, ...(credential ? { credential } : {}) },
    { id: "out", type: "core.output", params: { key: "body" } },
  ],
  edges: [{ from: { node: "call", port: "body" }, to: { node: "out", port: "value" } }],
});

describe("credentials", () => {
  it("stores several credentials per type and never exposes secret values", () => {
    const one = svc.createCredential({ type: "test-cred", name: "key 1", data: { api_key: "key-one-secret", region: "sg" } });
    svc.createCredential({ type: "test-cred", name: "key 2", data: { api_key: "key-two-secret" } });
    const list = svc.listCredentials("test-cred");
    expect(list.map((c) => c.name)).toEqual(["key 1", "key 2"]);
    expect(list[0]).toMatchObject({ fields: ["api_key", "region"], values: { region: "sg" } });
    expect(JSON.stringify(list)).not.toContain("secret");
    // Encrypted at rest: the plaintext key is not in the database file.
    const db = fs.readFileSync(path.join(home, "naturoflow.db")).toString("latin1") + fs.readFileSync(path.join(home, "naturoflow.db-wal")).toString("latin1");
    expect(db).not.toContain("key-one-secret");
    expect(fs.statSync(path.join(home, "secret.key")).mode & 0o777).toBe(0o600);
    expect(one.id).toHaveLength(8);
  });

  it("each node uses the credential it selected", async () => {
    const [one, two] = svc.listCredentials("test-cred");
    const r1 = await svc.runWorkflow(wf(one.id));
    const r2 = await svc.runWorkflow(wf(two.id));
    expect(r1.outputs?.body).toEqual({ who: "Bearer key-one-secret" });
    expect(r2.outputs?.body).toEqual({ who: "Bearer key-two-secret" });
    // The mock API echoes the key back; the logged response and outputs are masked.
    const logs = r1.nodes.call.logs.join("\n");
    expect(logs).toContain('"who": "Bearer ****"');
    expect(logs).not.toContain("key-one-secret");
  });

  it("keeps a per-node history with masked request/response traces", async () => {
    const [one, two] = svc.listCredentials("test-cred").filter((c) => c.name.startsWith("key"));
    svc.saveWorkflow({ ...wf(one.id), id: "hist" });
    await svc.runWorkflow("hist");
    svc.applyPatch("hist", [{ op: "update_node", id: "call", credential: two.id }]);
    await svc.runWorkflow("hist");
    const h = svc.nodeHistory("hist", "call");
    expect(h).toHaveLength(2);
    expect(h[0].runStartedAt).toBeGreaterThanOrEqual(h[1].runStartedAt);
    const latest = h[0].node;
    expect(latest.status).toBe("success");
    expect(latest.params).toEqual({ url: base });
    expect(latest.trace?.request).toMatchObject({ method: "GET", url: `${base}/`, headers: { authorization: "Bearer ****" } });
    expect(latest.trace?.response).toMatchObject({ status: 200, body: { who: "Bearer ****" } });
    const leaks: string[] = [];
    const walk = (v: unknown, p: string) => {
      if (typeof v === "string" && /key-(one|two)-secret/.test(v)) leaks.push(p);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
    };
    walk(h, "h");
    expect(leaks).toEqual([]);
    // Paging and other nodes.
    expect(svc.nodeHistory("hist", "call", { limit: 1 })).toHaveLength(1);
    expect(svc.nodeHistory("hist", "call", { before: h[0].runStartedAt })).toHaveLength(h[0].runStartedAt === h[1].runStartedAt ? 0 : 1);
    expect(svc.nodeHistory("hist", "out")[0].node.outputs).toEqual({ value: { who: "Bearer ****" } });
  });

  it("validates and fails clearly without a usable credential", async () => {
    expect(svc.validateWorkflow(wf()).map((i) => i.code)).toEqual(["MISSING_CREDENTIAL"]);
    expect(svc.validateWorkflow(wf("nope")).map((i) => i.code)).toEqual(["CREDENTIAL_NOT_FOUND"]);
    const run = await svc.runWorkflow(wf());
    expect(run.nodes.call.error).toMatch(/no credential selected/);
  });

  it("masks secrets in logs and errors", async () => {
    const bad = svc.createCredential({ type: "test-cred", name: "bad", data: { api_key: "wrong-key-value" } });
    const run = await svc.runWorkflow(wf(bad.id));
    expect(run.status).toBe("failed");
    const text = JSON.stringify(run);
    expect(text).not.toContain("wrong-key-value");
    expect(run.nodes.call.error).toContain("****");
  });

  it("updates keep unchanged fields and reject unknown ones", () => {
    const one = svc.listCredentials("test-cred").find((c) => c.name === "key 1")!;
    const updated = svc.updateCredential(one.id, { name: "key 1 (main)", data: { api_key: "" } });
    expect(updated.name).toBe("key 1 (main)");
    expect(updated.fields).toEqual(["api_key", "region"]);
    expect(() => svc.updateCredential(one.id, { data: { nope: "x" } as never })).toThrow(/unknown credential field/);
    expect(() => svc.createCredential({ type: "test-cred", name: "empty", data: {} })).toThrow(/required/);
    expect(() => svc.createCredential({ type: "nobody", name: "x", data: {} })).toThrow(/no node type declares/);
  });

  it("nodes can switch credentials through a patch", () => {
    const byName = (n: string) => svc.listCredentials("test-cred").find((c) => c.name === n)!;
    const [one, two] = [byName("key 1 (main)"), byName("key 2")];
    svc.saveWorkflow(wf(one.id));
    svc.applyPatch("w", [{ op: "update_node", id: "call", credential: two.id }]);
    expect(svc.getWorkflow("w").nodes[0].credential).toBe(two.id);
    expect(svc.credentialUsage(two.id).filter((u) => u.workflowId === "w")).toEqual([{ workflowId: "w", nodeId: "call" }]);
    svc.applyPatch("w", [{ op: "update_node", id: "call", credential: null }]);
    expect(svc.getWorkflow("w").nodes[0].credential).toBeUndefined();
  });
});
