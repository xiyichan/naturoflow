import { spawn } from "node:child_process";
import path from "node:path";
import type { z } from "zod";
import { preview } from "../logfmt.ts";
import { render } from "../template.ts";
import type { CommandExecutor } from "../types.ts";
import { mapOutputs } from "./http.ts";
import { templateScope, type ExecArgs } from "./types.ts";

type Spec = z.infer<typeof CommandExecutor>;

const MAX_CAPTURE = 1024 * 1024;

/** Runs a binary with an argv array — never through a shell, so templated values can't inject. */
export async function runCommand(spec: Spec, args: ExecArgs): Promise<Record<string, unknown>> {
  const scope = templateScope(args);
  const bin = String(render(spec.bin, scope));
  if (!args.ctx.config.allowedBins.includes(path.basename(bin))) {
    throw new Error(`binary "${bin}" is not in allowedBins (${args.ctx.config.allowedBins.join(", ")})`);
  }
  // Array-valued args (e.g. a list of extra flags) are spread in place; empty strings dropped.
  const argv = (spec.args.map((a) => render(a, scope)) as unknown[])
    .flat()
    .filter((a) => a !== undefined && a !== null && a !== "")
    .map((a) => (typeof a === "object" && (a as { path?: string }).path ? (a as { path: string }).path : String(a)));
  const env = { ...process.env, ...(render(spec.env ?? {}, scope) as Record<string, string>) };

  args.ctx.log(`$ ${bin} ${argv.map(quote).join(" ")}`);
  args.ctx.trace({ request: { command: `${bin} ${argv.map(quote).join(" ")}`, bin, args: argv } });
  const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn(bin, argv, { cwd: args.ctx.outDir, env, signal: args.ctx.signal });
      let out = "";
      let err = "";
      const pipe = (chunk: Buffer, which: "out" | "err") => {
        const s = chunk.toString();
        if (which === "out") out = (out + s).slice(-MAX_CAPTURE);
        else {
          err = (err + s).slice(-MAX_CAPTURE);
          // stdout is usually data (consumed via `outputs`), so only stderr is streamed to logs.
          for (const line of s.split(/\r?\n|\r/)) if (line.trim()) args.ctx.log(line);
        }
      };
      child.stdout.on("data", (c) => pipe(c, "out"));
      child.stderr.on("data", (c) => pipe(c, "err"));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout: out, stderr: err, exitCode: code ?? -1 }));
    },
  );
  if (stdout.trim()) args.ctx.log(`stdout: ${preview(stdout.trim())}`);
  args.ctx.trace({ response: { exitCode, stdout, stderr } });
  if (exitCode !== 0) throw new Error(`${bin} exited with code ${exitCode}: ${stderr.slice(-800)}`);

  const result = { stdout, stderr, exitCode };
  return mapOutputs(spec.outputs, { ...scope, ...result, result }, { stdout: stdout.trim() });
}

function quote(s: string) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
