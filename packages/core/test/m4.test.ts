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

  it("refuses when a required input has never had a value", async () => {
    svc.saveWorkflow({ id: "fresh", name: "fresh", nodes: [{ id: "gif", type: "ffmpeg.to-gif" }] });
    await expect(svc.runSingleNode("fresh", "gif")).rejects.toThrow(/no value for input "video"/);
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
