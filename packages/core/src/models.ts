import fs from "node:fs";
import path from "node:path";
import { NfError, type ModelSpec } from "./types.ts";

/** What the UI / MCP see for one downloadable model. */
export interface ModelStatus {
  id: string;
  name: string;
  url: string;
  /** Approximate size in MB, as declared by the node type. */
  sizeMb?: number;
  downloaded: boolean;
  /** Bytes on disk when downloaded. */
  bytes?: number;
  /** While downloading. */
  progress?: { received: number; total?: number };
  /** The last download's failure, until a new one starts. */
  error?: string;
  /** Node types that use this model. */
  nodeTypes: string[];
}

interface Job {
  received: number;
  total?: number;
  abort: AbortController;
}

const HF = "https://huggingface.co";

/**
 * Model files that node types declare under `models:`. They are downloaded only on request
 * (the node's panel, or MCP), into <home>/models/<id><ext>, never in the middle of a run.
 */
export class ModelManager {
  private jobs = new Map<string, Job>();
  private errors = new Map<string, string>();

  constructor(
    readonly dir: string,
    private specs: () => { spec: ModelSpec; nodeType: string }[],
    private emit: (status: ModelStatus) => void,
  ) {}

  /** Where a model lives on disk (whether or not it is there yet). */
  pathOf(spec: Pick<ModelSpec, "id" | "url">): string {
    const ext = path.extname(new URL(spec.url).pathname) || ".bin";
    return path.join(this.dir, `${spec.id}${ext}`);
  }

  private find(id: string) {
    const all = this.specs().filter((s) => s.spec.id === id);
    if (!all.length) throw new NfError("MODEL_NOT_FOUND", `no node type declares a model "${id}"`);
    return { spec: all[0].spec, nodeTypes: [...new Set(all.map((s) => s.nodeType))] };
  }

  status(id: string): ModelStatus {
    const { spec, nodeTypes } = this.find(id);
    const file = this.pathOf(spec);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    const job = this.jobs.get(id);
    const err = this.errors.get(id);
    return {
      id,
      name: spec.name ?? id,
      url: spec.url,
      ...(spec.size !== undefined ? { sizeMb: spec.size } : {}),
      downloaded: !!st?.isFile(),
      ...(st?.isFile() ? { bytes: st.size } : {}),
      ...(job ? { progress: { received: job.received, ...(job.total ? { total: job.total } : {}) } } : {}),
      ...(err ? { error: err } : {}),
      nodeTypes,
    };
  }

  list(nodeType?: string): ModelStatus[] {
    const ids = [...new Set(this.specs().filter((s) => !nodeType || s.nodeType === nodeType).map((s) => s.spec.id))];
    return ids.map((id) => this.status(id));
  }

  isDownloaded(id: string): boolean {
    try {
      return this.status(id).downloaded;
    } catch {
      return false;
    }
  }

  /**
   * Start downloading (returns at once; progress arrives through `emit`). `mirror` replaces the
   * https://huggingface.co prefix, e.g. https://hf-mirror.com. Resolves when the download ends.
   */
  download(id: string, opts: { mirror?: string } = {}): { status: ModelStatus; done: Promise<ModelStatus> } {
    const { spec } = this.find(id);
    const current = this.status(id);
    if (current.downloaded) return { status: current, done: Promise.resolve(current) };
    const running = this.jobs.get(id);
    if (running) return { status: current, done: this.waitFor(id) };

    const job: Job = { received: 0, abort: new AbortController() };
    this.jobs.set(id, job);
    this.errors.delete(id);
    const url = opts.mirror && spec.url.startsWith(HF) ? opts.mirror.replace(/\/+$/, "") + spec.url.slice(HF.length) : spec.url;
    const dest = this.pathOf(spec);
    const part = `${dest}.${process.pid}.part`;

    const done = (async () => {
      let out: fs.WriteStream | undefined;
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const res = await fetch(url, { signal: job.abort.signal, redirect: "follow" });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        job.total = Number(res.headers.get("content-length")) || (spec.size ? spec.size * 1e6 : undefined);
        out = fs.createWriteStream(part);
        let lastEmit = 0;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (!out.write(chunk)) await new Promise<void>((r) => out!.once("drain", () => r()));
          job.received += chunk.length;
          if (Date.now() - lastEmit > 400) {
            lastEmit = Date.now();
            this.emit(this.status(id));
          }
        }
        await new Promise<void>((r, j) => out!.end((e?: Error | null) => (e ? j(e) : r())));
        if (job.total && job.received < job.total * 0.98) throw new Error(`download incomplete (${job.received} of ${job.total} bytes)`);
        if (job.received < 1024) throw new Error(`download looks truncated (${job.received} bytes)`);
        fs.renameSync(part, dest);
      } catch (e) {
        out?.destroy();
        fs.rmSync(part, { force: true });
        this.errors.set(id, job.abort.signal.aborted ? "cancelled" : (e as Error).message);
      } finally {
        this.jobs.delete(id);
      }
      const final = this.status(id);
      this.emit(final);
      return final;
    })();
    this.waiters.set(id, done);
    return { status: this.status(id), done };
  }

  private waiters = new Map<string, Promise<ModelStatus>>();
  private waitFor(id: string) {
    return this.waiters.get(id) ?? Promise.resolve(this.status(id));
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    job?.abort.abort();
    return !!job;
  }

  remove(id: string): ModelStatus {
    const { spec } = this.find(id);
    this.cancel(id);
    fs.rmSync(this.pathOf(spec), { force: true });
    this.errors.delete(id);
    const st = this.status(id);
    this.emit(st);
    return st;
  }
}
