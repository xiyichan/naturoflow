import vm from "node:vm";
import { toFileRef } from "../files.ts";
import { render } from "../template.ts";
import type { Executor, RunRecord } from "../types.ts";
import { runCommand } from "./command.ts";
import { mapOutputs, runHttp } from "./http.ts";
import { runScript } from "./script.ts";
import { INACTIVE, type ExecArgs } from "./types.ts";

export type { ExecArgs, ExecContext } from "./types.ts";
export { INACTIVE } from "./types.ts";

/** Coerce a workflow input to the type declared on its core.input node. */
function coerceInput(v: unknown, type: unknown): unknown {
  switch (type) {
    case "file":
      return toFileRef(v);
    case "number":
      return typeof v === "number" ? v : Number(v);
    case "boolean":
      return v === true || v === "true";
    case "string":
      return typeof v === "string" ? v : JSON.stringify(v);
    default:
      return v;
  }
}

async function subflowOutputs(ctx: ExecArgs["ctx"], workflowId: string, inputs: Record<string, unknown>) {
  if (!workflowId) throw new Error("params.workflow is required");
  const child: RunRecord = await ctx.runSubflow(workflowId, inputs);
  ctx.log(`subflow ${workflowId} run ${child.id}: ${child.status}`);
  if (child.status !== "success") throw new Error(`subflow ${workflowId} ${child.status}: ${child.error ?? ""}`.trim());
  return child.outputs ?? {};
}

/** Engine-level nodes that need run context rather than templates. */
const BUILTINS: Record<string, (args: ExecArgs) => Promise<Record<string, unknown>>> = {
  /** Reads a workflow input by `params.key` (falls back to `params.default`). */
  input: async ({ params, ctx }) => {
    const key = String(params.key ?? ctx.nodeId);
    const v = key in ctx.runInputs ? ctx.runInputs[key] : params.default;
    if (v === undefined) {
      if (params.required === false) return { value: null };
      throw new Error(`missing workflow input "${key}"`);
    }
    return { value: coerceInput(v, params.type) };
  },
  /** Collects its `value` input as a workflow output named `params.key`. */
  output: async ({ inputs }) => ({ value: inputs.value }),
  /** Pass a constant value. */
  const: async ({ params }) => ({ value: params.value }),
  /** A local file as a FileRef (the engine checks it exists). */
  file: async ({ params }) => {
    const p = String(params.path ?? "").trim();
    if (!p) throw new Error("params.path is required");
    return { file: p.startsWith("~/") ? `${process.env.HOME}/${p.slice(2)}` : p };
  },

  /**
   * Route `value` to the `true` or `false` output. `params.condition` is a JS expression
   * over `value`, `inputs` and `params` (default: truthiness of value).
   */
  if: async ({ inputs, params, ctx }) => {
    const expr = String(params.condition ?? "").trim() || "value";
    const sandbox = { value: structuredClone(inputs.value), inputs: structuredClone(inputs), params: structuredClone(params) };
    let result: unknown;
    try {
      result = vm.runInNewContext(`(${expr})`, sandbox, { timeout: 1000 });
    } catch (e) {
      throw new Error(`condition "${expr}" failed: ${(e as Error).message}`);
    }
    ctx.log(`condition ${expr} -> ${Boolean(result)}`);
    return result ? { true: inputs.value, false: INACTIVE } : { true: INACTIVE, false: inputs.value };
  },

  /** Run another workflow; `inputs` (an object) are its run inputs, `outputs` its run outputs. */
  subflow: async ({ inputs, params, ctx }) => ({
    outputs: await subflowOutputs(ctx, String(params.workflow ?? ""), (inputs.inputs as Record<string, unknown>) ?? {}),
  }),

  /**
   * Run a workflow once per item of `items`. Each run gets inputs { [itemKey]: item, index, ...context }.
   * `results` is the list of run outputs (or one output key of each, via params.pick).
   */
  map: async ({ inputs, params, ctx }) => {
    const items = inputs.items;
    if (!Array.isArray(items)) throw new Error(`items must be a list, got ${typeof items}`);
    const workflowId = String(params.workflow ?? "");
    const itemKey = String(params.itemKey ?? "item");
    const pick = params.pick ? String(params.pick) : undefined;
    const concurrency = Math.max(1, Number(params.concurrency ?? 4));
    const context = (inputs.context as Record<string, unknown>) ?? {};
    const results: unknown[] = new Array(items.length);
    const errors: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length && !ctx.signal.aborted) {
        const i = next++;
        try {
          const out = await subflowOutputs(ctx, workflowId, { ...context, [itemKey]: items[i], index: i });
          results[i] = pick ? out[pick] : out;
        } catch (e) {
          if (!params.continueOnError) throw e;
          errors.push(`item ${i}: ${(e as Error).message}`);
          results[i] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    for (const e of errors) ctx.log(e);
    return { results, errors };
  },
};

export async function execute(executor: Executor, args: ExecArgs): Promise<Record<string, unknown>> {
  switch (executor.kind) {
    case "http":
      return runHttp(executor, args);
    case "command":
      return runCommand(executor, args);
    case "script":
      return runScript(executor, args);
    case "subflow": {
      const id = String(render(executor.workflow, { params: args.params, inputs: args.inputs }));
      const outputs = await subflowOutputs(args.ctx, id, args.inputs);
      return mapOutputs(executor.outputs, { outputs, inputs: args.inputs, params: args.params }, outputs);
    }
    case "builtin": {
      const fn = BUILTINS[executor.name];
      if (!fn) throw new Error(`unknown builtin "${executor.name}"`);
      return fn(args);
    }
  }
}
