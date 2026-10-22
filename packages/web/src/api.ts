// Thin client for the naturoflow REST API. Auth is a cookie set by /auth?token=...

export interface PortDef {
  type: string;
  required: boolean;
  description?: string;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  title?: string;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  /** "workflow-id" renders a workflow picker. */
  format?: string;
}

export interface NodeTypeSummary {
  id: string;
  name: string;
  category: string;
  description?: string;
  executor: string;
  inputs: Record<string, PortDef>;
  outputs: Record<string, PortDef>;
  source?: string;
  readonly: boolean;
}

export interface CredentialField {
  label?: string;
  description?: string;
  secret: boolean;
  required: boolean;
}

export interface CredentialSpec {
  type?: string;
  name?: string;
  required: boolean;
  fields: Record<string, CredentialField>;
}

export interface CredentialInfo {
  id: string;
  type: string;
  name: string;
  fields: string[];
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface NodeTypeDef extends Omit<NodeTypeSummary, "executor"> {
  params: JsonSchema;
  credentials?: CredentialSpec;
  executor: { kind: string; [k: string]: unknown };
  timeout?: string | number;
  retry?: { max: number; backoff: string | number };
}

export interface WorkflowNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
  label?: string;
  credential?: string;
}

export interface Edge {
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: Edge[];
  version: number;
  tool?: { name: string; description?: string };
}

export interface WorkflowInterface {
  inputs: { key: string; type: string; description?: string; required: boolean; default?: unknown }[];
  outputs: string[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
}

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
}

export type RunStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";

export interface NodeRun {
  runId: string;
  nodeId: string;
  status: RunStatus;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  logs: string[];
  error?: string;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  inactive?: string[];
  cached?: "cache" | "reuse";
  note?: string;
  params?: Record<string, unknown>;
  trace?: { request?: Record<string, unknown>; response?: Record<string, unknown> };
}

export interface NodeHistoryEntry {
  runId: string;
  runStartedAt: number;
  runStatus: RunStatus;
  rerunOf?: { runId: string; fromNode: string };
  node: NodeRun;
}

export interface Run {
  id: string;
  workflowId: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  nodes: Record<string, NodeRun>;
  parentRunId?: string;
  rerunOf?: { runId: string; fromNode: string };
}

export type PatchOp =
  | { op: "add_node"; node: Partial<WorkflowNode> & { id: string; type: string } }
  | {
      op: "update_node";
      id: string;
      params?: Record<string, unknown>;
      replaceParams?: boolean;
      position?: { x: number; y: number };
      label?: string;
      credential?: string | null;
    }
  | { op: "remove_node"; id: string }
  | { op: "connect"; edge: Edge }
  | { op: "disconnect"; edge: Edge }
  | { op: "rename"; name: string; description?: string }
  | { op: "set_tool"; tool: { name: string; description?: string } | null };

export type ServerEvent =
  | { type: "workflow.changed"; workflow: Workflow }
  | { type: "workflow.deleted"; id: string }
  | { type: "nodeType.changed"; id: string }
  | { type: "credentials.changed"; credentialType: string }
  | { type: "run.started"; run: Run }
  | { type: "node.started"; runId: string; nodeId: string }
  | { type: "node.log"; runId: string; nodeId: string; line: string }
  | { type: "node.finished"; runId: string; node: NodeRun }
  | { type: "run.finished"; run: Run };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public issues?: ValidationIssue[],
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? "ERROR", e.message ?? res.statusText, e.issues);
  }
  return data as T;
}

export const api = {
  nodeTypes: () => req<NodeTypeSummary[]>("GET", "/node-types"),
  nodeType: (id: string) => req<NodeTypeDef>("GET", `/node-types/${encodeURIComponent(id)}`),
  createNodeType: (def: unknown) => req<NodeTypeDef>("POST", "/node-types", def),
  updateNodeType: (id: string, def: unknown) => req<NodeTypeDef>("PUT", `/node-types/${encodeURIComponent(id)}`, def),
  deleteNodeType: (id: string) => req<void>("DELETE", `/node-types/${encodeURIComponent(id)}`),
  testNodeType: (id: string, inputs: unknown, params: unknown) =>
    req<Run>("POST", `/node-types/${encodeURIComponent(id)}/test`, { inputs, params }),

  workflows: () => req<WorkflowSummary[]>("GET", "/workflows"),
  workflow: (id: string) => req<Workflow>("GET", `/workflows/${encodeURIComponent(id)}`),
  createWorkflow: (name: string) => req<Workflow>("POST", "/workflows", { name }),
  deleteWorkflow: (id: string) => req<void>("DELETE", `/workflows/${encodeURIComponent(id)}`),
  patch: (id: string, ops: PatchOp[], expectedVersion?: number) =>
    req<{ workflow: Workflow; issues: ValidationIssue[] }>("POST", `/workflows/${encodeURIComponent(id)}/patch`, { ops, expectedVersion }),
  validate: (id: string) => req<ValidationIssue[]>("GET", `/workflows/${encodeURIComponent(id)}/validate`),
  layout: (id: string) => req<Workflow>("POST", `/workflows/${encodeURIComponent(id)}/layout`),
  run: (id: string, inputs: Record<string, unknown>, useCache = true) =>
    req<{ id: string; status: RunStatus }>("POST", `/workflows/${encodeURIComponent(id)}/run`, { inputs, useCache }),
  rerun: (runId: string, nodeId: string) =>
    req<{ id: string; status: RunStatus }>("POST", `/runs/${encodeURIComponent(runId)}/rerun`, { nodeId }),
  nodeHistory: (workflowId: string, nodeId: string, before?: number, limit = 20) =>
    req<NodeHistoryEntry[]>(
      "GET",
      `/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/history?limit=${limit}${before ? `&before=${before}` : ""}`,
    ),
  workflowInterface: (id: string) => req<WorkflowInterface>("GET", `/workflows/${encodeURIComponent(id)}/interface`),
  credentials: (type: string) => req<CredentialInfo[]>("GET", `/credentials?type=${encodeURIComponent(type)}`),
  createCredential: (type: string, name: string, data: Record<string, string>) =>
    req<CredentialInfo>("POST", "/credentials", { type, name, data }),
  updateCredential: (id: string, patch: { name?: string; data?: Record<string, string> }) =>
    req<CredentialInfo>("PUT", `/credentials/${encodeURIComponent(id)}`, patch),
  deleteCredential: (id: string) => req<void>("DELETE", `/credentials/${encodeURIComponent(id)}`),
  credentialUsage: (id: string) => req<{ workflowId: string; nodeId: string }[]>("GET", `/credentials/${encodeURIComponent(id)}/usage`),
  clearCache: () => req<{ cleared: number }>("DELETE", "/cache"),

  runs: (workflowId: string) => req<Omit<Run, "nodes">[]>("GET", `/runs?workflowId=${encodeURIComponent(workflowId)}&limit=10`),
  getRun: (id: string) => req<Run>("GET", `/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => req<{ cancelled: boolean }>("POST", `/runs/${encodeURIComponent(id)}/cancel`),
};

export function fileUrl(path: string) {
  return `/api/files?path=${encodeURIComponent(path)}`;
}

/** Subscribe to server events; reconnects automatically (EventSource does). */
export function subscribe(onEvent: (e: ServerEvent) => void, onStatus: (connected: boolean) => void): () => void {
  const es = new EventSource("/api/events", { withCredentials: true });
  const types: ServerEvent["type"][] = [
    "workflow.changed",
    "workflow.deleted",
    "nodeType.changed",
    "credentials.changed",
    "run.started",
    "node.started",
    "node.log",
    "node.finished",
    "run.finished",
  ];
  for (const t of types) es.addEventListener(t, (m) => onEvent(JSON.parse((m as MessageEvent).data)));
  es.addEventListener("ready", () => onStatus(true));
  es.onerror = () => onStatus(false);
  return () => es.close();
}
