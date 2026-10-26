import { z } from "zod";

/** Port value types. `list<T>` is written as e.g. "list<file>". */
export const PortType = z
  .string()
  .regex(/^(any|string|number|boolean|json|file|list<(any|string|number|boolean|json|file)>)$/, "invalid port type");
export type PortType = z.infer<typeof PortType>;

export const PortDef = z.object({
  type: PortType.default("any"),
  required: z.boolean().default(true),
  description: z.string().optional(),
});
export type PortDef = z.infer<typeof PortDef>;

/** Duration: number of ms, or a string like "30s", "500ms", "10m". */
export const Duration = z.union([z.number(), z.string().regex(/^\d+(ms|s|m|h)$/)]);

export function parseDuration(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === "number") return d;
  const m = /^(\d+)(ms|s|m|h)$/.exec(d)!;
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
}

/**
 * Every executor's `outputs` maps an output port to a template evaluated against the
 * executor result (http: {status, headers, body}; command: {stdout, stderr, exitCode}).
 */
const OutputMap = z.record(z.string(), z.any()).optional();
/** A map, or a single `{{...}}` template that evaluates to one. */
const TemplatedMap = z.union([z.record(z.string(), z.any()), z.string()]).optional();

/**
 * Async APIs: after the first request (the submit), query a status URL until the task
 * finishes. Templates here and in `outputs` see the submit response as `submit`
 * ({status, headers, body}) and the latest poll response as `body` / `status` / `headers`.
 */
export const HttpPoll = z.object({
  url: z.string(),
  method: z.string().default("GET"),
  /** Defaults to the submit request's headers (so auth carries over). */
  headers: TemplatedMap,
  query: TemplatedMap,
  body: z.any().optional(),
  interval: Duration.default("3s"),
  /** Template for the task status, e.g. "{{body.status}}". */
  status: z.string(),
  /** Status values that mean finished (case-insensitive). */
  done: z.array(z.string()).min(1),
  /** Status values that mean the task failed. */
  failed: z.array(z.string()).default([]),
  /** Template for the failure message, e.g. "{{body.error.message}}". */
  error: z.string().optional(),
  /** Stop waiting after this long; defaults to the node's timeout. */
  maxWait: Duration.optional(),
});

export const HttpExecutor = z.object({
  kind: z.literal("http"),
  method: z.string().default("GET"),
  url: z.string(),
  headers: TemplatedMap,
  query: TemplatedMap,
  body: z.any().optional(),
  bodyType: z.enum(["json", "form", "text"]).default("json"),
  responseType: z.enum(["json", "text", "file"]).default("json"),
  /** Treat non-2xx as failure (default true). */
  failOnError: z.boolean().default(true),
  /** Keep polling a status URL after the first request (async task APIs). */
  poll: HttpPoll.optional(),
  outputs: OutputMap,
});

export const CommandExecutor = z.object({
  kind: z.literal("command"),
  bin: z.string(),
  args: z.array(z.any()).default([]),
  env: TemplatedMap,
  outputs: OutputMap,
});

export const ScriptExecutor = z
  .object({
    kind: z.literal("script"),
    language: z.enum(["js", "python"]).default("js"),
    code: z.string().optional(),
    /** Path to the script, relative to the node type file. */
    file: z.string().optional(),
  })
  .refine((s) => !!s.code !== !!s.file, "script executor needs exactly one of `code` or `file`");

/** Runs another workflow; input ports map to its core.input keys, outputs to its core.output keys. */
export const SubflowExecutor = z.object({
  kind: z.literal("subflow"),
  workflow: z.string(),
  outputs: OutputMap,
});

export const BuiltinExecutor = z.object({
  kind: z.literal("builtin"),
  name: z.string(),
});

export const Executor = z.union([HttpExecutor, CommandExecutor, ScriptExecutor, SubflowExecutor, BuiltinExecutor]);
export type Executor = z.infer<typeof Executor>;

/**
 * Credentials a node type needs (API keys etc.). Users save any number of credentials of a
 * type in the UI and pick one per node; values are available to templates as {{credential.<field>}}.
 */
export const CredentialSpec = z.object({
  /** Credential type id. Node types that share it share saved credentials. Defaults to the node type id. */
  type: z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  /** Display name of the credential type, e.g. "BytePlus ModelArk". */
  name: z.string().optional(),
  required: z.boolean().default(true),
  fields: z.record(
    z.string().regex(/^[a-zA-Z0-9_]+$/),
    z.object({
      label: z.string().optional(),
      description: z.string().optional(),
      /** Secret fields are encrypted at rest, never returned by the API, and masked in logs. */
      secret: z.boolean().default(true),
      required: z.boolean().default(true),
    }),
  ),
});
export type CredentialSpec = z.infer<typeof CredentialSpec>;

/** A model file a node type needs (downloaded on request, see ModelManager). */
export const ModelSpec = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]+$/, "model id may only contain letters, digits, _ . -"),
  name: z.string().optional(),
  url: z.string().url(),
  /** Approximate size in MB, shown before downloading. */
  size: z.number().optional(),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

export const NodeTypeDef = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]+$/, "id may only contain letters, digits, _ . -"),
  name: z.string(),
  category: z.string().default("general"),
  description: z.string().optional(),
  inputs: z.record(z.string(), PortDef).default({}),
  /** JSON Schema (object) describing configurable params. */
  params: z.record(z.string(), z.any()).default({ type: "object", properties: {} }),
  outputs: z.record(z.string(), PortDef).default({}),
  executor: Executor,
  timeout: Duration.optional(),
  retry: z.object({ max: z.number().int().min(0).default(0), backoff: Duration.default(1000) }).optional(),
  /**
   * Reuse outputs when the same type definition, params and inputs were seen before.
   * Off by default: only turn it on for deterministic nodes (ffmpeg yes, HTTP POST no).
   */
  cache: z.boolean().default(false),
  credentials: CredentialSpec.optional(),
  /**
   * Model files the node needs. With several, the `model` param picks one by id. Scripts find
   * them in ctx.modelsDir; runs fail with MISSING_MODEL until the model is downloaded.
   */
  models: z.array(ModelSpec).optional(),
  /**
   * UI texts in other languages, keyed by language code:
   * `i18n: { en: { name, description, params: {key: help}, inputs: {port: help}, outputs, credentials: { name, fields: {key: {label, description}} } } }`.
   */
  i18n: z
    .record(
      z.string(),
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        params: z.record(z.string(), z.string()).optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        outputs: z.record(z.string(), z.string()).optional(),
        credentials: z
          .object({
            name: z.string().optional(),
            fields: z.record(z.string(), z.object({ label: z.string().optional(), description: z.string().optional() })).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});
export type NodeTypeDef = z.infer<typeof NodeTypeDef>;
export type NodeTypeInput = z.input<typeof NodeTypeDef>;

export const PortRef = z.object({ node: z.string(), port: z.string() });

export const WorkflowNode = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  type: z.string(),
  params: z.record(z.string(), z.any()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  label: z.string().optional(),
  /** Override the node type's `cache` setting for this node. */
  cache: z.boolean().optional(),
  /** Id of the saved credential this node uses (for node types that declare `credentials`). */
  credential: z.string().optional(),
  /** Use the outputs this node produced in that earlier run instead of executing it. */
  pin: z.object({ runId: z.string() }).optional(),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowEdge = z.object({ from: PortRef, to: PortRef });
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

export const ToolPublish = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "tool name may only contain letters, digits, _ and - (max 64)"),
  description: z.string().optional(),
});
export type ToolPublish = z.infer<typeof ToolPublish>;

export const Workflow = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  nodes: z.array(WorkflowNode).default([]),
  edges: z.array(WorkflowEdge).default([]),
  version: z.number().int().default(1),
  /** When set, the workflow is exposed as an MCP tool with this name. */
  tool: ToolPublish.optional(),
});
export type Workflow = z.infer<typeof Workflow>;
export type WorkflowInput = z.input<typeof Workflow>;

export const EXPORT_FORMAT = "naturoflow.workflow";

/** A workflow as a file: what export writes and import reads. */
export const WorkflowExport = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.number().int(),
  exportedAt: z.string().optional(),
  workflow: Workflow.omit({ id: true, version: true }).extend({ id: z.string().optional(), version: z.number().optional() }),
  /** Definitions of the custom node types the workflow uses. */
  nodeTypes: z.array(NodeTypeDef).optional(),
});
export type WorkflowExport = z.input<typeof WorkflowExport>;

export interface ImportWarning {
  code: "NODE_TYPE_ADDED" | "MISSING_NODE_TYPE" | "CHOOSE_CREDENTIAL" | "MISSING_FILE" | "TOOL_NAME_TAKEN";
  nodeId?: string;
  args: Record<string, string>;
}

/** How files travel between nodes. */
export interface FileRef {
  $file: true;
  path: string;
  size: number;
  mime: string;
}

export type RunStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";

export interface NodeRunRecord {
  runId: string;
  nodeId: string;
  /** The node's type at run time (kept so history still makes sense if the node is deleted). */
  nodeType?: string;
  status: RunStatus;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  logs: string[];
  error?: string;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  /** Output ports that did not fire (e.g. the untaken side of core.if). */
  inactive?: string[];
  /** Where the outputs came from when the node did not execute ("pin": a result the user chose). */
  cached?: "cache" | "reuse" | "pin";
  /** Human-readable explanation, e.g. why a node was skipped. */
  note?: string;
  /** Params as actually used (templates rendered, secrets masked). */
  params?: Record<string, unknown>;
  /** What the executor sent and got back, e.g. the HTTP request/response (secrets masked). */
  trace?: NodeTrace;
}

export interface NodeTrace {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  /** Async HTTP: the latest status query and how long it has been waiting. */
  poll?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  nodes: Record<string, NodeRunRecord>;
  /** Set when this run was started by a subflow/map node. */
  parentRunId?: string;
  /** Set when this run re-ran part of an earlier run. */
  rerunOf?: { runId: string; fromNode: string };
  /** Set when only one node was run on its own. */
  single?: { nodeId: string; fromRunId?: string };
}

export class NfError extends Error {
  constructor(
    public code: string,
    message: string,
    public path?: string,
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, path: this.path };
  }
}

/** Credential type id for a node type (its declared type, else the node type id). */
export function credentialTypeOf(def: NodeTypeDef): string | undefined {
  return def.credentials ? (def.credentials.type ?? def.id) : undefined;
}
