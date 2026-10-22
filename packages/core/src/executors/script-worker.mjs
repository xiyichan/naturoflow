// Runs a user JS node script inside a worker thread.
// The module must `export default async ({ inputs, params, ctx }) => outputs`.
// ctx: { runId, nodeId, outDir, credential, log(...), trace({ request, response }) }
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const { code, file, inputs, params, ctx } = workerData;
const log = (...a) => parentPort.postMessage({ type: "log", line: a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
console.log = log;
console.error = log;
// Record what the script sent/received; stored with the node run for its history.
const trace = (t) => parentPort.postMessage({ type: "trace", value: JSON.parse(JSON.stringify(t ?? {})) });

try {
  const url = file ? pathToFileURL(file).href : "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  const mod = await import(url);
  const fn = mod.default;
  if (typeof fn !== "function") throw new Error("script must `export default` a function");
  const result = await fn({ inputs, params, ctx: { ...ctx, log, trace } });
  parentPort.postMessage({ type: "result", value: result ?? {} });
} catch (e) {
  // The message is what users see; the stack goes to the node log for debugging.
  parentPort.postMessage({ type: "error", message: e?.message ?? String(e), stack: e?.stack });
}
