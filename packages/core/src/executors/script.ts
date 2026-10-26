import { spawn } from "node:child_process";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { z } from "zod";
import type { ScriptExecutor } from "../types.ts";
import type { ExecArgs } from "./types.ts";

type Spec = z.infer<typeof ScriptExecutor>;

const WORKER = new URL("./script-worker.mjs", import.meta.url);

export async function runScript(spec: Spec, args: ExecArgs): Promise<Record<string, unknown>> {
  const file = spec.file ? path.resolve(args.ctx.defDir ?? process.cwd(), spec.file) : undefined;
  const ctx = { runId: args.ctx.runId, nodeId: args.ctx.nodeId, outDir: args.ctx.outDir, modelsDir: args.ctx.modelsDir, credential: args.ctx.credential ?? {} };
  return spec.language === "python"
    ? runPython(spec.code, file, args, ctx)
    : runJs(spec.code, file, args, ctx);
}

function runJs(code: string | undefined, file: string | undefined, args: ExecArgs, ctx: object) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: { code, file, inputs: args.inputs, params: args.params, ctx },
    });
    const onAbort = () => {
      worker.terminate();
      reject(new Error("aborted"));
    };
    args.ctx.signal.addEventListener("abort", onAbort, { once: true });
    const done = () => args.ctx.signal.removeEventListener("abort", onAbort);
    worker.on("message", (m) => {
      if (m.type === "log") args.ctx.log(m.line);
      else if (m.type === "trace") args.ctx.trace(m.value);
      else if (m.type === "result") {
        done();
        resolve(m.value);
        worker.terminate();
      } else if (m.type === "error") {
        done();
        if (m.stack) args.ctx.log(m.stack);
        reject(new Error(m.message));
        worker.terminate();
      }
    });
    worker.on("error", (e) => {
      done();
      reject(e);
    });
  });
}

const PY_RESULT = "__NATUROFLOW_RESULT__";
const PY_WRAPPER = `
import json, sys, runpy, types
payload = json.loads(sys.stdin.read())
def log(*a): print(*a, file=sys.stderr, flush=True)
ctx = dict(payload["ctx"]); ctx["log"] = log
if payload.get("file"):
    ns = runpy.run_path(payload["file"])
else:
    ns = {}
    exec(compile(payload["code"], "<node-script>", "exec"), ns)
if "main" not in ns:
    raise SystemExit("python script must define main(inputs, params, ctx)")
out = ns["main"](payload["inputs"], payload["params"], types.SimpleNamespace(**ctx))
print("${PY_RESULT}" + json.dumps(out if out is not None else {}, default=str))
`;

function runPython(code: string | undefined, file: string | undefined, args: ExecArgs, ctx: object) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.env.NATUROFLOW_PYTHON ?? "python3", ["-c", PY_WRAPPER], {
      cwd: args.ctx.outDir,
      signal: args.ctx.signal,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => {
      err += c;
      for (const line of String(c).split(/\r?\n/)) if (line.trim()) args.ctx.log(line);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const line = out.split("\n").find((l) => l.startsWith(PY_RESULT));
      if (exitCode !== 0 || !line) return reject(new Error(`python exited with ${exitCode}: ${err.slice(-800)}`));
      for (const l of out.split("\n")) if (l.trim() && !l.startsWith(PY_RESULT)) args.ctx.log(l);
      resolve(JSON.parse(line.slice(PY_RESULT.length)));
    });
    child.stdin.end(JSON.stringify({ code, file, inputs: args.inputs, params: args.params, ctx }));
  });
}
