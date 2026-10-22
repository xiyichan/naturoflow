import type { NodeTypeDef, RunRecord } from "../types.ts";

/** Return this as an output value to mark the port as not firing (used by core.if). */
export const INACTIVE = Symbol.for("naturoflow.inactive");

export interface ExecContext {
  runId: string;
  nodeId: string;
  /** Per-node working directory for output files. */
  outDir: string;
  signal: AbortSignal;
  log: (line: string) => void;
  def: NodeTypeDef;
  /** Directory containing the node type file (for script `file:` resolution). */
  defDir?: string;
  config: { allowedBins: string[] };
  /** Values the builtin input/output nodes need. */
  runInputs: Record<string, unknown>;
  /** Run another stored workflow as a child of this run (used by subflow/map). */
  runSubflow: (workflowId: string, inputs: Record<string, unknown>) => Promise<RunRecord>;
}

export interface ExecArgs {
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
  ctx: ExecContext;
}

export type ExecutorFn = (args: ExecArgs) => Promise<Record<string, unknown>>;

/** The scope templates are rendered against. */
export function templateScope({ inputs, params, ctx }: ExecArgs, extra: Record<string, unknown> = {}) {
  return {
    inputs,
    params,
    env: process.env,
    ctx: { runId: ctx.runId, nodeId: ctx.nodeId, outDir: ctx.outDir },
    ...extra,
  };
}
