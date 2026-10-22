import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NaturoflowService, type WorkflowInput } from "../src/index.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-m4-"));
const examples = path.resolve(import.meta.dirname, "../../../examples/nodes");
let svc: NaturoflowService;

const js = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "js.transform",
  params: { code },
  ...extra,
});
const edge = (from: string, fp: string, to: string, tp: string) => ({ from: { node: from, port: fp }, to: { node: to, port: tp } });

beforeAll(() => {
  svc = new NaturoflowService({ home, allowedBins: [], concurrency: 4, nodeDirs: [examples] });
  // Counts executions by appending a line to params.file.
  svc.saveNodeType({
    id: "test.counter",
    name: "counter",
    cache: true,
    inputs: { in: { type: "any", required: false } },
    params: { type: "object", properties: { file: { type: "string" }, tag: { type: "string" } } },
    outputs: { n: { type: "number" } },
    executor: {
      kind: "script",
      language: "js",
      code: `import fs from "node:fs";
export default async ({ params }) => {
  fs.appendFileSync(params.file, "x\\n");
  return { n: fs.readFileSync(params.file, "utf8").trim().split("\\n").length };
};`,
    },
  });
  // Child workflow: y = x * 2
  svc.saveWorkflow({
    id: "double",
    name: "double",
    nodes: [
      { id: "x", type: "core.input", params: { key: "x", type: "number" } },
      js("mul", "return inputs.input * 2;"),
      { id: "y", type: "core.output", params: { key: "y" } },
    ],
    edges: [edge("x", "value", "mul", "input"), edge("mul", "result", "y", "value")],
  });
});

afterAll(() => {
  svc.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").length : 0);

describe("core.if", () => {
  const wf: WorkflowInput = {
    id: "branch",
    name: "branch",
    nodes: [
      { id: "n", type: "core.input", params: { key: "n", type: "number" } },
      { id: "check", type: "core.if", params: { condition: "value > 5" } },
      js("big", "return 'big ' + inputs.input;"),
      js("small", "return 'small ' + inputs.input;"),
      js("after_small", "return inputs.input + '!';"),
      { id: "merge", type: "object.merge" },
      { id: "out", type: "core.output", params: { key: "out" } },
    ],
    edges: [
      edge("n", "value", "check", "value"),
      edge("check", "true", "big", "input"),
      edge("check", "false", "small", "input"),
      edge("small", "result", "after_small", "input"),
      edge("big", "result", "merge", "a"),
      edge("after_small", "result", "merge", "b"),
      edge("merge", "value", "out", "value"),
    ],
  };

  it("runs only the taken branch and merges through optional inputs", async () => {
    const run = await svc.runWorkflow(wf, { n: 10 });
    expect(run.status).toBe("success");
    expect(run.nodes.check.inactive).toEqual(["false"]);
    expect(run.nodes.small).toMatchObject({ status: "skipped", note: "branch not taken" });
    expect(run.nodes.after_small.status).toBe("skipped");
    expect(run.outputs?.out).toEqual({ a: "big 10" });

    const other = await svc.runWorkflow(wf, { n: 1 });
    expect(other.status).toBe("success");
    expect(other.nodes.big.status).toBe("skipped");
    expect(other.outputs?.out).toEqual({ b: "small 1!" });
  });

  it("reports a bad condition as a node failure", async () => {
    const bad = structuredClone(wf);
    bad.nodes![1].params = { condition: "value >" };
    const run = await svc.runWorkflow(bad, { n: 1 });
    expect(run.status).toBe("failed");
    expect(run.nodes.check.error).toMatch(/condition/);
    expect(run.nodes.small.error).toBe("upstream did not succeed");
  });
});

describe("subflow and map", () => {
  it("core.subflow runs a stored workflow", async () => {
    const run = await svc.runWorkflow({
      id: "sub",
      name: "sub",
      nodes: [
        { id: "args", type: "core.const", params: { value: { x: 5 } } },
        { id: "call", type: "core.subflow", params: { workflow: "double" } },
        { id: "out", type: "core.output", params: { key: "r" } },
      ],
      edges: [edge("args", "value", "call", "inputs"), edge("call", "outputs", "out", "value")],
    });
    expect(run.status).toBe("success");
    expect(run.outputs?.r).toEqual({ y: 10 });
    const child = svc.listRuns("double")[0];
    expect(svc.getRun(child.id).parentRunId).toBe(run.id);
  });

  it("core.map runs a workflow per item", async () => {
    const run = await svc.runWorkflow({
      id: "mapper",
      name: "mapper",
      nodes: [
        { id: "items", type: "core.const", params: { value: [1, 2, 3, 4] } },
        { id: "each", type: "core.map", params: { workflow: "double", itemKey: "x", pick: "y", concurrency: 2 } },
        { id: "out", type: "core.output", params: { key: "ys" } },
      ],
      edges: [edge("items", "value", "each", "items"), edge("each", "results", "out", "value")],
    });
    expect(run.status).toBe("success");
    expect(run.outputs?.ys).toEqual([2, 4, 6, 8]);
  });

  it("a subflow executor gives a workflow typed ports", async () => {
    svc.saveNodeType({
      id: "math.double",
      name: "double",
      inputs: { x: { type: "number" } },
      outputs: { y: { type: "number" } },
      executor: { kind: "subflow", workflow: "double" },
    });
    const run = await svc.testNodeType("math.double", { x: 21 });
    expect(run.nodes.node.outputs).toEqual({ y: 42 });
  });

  it("stops recursive subflows", async () => {
    svc.saveWorkflow({
      id: "loop",
      name: "loop",
      nodes: [{ id: "again", type: "core.subflow", params: { workflow: "loop" } }],
    });
    const run = await svc.runWorkflow("loop");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/nested deeper/);
  }, 20_000);
});

describe("cache and rerun", () => {
  it("reuses outputs for identical inputs and params", async () => {
    const file = path.join(home, "cache-count.txt");
    const wf: WorkflowInput = {
      id: "cached",
      name: "cached",
      nodes: [{ id: "c", type: "test.counter", params: { file } }],
    };
    const first = await svc.runWorkflow(wf);
    const second = await svc.runWorkflow(wf);
    expect(first.nodes.c.cached).toBeUndefined();
    expect(second.nodes.c).toMatchObject({ status: "success", cached: "cache", outputs: { n: 1 } });
    expect(lines(file)).toBe(1);

    // Different params miss the cache; useCache:false bypasses it.
    await svc.runWorkflow({ ...wf, nodes: [{ id: "c", type: "test.counter", params: { file, tag: "v2" } }] });
    await svc.runWorkflow(wf, {}, { useCache: false });
    expect(lines(file)).toBe(3);

    // A node can opt out of its type's caching.
    await svc.runWorkflow({ ...wf, nodes: [{ id: "c", type: "test.counter", params: { file }, cache: false }] });
    expect(lines(file)).toBe(4);
  });

  it("reruns a node and its downstream, reusing everything upstream", async () => {
    const a = path.join(home, "a.txt");
    const b = path.join(home, "b.txt");
    svc.saveWorkflow({
      id: "chain",
      name: "chain",
      nodes: [
        { id: "a", type: "test.counter", params: { file: a }, cache: false },
        { id: "b", type: "test.counter", params: { file: b }, cache: false },
        { id: "out", type: "core.output", params: { key: "b" } },
      ],
      edges: [edge("a", "n", "b", "in"), edge("b", "n", "out", "value")],
    });
    const run = await svc.runWorkflow("chain");
    const rerun = await svc.rerunFromNode(run.id, "b");
    expect(rerun.status).toBe("success");
    expect(rerun.rerunOf).toEqual({ runId: run.id, fromNode: "b" });
    expect(rerun.nodes.a.cached).toBe("reuse");
    expect(rerun.nodes.b.cached).toBeUndefined();
    expect(rerun.outputs?.b).toBe(2);
    expect([lines(a), lines(b)]).toEqual([1, 2]);
  });
});

describe("single-node runs", () => {
  it("run one node with its last inputs, explicit inputs, or a history entry's params", async () => {
    const a = path.join(home, "sa.txt");
    const b = path.join(home, "sb.txt");
    svc.saveWorkflow({
      id: "single",
      name: "single",
      nodes: [
        { id: "a", type: "test.counter", params: { file: a }, cache: false },
        { id: "b", type: "test.counter", params: { file: b, tag: "v1" }, cache: false },
      ],
      edges: [edge("a", "n", "b", "in")],
    });
    const full = await svc.runWorkflow("single");
    expect(full.nodes.b.inputs).toEqual({ in: 1 });

    // Only b runs, with the inputs it got last time.
    const s1 = await svc.runSingleNode("single", "b");
    expect(s1.status).toBe("success");
    expect(Object.keys(s1.nodes)).toEqual(["b"]);
    expect(s1.single).toEqual({ nodeId: "b", fromRunId: full.id });
    expect(s1.nodes.b.inputs).toEqual({ in: 1 });
    expect([lines(a), lines(b)]).toEqual([1, 2]);

    // Explicit inputs, and the node's current params by default.
    svc.applyPatch("single", [{ op: "update_node", id: "b", params: { tag: "v2" } }]);
    const s2 = await svc.runSingleNode("single", "b", { inputs: { in: 99 } });
    expect(s2.nodes.b.inputs).toEqual({ in: 99 });
    expect(s2.nodes.b.params).toMatchObject({ tag: "v2" });

    // Replay a history entry exactly: its inputs and its params.
    const s3 = await svc.runSingleNode("single", "b", { fromRunId: full.id, params: "history" });
    expect(s3.nodes.b.params).toMatchObject({ tag: "v1" });
    expect(s3.nodes.b.inputs).toEqual({ in: 1 });

    const h = svc.nodeHistory("single", "b");
    expect(h.map((e) => !!e.single)).toEqual([true, true, true, false]);
    // A cacheable node still executes when run on its own (cache off by default).
    expect(lines(b)).toBe(4);
  });

  it("reads upstream File / Constant nodes directly when running one node", async () => {
    const f = path.join(home, "single-in.png");
    fs.writeFileSync(f, "abc");
    svc.saveWorkflow({
      id: "fixed",
      name: "fixed",
      nodes: [
        { id: "pic", type: "core.file", params: { path: f } },
        { id: "n", type: "core.const", params: { value: 41 } },
        js("size", "return inputs.input.size;"),
        js("plus", "return inputs.input + 1;"),
      ],
      edges: [edge("pic", "file", "size", "input"), edge("n", "value", "plus", "input")],
    });
    // Never ran before, yet both work on their own.
    expect((await svc.runSingleNode("fixed", "size")).nodes.size.outputs?.result).toBe(3);
    expect((await svc.runSingleNode("fixed", "plus")).nodes.plus.outputs?.result).toBe(42);
    // Swapping the constant is picked up on the next single run.
    svc.applyPatch("fixed", [{ op: "update_node", id: "n", params: { value: 9 } }]);
    expect((await svc.runSingleNode("fixed", "plus")).nodes.plus.outputs?.result).toBe(10);
  });

  it("refuses when a required input has never had a value", async () => {
    svc.saveWorkflow({ id: "fresh", name: "fresh", nodes: [{ id: "gif", type: "ffmpeg.to-gif" }] });
    await expect(svc.runSingleNode("fresh", "gif")).rejects.toThrow(/no value for input "video"/);
  });
});

describe("artifacts", () => {
  it("lists produced files once, attributed to the producing node, with stars and notes", async () => {
    svc.saveNodeType({
      id: "test.make-file",
      name: "make file",
      cache: true,
      params: { type: "object", properties: { text: { type: "string" } } },
      outputs: { file: { type: "file" } },
      executor: {
        kind: "script",
        language: "js",
        code: `import fs from "node:fs";
export default async ({ params, ctx }) => {
  const p = ctx.outDir + "/out.png";
  fs.writeFileSync(p, params.text);
  return { file: p };
};`,
      },
    });
    const make = (text: string) =>
      svc.saveWorkflow({
        id: "gallery",
        name: "gallery",
        nodes: [
          { id: "maker", type: "test.make-file", params: { text } },
          { id: "out", type: "core.output", params: { key: "img" } },
        ],
        edges: [edge("maker", "file", "out", "value")],
      });
    make("first");
    const r1 = await svc.runWorkflow("gallery");
    make("second");
    await svc.runWorkflow("gallery");
    await svc.runWorkflow("gallery"); // cache hit: same file, not a new artifact

    const { items } = svc.listArtifacts("gallery");
    expect(items).toHaveLength(2);
    expect(items.map((a) => a.nodeId)).toEqual(["maker", "maker"]);
    expect(items.map((a) => a.params?.text)).toEqual(["second", "first"]);
    expect(items[0]).toMatchObject({ port: "file", mime: "image/png", starred: false, note: "" });

    // Lineage: a downstream copy step still shows the producer's params.
    svc.saveWorkflow({
      id: "gallery2",
      name: "gallery2",
      nodes: [
        { id: "maker", type: "test.make-file", params: { text: "prompt-a" } },
        { id: "copy", type: "js.transform", params: { code: "return inputs.input;" } },
      ],
      edges: [edge("maker", "file", "copy", "input")],
    });
    await svc.runWorkflow("gallery2", {}, { useCache: false });
    const g2 = svc.listArtifacts("gallery2").items;
    expect(g2).toHaveLength(1); // the copy passes the same file through; attributed to maker
    expect(g2[0].nodeId).toBe("maker");
    const copyRun = await svc.runSingleNode("gallery2", "copy");
    expect(copyRun.status).toBe("success");

    // Like Seedream -> download: the downstream node makes a new file; its lineage shows the prompt.
    svc.saveNodeType({
      id: "test.copy-file",
      name: "copy file",
      inputs: { file: { type: "file" } },
      outputs: { file: { type: "file" } },
      executor: {
        kind: "script",
        language: "js",
        code: `import fs from "node:fs";
export default async ({ inputs, ctx }) => {
  const p = ctx.outDir + "/copy.png";
  fs.copyFileSync(inputs.file.path, p);
  return { file: p };
};`,
      },
    });
    svc.saveWorkflow({
      id: "gallery3",
      name: "gallery3",
      nodes: [
        { id: "gen", type: "test.make-file", params: { text: "prompt-b" } },
        { id: "dl", type: "test.copy-file" },
      ],
      edges: [edge("gen", "file", "dl", "file")],
    });
    await svc.runWorkflow("gallery3", {}, { useCache: false });
    await svc.runSingleNode("gallery3", "dl");
    const g3 = svc.listArtifacts("gallery3", { nodeId: "dl" }).items;
    expect(g3).toHaveLength(2);
    for (const a of g3) expect(a.lineage).toEqual([{ nodeId: "gen", nodeType: "test.make-file", params: { text: "prompt-b" } }]);
    expect(g3[0].single?.nodeId).toBe("dl");

    svc.markArtifact(items[1].path, { starred: true, note: "better colors" });
    const starred = svc.listArtifacts("gallery", { starred: true }).items;
    expect(starred).toHaveLength(1);
    expect(starred[0]).toMatchObject({ runId: r1.id, starred: true, note: "better colors" });
    expect(svc.listArtifacts("gallery", { nodeId: "out" }).items).toHaveLength(0);
    expect(() => svc.markArtifact("/etc/passwd", { starred: true })).toThrow(/not a run output/);

    // Deleted files drop out; paging returns the rest.
    fs.rmSync(items[0].path);
    expect(svc.listArtifacts("gallery").items.map((a) => a.params?.text)).toEqual(["first"]);
    const page = svc.listArtifacts("gallery", { limit: 1 });
    expect(page.items).toHaveLength(1);
  });
});

describe("assets", () => {
  it("core.file feeds an uploaded or generated file into a workflow", async () => {
    const up = svc.saveUpload("../我的 参考图.png", new Uint8Array([1, 2, 3]));
    expect(up.path.startsWith(path.join(home, "uploads"))).toBe(true);
    expect(path.basename(up.path)).toBe("我的 参考图.png");
    expect(svc.listUploads()[0]).toMatchObject({ path: up.path, name: "我的 参考图.png", mime: "image/png" });

    svc.saveWorkflow({
      id: "asset",
      name: "asset",
      nodes: [
        { id: "pic", type: "core.file", params: { path: up.path } },
        js("size", "return inputs.input.size;"),
      ],
      edges: [edge("pic", "file", "size", "input")],
    });
    const run = await svc.runWorkflow("asset");
    expect(run.status).toBe("success");
    expect(run.nodes.size.outputs?.result).toBe(3);

    const missing = await svc.runWorkflow({ id: "asset2", name: "asset2", nodes: [{ id: "pic", type: "core.file", params: { path: "/nope.png" } }] });
    expect(missing.nodes.pic.error).toMatch(/file not found/);

    // An input file fed in by a File node isn't a generated result — even after that node is deleted.
    expect(svc.listArtifacts("asset").items).toEqual([]);
    expect(run.nodes.pic.nodeType).toBe("core.file");
    svc.applyPatch("asset", [{ op: "remove_node", id: "pic" }]);
    expect(svc.listArtifacts("asset").items).toEqual([]);

    // Cross-workflow listing includes files from every workflow, newest first, no duplicates.
    const all = svc.listAllArtifacts();
    expect(all.some((a) => a.path === up.path)).toBe(false);
    expect(new Set(all.map((a) => a.path)).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });
});

describe("choosing a result", () => {
  it("a pinned node reuses the chosen result; downstream and single runs follow it", async () => {
    const a = path.join(home, "pin-a.txt");
    const b = path.join(home, "pin-b.txt");
    svc.saveWorkflow({
      id: "pin",
      name: "pin",
      nodes: [
        { id: "gen", type: "test.counter", params: { file: a }, cache: false },
        { id: "use", type: "test.counter", params: { file: b }, cache: false },
        js("show", "return inputs.input;"),
      ],
      edges: [edge("gen", "n", "use", "in"), edge("gen", "n", "show", "input")],
    });
    const r1 = await svc.runWorkflow("pin"); // gen -> 1
    await svc.runWorkflow("pin"); // gen -> 2
    expect(lines(a)).toBe(2);

    // Pick the first result: gen doesn't execute, downstream gets 1.
    svc.applyPatch("pin", [{ op: "update_node", id: "gen", pin: { runId: r1.id } }]);
    const r3 = await svc.runWorkflow("pin");
    expect(lines(a)).toBe(2);
    expect(r3.nodes.gen).toMatchObject({ status: "success", cached: "pin", outputs: { n: 1 } });
    expect(r3.nodes.show.outputs?.result).toBe(1);

    // Running a downstream node alone uses the upstream's current (pinned) result.
    expect((await svc.runSingleNode("pin", "show")).nodes.show.outputs?.result).toBe(1);

    // Previews: newest first, pinned copies not repeated.
    const prev = svc.nodePreviews("pin");
    expect(prev.gen.map((p) => p.outputs.n)).toEqual([2, 1]);

    // Running the pinned node again makes its new result the chosen one.
    const r4 = await svc.runSingleNode("pin", "gen"); // gen -> 3
    expect(svc.getWorkflow("pin").nodes.find((n) => n.id === "gen")?.pin).toEqual({ runId: r4.id });
    const r5 = await svc.runWorkflow("pin");
    expect(r5.nodes.gen).toMatchObject({ cached: "pin", outputs: { n: 3 } });
    expect(r5.nodes.show.outputs?.result).toBe(3);

    // Un-pin: gen runs again, and single runs downstream pick up its latest result.
    svc.applyPatch("pin", [{ op: "update_node", id: "gen", pin: null }]);
    await svc.runSingleNode("pin", "gen"); // gen -> 4
    expect((await svc.runSingleNode("pin", "show")).nodes.show.outputs?.result).toBe(4);

    expect(() => svc.applyPatch("pin", [{ op: "update_node", id: "gen", pin: { runId: "nope" } }])).toThrow(/no successful result/);
  });
});

describe("restarts", () => {
  it("marks runs left running by a stopped server as cancelled", () => {
    const stale = {
      id: "stale-run",
      workflowId: "single",
      status: "running" as const,
      inputs: {},
      startedAt: Date.now() - 1000,
      nodes: {
        a: { runId: "stale-run", nodeId: "a", status: "success" as const, logs: [], attempts: 1 },
        b: { runId: "stale-run", nodeId: "b", status: "running" as const, logs: [], attempts: 1 },
      },
    };
    svc.store.saveRun(stale);
    expect(svc.store.cancelInterruptedRuns("interrupted")).toBeGreaterThanOrEqual(1);
    const run = svc.getRun("stale-run");
    expect(run.status).toBe("cancelled");
    expect(run.nodes.a.status).toBe("success");
    expect(run.nodes.b).toMatchObject({ status: "cancelled", error: "interrupted" });
  });
});

describe("templated params", () => {
  it("lets params read workflow inputs and node inputs", async () => {
    const run = await svc.runWorkflow(
      {
        id: "tpl",
        name: "tpl",
        nodes: [
          { id: "c", type: "core.const", params: { value: 7 } },
          js("j", "return [params.extra, inputs.input, typeof params.extra];", { params: { code: "return [params.extra, inputs.input, typeof params.extra];", extra: "{{workflow.inputs.n}}" } }),
          { id: "out", type: "core.output", params: { key: "r" } },
        ],
        edges: [edge("c", "value", "j", "input"), edge("j", "result", "out", "value")],
      },
      { n: 3 },
    );
    expect(run.outputs?.r).toEqual([3, 7, "number"]);
  });
});

describe("publishing", () => {
  it("derives the interface and enforces unique tool names", () => {
    svc.applyPatch("double", [{ op: "set_tool", tool: { name: "double_it", description: "Doubles x" } }]);
    expect(svc.getWorkflowInterface("double")).toEqual({
      inputs: [{ key: "x", type: "number", required: true }],
      outputs: ["y"],
    });
    expect(svc.listPublished().map((w) => w.tool.name)).toEqual(["double_it"]);
    expect(() => svc.applyPatch("chain", [{ op: "set_tool", tool: { name: "double_it" } }])).toThrow(/used by/);
    svc.applyPatch("double", [{ op: "set_tool", tool: null }]);
    expect(svc.listPublished()).toEqual([]);
  });
});

describe("export / import", () => {
  it("round-trips a workflow, carrying custom node types and leaving local state behind", async () => {
    const counterFile = path.join(home, "export-count.txt");
    svc.saveWorkflow({
      id: "exp",
      name: "exported",
      nodes: [
        { id: "count", type: "test.counter", params: { file: counterFile } },
        js("show", "return inputs.input;"),
        { id: "pic", type: "core.file", params: { path: "/nope/missing.png" } },
        { id: "gen", type: "seedream.generate", params: { prompt: "hi" }, credential: "local-cred" },
      ],
      edges: [edge("count", "n", "show", "input")],
    });
    const r = await svc.runWorkflow("exp", {}, {});
    svc.applyPatch("exp", [{ op: "update_node", id: "count", pin: { runId: r.id } }]);

    const doc = JSON.parse(JSON.stringify(svc.exportWorkflow("exp")));
    expect(doc.format).toBe("naturoflow.workflow");
    expect(doc.workflow.id).toBeUndefined();
    expect(doc.workflow.nodes.find((n: { id: string }) => n.id === "count").pin).toBeUndefined();
    expect(doc.workflow.nodes.find((n: { id: string }) => n.id === "gen").credential).toBeUndefined();
    expect(doc.nodeTypes.map((t: { id: string }) => t.id)).toEqual(["test.counter"]);

    // Into a fresh install: the custom type comes along.
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "naturoflow-import-"));
    const other = new NaturoflowService({ home: home2, allowedBins: [], concurrency: 2, nodeDirs: [examples] });
    try {
      const { workflow, warnings } = other.importWorkflow(doc);
      expect(workflow.id).not.toBe("exp");
      expect(workflow.edges).toEqual(doc.workflow.edges);
      expect(other.getNodeType("test.counter").id).toBe("test.counter");
      const codes = warnings.map((w) => `${w.code}:${w.nodeId ?? w.args.type}`);
      expect(codes).toEqual(expect.arrayContaining(["NODE_TYPE_ADDED:test.counter", "MISSING_FILE:pic", "CHOOSE_CREDENTIAL:gen"]));
      expect((await other.runSingleNode(workflow.id, "count")).nodes.count.status).toBe("success");
    } finally {
      other.close();
      fs.rmSync(home2, { recursive: true, force: true });
    }

    // Into the same install, under another name; garbage is rejected.
    expect(svc.importWorkflow(doc, { name: "copy" }).workflow.name).toBe("copy");
    expect(() => svc.importWorkflow({ hello: 1 })).toThrow(/not a naturoflow workflow/);
  });
});
