import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { NfError, NodeTypeDef, type NodeTypeInput } from "./types.ts";

export interface RegisteredType {
  def: NodeTypeDef;
  /** File it was loaded from; undefined for builtins. */
  source?: string;
  readonly: boolean;
}

const WORKFLOW_PARAM = { type: "string", format: "workflow-id", description: "要运行的工作流 id" };

const BUILTIN_TYPES: NodeTypeInput[] = [
  {
    id: "core.input",
    name: "Workflow Input",
    category: "core",
    description: "Reads a workflow input value by params.key. Declares the workflow's interface (also used when published as an MCP tool).",
    params: {
      type: "object",
      properties: {
        key: { type: "string", description: "输入名" },
        type: { type: "string", enum: ["any", "string", "number", "boolean", "json", "file"], default: "any" },
        description: { type: "string" },
        required: { type: "boolean", default: true },
        default: {},
      },
    },
    outputs: { value: { type: "any" } },
    executor: { kind: "builtin", name: "input" },
  },
  {
    id: "core.output",
    name: "Workflow Output",
    category: "core",
    description: "Exposes its input as workflow output params.key.",
    params: { type: "object", properties: { key: { type: "string", description: "输出名" } } },
    inputs: { value: { type: "any" } },
    outputs: { value: { type: "any" } },
    executor: { kind: "builtin", name: "output" },
  },
  {
    id: "core.const",
    name: "Constant",
    category: "core",
    params: { type: "object", properties: { value: {} } },
    outputs: { value: { type: "any" } },
    executor: { kind: "builtin", name: "const" },
  },
  {
    id: "core.if",
    name: "If",
    category: "core",
    description: "Routes value to the true or false output. condition is a JS expression over value / inputs / params; the other side is skipped.",
    inputs: { value: { type: "any" } },
    params: {
      type: "object",
      properties: {
        condition: { type: "string", default: "value", description: "JS 表达式，例如 value.status === 200" },
      },
    },
    outputs: { true: { type: "any", required: false }, false: { type: "any", required: false } },
    executor: { kind: "builtin", name: "if" },
  },
  {
    id: "core.subflow",
    name: "Subflow",
    category: "core",
    description: "Runs another workflow. inputs is an object of its run inputs; outputs is the object of its run outputs.",
    inputs: { inputs: { type: "json", required: false } },
    params: { type: "object", required: ["workflow"], properties: { workflow: WORKFLOW_PARAM } },
    outputs: { outputs: { type: "json" } },
    executor: { kind: "builtin", name: "subflow" },
  },
  {
    id: "core.map",
    name: "Map",
    category: "core",
    description: "Runs a workflow once per item. Each run gets inputs { [itemKey]: item, index, ...context }; results is the list of outputs.",
    inputs: { items: { type: "any" }, context: { type: "json", required: false } },
    params: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: WORKFLOW_PARAM,
        itemKey: { type: "string", default: "item", description: "每一项传给子工作流时用的输入名" },
        pick: { type: "string", description: "只取子工作流的这个输出；留空则取全部输出" },
        concurrency: { type: "integer", default: 4, minimum: 1 },
        continueOnError: { type: "boolean", default: false },
      },
    },
    outputs: { results: { type: "list<any>" }, errors: { type: "list<string>", required: false } },
    executor: { kind: "builtin", name: "map" },
  },
];

/**
 * Node types come from builtins plus YAML/JSON files in one or more directories.
 * New types are written to `writeDir` (the user's node directory).
 */
export class NodeRegistry {
  private types = new Map<string, RegisteredType>();
  /** Files that failed to parse on the last reload. */
  loadErrors: { file: string; message: string }[] = [];

  constructor(
    private dirs: string[],
    private writeDir: string,
  ) {
    this.reload();
  }

  reload(): { errors: { file: string; message: string }[] } {
    this.types.clear();
    for (const b of BUILTIN_TYPES) this.types.set(b.id, { def: NodeTypeDef.parse(b), readonly: true });
    const errors: { file: string; message: string }[] = [];
    // Later dirs override earlier ones, so the user's dir (last) wins over examples.
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).sort()) {
        if (!/\.(ya?ml|json)$/.test(f)) continue;
        const file = path.join(dir, f);
        try {
          const def = NodeTypeDef.parse(YAML.parse(fs.readFileSync(file, "utf8")));
          if (this.types.get(def.id)?.readonly && !this.types.get(def.id)?.source) {
            throw new Error(`cannot override builtin type ${def.id}`);
          }
          this.types.set(def.id, { def, source: file, readonly: path.resolve(dir) !== path.resolve(this.writeDir) });
        } catch (e) {
          errors.push({ file, message: (e as Error).message });
        }
      }
    }
    this.loadErrors = errors;
    return { errors };
  }

  list(): RegisteredType[] {
    return [...this.types.values()];
  }

  get(id: string): RegisteredType | undefined {
    return this.types.get(id);
  }

  require(id: string): RegisteredType {
    const t = this.types.get(id);
    if (!t) throw new NfError("NODE_TYPE_NOT_FOUND", `unknown node type "${id}"`);
    return t;
  }

  /** Validate and persist a node type to the user's directory (create or overwrite). */
  save(input: unknown): NodeTypeDef {
    const parsed = NodeTypeDef.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new NfError("INVALID_NODE_TYPE", issue.message, issue.path.join("."));
    }
    const def = parsed.data;
    const existing = this.types.get(def.id);
    if (existing && !existing.source) throw new NfError("READONLY", `${def.id} is a builtin type`);
    fs.mkdirSync(this.writeDir, { recursive: true });
    const file = path.join(this.writeDir, `${def.id}.yaml`);
    fs.writeFileSync(file, YAML.stringify(input));
    this.types.set(def.id, { def, source: file, readonly: false });
    return def;
  }

  delete(id: string): void {
    const t = this.require(id);
    if (t.readonly || !t.source) throw new NfError("READONLY", `${id} is not in the user node directory`);
    fs.rmSync(t.source);
    this.reload();
  }
}
