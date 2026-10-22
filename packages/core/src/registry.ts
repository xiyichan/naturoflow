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

const WORKFLOW_PARAM = { type: "string", format: "workflow-id", description: "Id of the workflow to run" };

const BUILTIN_TYPES: NodeTypeInput[] = [
  {
    id: "core.input",
    name: "Workflow Input",
    category: "core",
    description: "Reads a workflow input value by params.key. Declares the workflow's interface (also used when published as an MCP tool).",
    params: {
      type: "object",
      properties: {
        key: { type: "string", description: "Input name" },
        type: { type: "string", enum: ["any", "string", "number", "boolean", "json", "file"], default: "any" },
        description: { type: "string" },
        required: { type: "boolean", default: true },
        default: {},
      },
    },
    outputs: { value: { type: "any" } },
    executor: { kind: "builtin", name: "input" },
    i18n: {
      zh: {
        name: "工作流输入",
        description: "按 key 读取工作流的一个输入值。用来声明工作流的参数（发布为 MCP 工具时也用它）。",
        params: { key: "输入名" },
      },
    },
  },
  {
    id: "core.output",
    name: "Workflow Output",
    category: "core",
    description: "Exposes its input as workflow output params.key.",
    params: { type: "object", properties: { key: { type: "string", description: "Output name" } } },
    inputs: { value: { type: "any" } },
    outputs: { value: { type: "any" } },
    executor: { kind: "builtin", name: "output" },
    i18n: { zh: { name: "工作流输出", description: "把输入作为工作流的一个输出（名字为 key）。", params: { key: "输出名" } } },
  },
  {
    id: "core.const",
    name: "Constant",
    category: "core",
    params: { type: "object", properties: { value: {} } },
    outputs: { value: { type: "any" } },
    executor: { kind: "builtin", name: "const" },
    i18n: { zh: { name: "常量" } },
  },
  {
    id: "core.file",
    name: "File",
    category: "core",
    description: "A file to feed into the workflow: a generated result, an upload, or any local path.",
    params: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", format: "file-path", description: "Local file path (filled in when dragged from the assets panel)" } },
    },
    outputs: { file: { type: "file" } },
    executor: { kind: "builtin", name: "file" },
    i18n: {
      zh: {
        name: "文件",
        description: "送进工作流的一个文件：生成的结果、上传的文件或任意本地路径。",
        params: { path: "本地文件路径（素材面板拖进来时自动填写）" },
      },
    },
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
        condition: { type: "string", default: "value", description: "JS expression, e.g. value.status === 200" },
      },
    },
    outputs: { true: { type: "any", required: false }, false: { type: "any", required: false } },
    executor: { kind: "builtin", name: "if" },
    i18n: {
      zh: {
        name: "条件分支",
        description: "把 value 送到 true 或 false 输出。condition 是基于 value / inputs / params 的 JS 表达式，另一侧会被跳过。",
        params: { condition: "JS 表达式，例如 value.status === 200" },
      },
    },
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
    i18n: {
      zh: {
        name: "子工作流",
        description: "运行另一个工作流。inputs 是它的运行输入对象，outputs 是它的运行输出对象。",
        params: { workflow: "要运行的工作流 id" },
      },
    },
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
        itemKey: { type: "string", default: "item", description: "Input name each item is passed to the subflow as" },
        pick: { type: "string", description: "Take only this subflow output; leave empty for all outputs" },
        concurrency: { type: "integer", default: 4, minimum: 1 },
        continueOnError: { type: "boolean", default: false },
      },
    },
    outputs: { results: { type: "list<any>" }, errors: { type: "list<string>", required: false } },
    executor: { kind: "builtin", name: "map" },
    i18n: {
      zh: {
        name: "逐项运行",
        description: "对列表里的每一项运行一次工作流。每次的输入是 { [itemKey]: 当前项, index, ...context }，results 是所有输出组成的列表。",
        params: {
          workflow: "要运行的工作流 id",
          itemKey: "每一项传给子工作流时用的输入名",
          pick: "只取子工作流的这个输出；留空则取全部输出",
        },
      },
    },
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
