// Runs a user JS node script inside a worker thread.
// The module must `export default async ({ inputs, params, ctx }) => outputs`.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const { code, file, inputs, params, ctx } = workerData;
const log = (...a) => parentPort.postMessage({ type: "log", line: a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
console.log = log;
console.error = log;

try {
  const url = file ? pathToFileURL(file).href : "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  const mod = await import(url);
  const fn = mod.default;
  if (typeof fn !== "function") throw new Error("script must `export default` a function");
  const result = await fn({ inputs, params, ctx: { ...ctx, log } });
  parentPort.postMessage({ type: "result", value: result ?? {} });
} catch (e) {
  parentPort.postMessage({ type: "error", message: e?.stack ?? String(e) });
}
