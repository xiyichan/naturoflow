import { DatabaseSync } from "node:sqlite";
import type { NodeRunRecord, RunRecord, Workflow } from "./types.ts";

/** SQLite persistence for workflows and runs (node:sqlite, no native deps). */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL,
        version INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
        json TEXT NOT NULL, started_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_wf ON runs(workflow_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
        fields TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_cache (
        key TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  }

  listWorkflows(): { id: string; name: string; version: number; updatedAt: number }[] {
    return this.db
      .prepare("SELECT id, name, version, updated_at AS updatedAt FROM workflows ORDER BY updated_at DESC")
      .all() as never;
  }

  allWorkflows(): Workflow[] {
    return (this.db.prepare("SELECT json FROM workflows").all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  getWorkflow(id: string): Workflow | undefined {
    const row = this.db.prepare("SELECT json FROM workflows WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  saveWorkflow(wf: Workflow): void {
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, json, version, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, json = excluded.json,
           version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(wf.id, wf.name, JSON.stringify(wf), wf.version, Date.now());
  }

  deleteWorkflow(id: string): boolean {
    return this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes > 0;
  }

  saveRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, workflow_id, status, json, started_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json`,
      )
      .run(run.id, run.workflowId, run.status, JSON.stringify(run), run.startedAt);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT json FROM runs WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  listRuns(workflowId?: string, limit = 20): Omit<RunRecord, "nodes">[] {
    const rows = (
      workflowId
        ? this.db.prepare("SELECT json FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?").all(workflowId, limit)
        : this.db.prepare("SELECT json FROM runs ORDER BY started_at DESC LIMIT ?").all(limit)
    ) as { json: string }[];
    return rows.map((r) => {
      const { nodes: _nodes, ...rest } = JSON.parse(r.json) as RunRecord;
      return rest;
    });
  }

  // ---- credentials (data is encrypted by the service before it gets here) ----
  listCredentials(type?: string): CredentialRow[] {
    const rows = (
      type
        ? this.db.prepare("SELECT * FROM credentials WHERE type = ? ORDER BY name").all(type)
        : this.db.prepare("SELECT * FROM credentials ORDER BY type, name").all()
    ) as Record<string, unknown>[];
    return rows.map(toCredentialRow);
  }

  getCredential(id: string): CredentialRow | undefined {
    const row = this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toCredentialRow(row) : undefined;
  }

  saveCredential(c: CredentialRow): void {
    this.db
      .prepare(
        `INSERT INTO credentials (id, type, name, data, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data,
           fields = excluded.fields, updated_at = excluded.updated_at`,
      )
      .run(c.id, c.type, c.name, c.data, JSON.stringify(c.fields), c.createdAt, c.updatedAt);
  }

  deleteCredential(id: string): boolean {
    return this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id).changes > 0;
  }

  // ---- node output cache (implements engine NodeCache) ----
  getCache(key: string): { outputs: Record<string, unknown>; inactive?: string[] } | undefined {
    const row = this.db.prepare("SELECT json FROM node_cache WHERE key = ?").get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }

  setCache(key: string, value: { outputs: Record<string, unknown>; inactive?: string[] }): void {
    this.db
      .prepare("INSERT OR REPLACE INTO node_cache (key, json, created_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), Date.now());
  }

  clearCache(): number {
    return Number(this.db.prepare("DELETE FROM node_cache").run().changes);
  }

  getNodeRun(runId: string, nodeId: string): NodeRunRecord | undefined {
    return this.getRun(runId)?.nodes[nodeId];
  }

  close() {
    this.db.close();
  }
}

export interface CredentialRow {
  id: string;
  type: string;
  name: string;
  /** Encrypted JSON of the field values. */
  data: string;
  /** Names of the fields that have a value (safe to show). */
  fields: string[];
  createdAt: number;
  updatedAt: number;
}

function toCredentialRow(r: Record<string, unknown>): CredentialRow {
  return {
    id: String(r.id),
    type: String(r.type),
    name: String(r.name),
    data: String(r.data),
    fields: JSON.parse(String(r.fields)),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
