#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import { parseArgs } from "node:util";
import { NaturoflowService, type EngineEvent } from "@naturoflow/core";
import { DEFAULT_PORT, runStdio, startServer } from "@naturoflow/server";

const HELP = `naturoflow — customizable node workflows

Usage:
  naturoflow serve [--port 7788]             start HTTP API + MCP (Streamable HTTP at /mcp)
  naturoflow mcp                             MCP over stdio (proxies to a running server, else embeds one)
  naturoflow run <workflow.json | workflow-id> [-i key=value ...] [--json]
  naturoflow validate <workflow.json | workflow-id>
  naturoflow import <workflow.json>          save a workflow file into the local store
  naturoflow workflows                       list stored workflows
  naturoflow nodes                           list node types
  naturoflow node <type-id>                  show a node type definition
  naturoflow test-node <type-id> [-i port=value ...] [-p param=value ...]

Env: NATUROFLOW_HOME (default ~/.naturoflow)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: "string", short: "i", multiple: true },
    param: { type: "string", short: "p", multiple: true },
    json: { type: "boolean" },
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

function kv(list: string[] = []): Record<string, unknown> {
  return Object.fromEntries(
    list.map((s) => {
      const i = s.indexOf("=");
      const raw = s.slice(i + 1);
      let v: unknown = raw;
      try {
        v = JSON.parse(raw);
      } catch {}
      return [s.slice(0, i), v];
    }),
  );
}

function loadWorkflowArg(svc: NaturoflowService, arg: string) {
  return fs.existsSync(arg) ? JSON.parse(fs.readFileSync(arg, "utf8")) : svc.getWorkflow(arg);
}

function attachLogger(svc: NaturoflowService) {
  svc.on("event", (e: EngineEvent) => {
    if (e.type === "node.started") console.error(`▶ ${e.nodeId}`);
    if (e.type === "node.log") console.error(`  [${e.nodeId}] ${e.line}`);
    if (e.type === "node.finished") {
      const n = e.node;
      const ms = n.finishedAt && n.startedAt ? ` ${n.finishedAt - n.startedAt}ms` : "";
      const mark = { success: "✔", failed: "✘", skipped: "↷", cancelled: "■" }[n.status as string] ?? "?";
      console.error(`${mark} ${n.nodeId} ${n.status}${ms}${n.error ? ` — ${n.error}` : ""}`);
    }
  });
}

async function main() {
  const [cmd, arg] = positionals;
  if (values.help || !cmd) return console.log(HELP);
  if (cmd === "mcp") return runStdio();
  if (cmd === "serve") {
    const s = await startServer({ port: values.port ? Number(values.port) : DEFAULT_PORT });
    console.log(`naturoflow listening on ${s.url}`);
    console.log(`  Canvas: ${s.url}/auth?token=${s.token}`);
    console.log(`  MCP (Streamable HTTP): ${s.url}/mcp   Authorization: Bearer ${s.token}`);
    console.log(`  claude mcp add --transport http naturoflow ${s.url}/mcp --header "Authorization: Bearer ${s.token}"`);
    const stop = async () => {
      await s.close();
      s.svc.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  const svc = new NaturoflowService();
  try {
    switch (cmd) {
      case "run": {
        if (!values.json) attachLogger(svc);
        const run = await svc.runWorkflow(loadWorkflowArg(svc, arg), kv(values.input));
        if (values.json) console.log(JSON.stringify(run, null, 2));
        else {
          console.error(`\nrun ${run.id}: ${run.status}`);
          console.log(JSON.stringify(run.outputs, null, 2));
        }
        process.exitCode = run.status === "success" ? 0 : 1;
        break;
      }
      case "validate": {
        const issues = svc.validateWorkflow(loadWorkflowArg(svc, arg));
        console.log(issues.length ? JSON.stringify(issues, null, 2) : "ok");
        process.exitCode = issues.length ? 1 : 0;
        break;
      }
      case "import": {
        const wf = svc.saveWorkflow(JSON.parse(fs.readFileSync(arg, "utf8")));
        console.log(`saved ${wf.id} (v${wf.version})`);
        break;
      }
      case "workflows":
        for (const w of svc.listWorkflows()) console.log(`${w.id.padEnd(24)} v${w.version}  ${w.name}`);
        break;
      case "nodes": {
        for (const t of svc.listNodeTypes()) console.log(`${t.id.padEnd(24)} ${t.executor.padEnd(8)} ${t.name}`);
        for (const e of svc.registry.loadErrors) console.error(`! failed to load ${e.file}: ${e.message}`);
        break;
      }
      case "node":
        console.log(JSON.stringify(svc.getNodeType(arg), null, 2));
        break;
      case "test-node": {
        if (!values.json) attachLogger(svc);
        const run = await svc.testNodeType(arg, kv(values.input), kv(values.param));
        console.log(JSON.stringify(run.nodes.node.outputs ?? run.nodes.node.error, null, 2));
        process.exitCode = run.status === "success" ? 0 : 1;
        break;
      }
      default:
        console.error(`unknown command "${cmd}"\n\n${HELP}`);
        process.exitCode = 2;
    }
  } catch (e) {
    const err = e as Error & { code?: string; issues?: unknown };
    console.error(`error${err.code ? ` [${err.code}]` : ""}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    svc.close();
  }
}

main();
