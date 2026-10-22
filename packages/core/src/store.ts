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
      CREATE TABLE IF NOT EXISTS artifact_marks (
        path TEXT PRIMARY KEY, starred INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
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

  /**
   * One node's executions across a workflow's runs, newest first. Nodes that never ran in a run
   * (pending/skipped) are left out. `before` (a run startedAt) pages backwards.
   */
  nodeHistory(workflowId: string, nodeId: string, limit = 20, before?: number): NodeHistoryEntry[] {
    const path = `$.nodes."${nodeId.replace(/"/g, "")}"`;
    const rows = this.db
      .prepare(
        `SELECT id, started_at, status, json_extract(json, '$.rerunOf') AS rerun_of,
                json_extract(json, '$.single') AS single, json_extract(json, ?) AS node
         FROM runs
         WHERE workflow_id = ? AND started_at < ?
           AND json_extract(json, ? || '.status') NOT IN ('pending', 'skipped')
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(path, workflowId, before ?? Number.MAX_SAFE_INTEGER, path, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      runId: String(r.id),
      runStartedAt: Number(r.started_at),
      runStatus: String(r.status) as RunRecord["status"],
      ...(r.rerun_of ? { rerunOf: JSON.parse(String(r.rerun_of)) } : {}),
      ...(r.single ? { single: JSON.parse(String(r.single)) } : {}),
      node: JSON.parse(String(r.node)),
    }));
  }

  /** Full run records of a workflow, newest first (for building the artifact gallery). */
  runsOf(workflowId: string, before = Number.MAX_SAFE_INTEGER, limit = 100): RunRecord[] {
    return (
      this.db
        .prepare("SELECT json FROM runs WHERE workflow_id = ? AND started_at < ? ORDER BY started_at DESC LIMIT ?")
        .all(workflowId, before, limit) as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }

  getMarks(paths: string[]): Map<string, { starred: boolean; note: string }> {
    const out = new Map<string, { starred: boolean; note: string }>();
    if (!paths.length) return out;
    const rows = this.db
      .prepare(`SELECT path, starred, note FROM artifact_marks WHERE path IN (${paths.map(() => "?").join(",")})`)
      .all(...paths) as { path: string; starred: number; note: string }[];
    for (const r of rows) out.set(r.path, { starred: !!r.starred, note: r.note });
    return out;
  }

  starredPaths(): Set<string> {
    return new Set((this.db.prepare("SELECT path FROM artifact_marks WHERE starred = 1").all() as { path: string }[]).map((r) => r.path));
  }

  setMark(path: string, mark: { starred?: boolean; note?: string }): { starred: boolean; note: string } {
    const cur = this.getMarks([path]).get(path) ?? { starred: false, note: "" };
    const next = { starred: mark.starred ?? cur.starred, note: mark.note ?? cur.note };
    if (!next.starred && !next.note) this.db.prepare("DELETE FROM artifact_marks WHERE path = ?").run(path);
    else {
      this.db
        .prepare(
          `INSERT INTO artifact_marks (path, starred, note, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET starred = excluded.starred, note = excluded.note, updated_at = excluded.updated_at`,
        )
        .run(path, next.starred ? 1 : 0, next.note, Date.now());
    }
    return next;
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

export interface NodeHistoryEntry {
  runId: string;
  runStartedAt: number;
  runStatus: RunRecord["status"];
  rerunOf?: RunRecord["rerunOf"];
  single?: RunRecord["single"];
  node: NodeRunRecord;
}
