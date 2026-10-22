# naturoflow

可自定义节点的画布工作流引擎，目标是所有操作都能通过 MCP 由 AI 完成。

## 当前状态：M1 引擎 ✅ · M2 Server + MCP ✅ · M3 画布 ✅ · M4 控制流 / 缓存 / 发布 ✅

- `packages/core`：节点类型 schema、`{{ }}` 模板、执行器（`http` / `command` / `script` js+python / `builtin`）、DAG 并发调度（超时、重试、取消、失败后下游跳过）、SQLite 存储（`node:sqlite`）、统一 Service 层（之后 REST / MCP 都调它）
- `packages/cli`：命令行入口
- `packages/server`：Hono HTTP（REST `/api/*`、SSE `/api/events` 实时事件、`/mcp` Streamable HTTP），24 个 MCP tools + resources，stdio 模式
- `packages/web`：React Flow 画布（节点库拖放、按数据类型着色的连线和连接校验、JSON Schema 自动生成参数表单、运行状态与日志、图片/视频/音频输出预览、节点类型 YAML 编辑器和试运行、深色模式），通过 SSE 实时同步 AI 的修改
- `examples/nodes`：示例节点（HTTP 请求/下载、ffmpeg 生成/转码/转 GIF/probe、JS/Python 脚本、对象合并）

## 快速开始

```bash
pnpm install
pnpm nf nodes
pnpm nf run examples/workflows/video-to-gif.json
pnpm nf test-node js.transform -i input=20 -p code='return inputs.input + 1;'
pnpm test
```

## 打开画布

```bash
pnpm web:build      # 构建一次 UI（改了前端后重新构建即可，无需重启 server）
pnpm nf serve       # 打开终端里打印的 Canvas 链接（/auth?token=...），之后用 cookie 登录
```

前端开发：先 `pnpm nf serve`，再 `pnpm web:dev`，Vite 会把 `/api` 代理到 7788；先在 Vite 页面打开一次 `/auth?token=...`。

## 接入 AI（MCP）

方式一：stdio（Claude Desktop / Claude Code / Cursor 都支持）。如果已有 `naturoflow serve` 在跑，会自动代理到它，AI 的修改在画布上实时可见；否则在进程内嵌启动一个 server。

```bash
claude mcp add naturoflow -- npx tsx /Users/lifeng/project/naturoflow/packages/cli/src/index.ts mcp
```

方式二：Streamable HTTP。先 `pnpm nf serve`，它会打印带 token 的 `claude mcp add --transport http ...` 命令。

server 只监听 127.0.0.1，校验 Host 头（防 DNS rebinding），所有接口需要 token（`Authorization: Bearer`，或浏览器打开一次 `/?token=` 后用 cookie）。连接信息写在 `~/.naturoflow/server.json`（权限 600）。

MCP tools：`list_node_types` `get_node_type` `create_node_type` `update_node_type` `delete_node_type` `test_node_type` `reload_node_types` · `list_workflows` `get_workflow` `create_workflow` `delete_workflow` `apply_workflow_patch` `add_node` `update_node` `remove_node` `connect` `disconnect` `validate_workflow` `auto_layout` · `run_workflow` `get_run` `list_runs` `get_node_run_logs` `cancel_run`。
Resources：`naturoflow://docs/node-type-spec`、`naturoflow://workflows/{id}`、`naturoflow://node-types/{id}`、`naturoflow://runs/{id}`。

数据目录默认 `~/.naturoflow`（可用 `NATUROFLOW_HOME` 覆盖）：`nodes/` 放你自己的节点 YAML，`runs/` 是每次运行的产物，`config.yaml` 可配置 `allowedBins`、`concurrency`、`nodeDirs`。

## 自定义节点

一个节点 = 端口 + 参数 JSON Schema + 执行器模板，见 `examples/nodes/ffmpeg.transcode.yaml`。

- `command` 执行器用 argv 数组直接 spawn，**不经过 shell**；二进制必须在 `allowedBins` 里。
- 模板：`{{inputs.video.path}}`、`{{params.crf}}`、`{{ctx.outDir}}`；过滤器 `json` `fromjson` `get:'a.b'` `default:x` `basename` `string` `number`。整串只有一个 `{{ }}` 时保留原始类型。
- 输出端口声明为 `file` 时，返回的路径会自动转成 `{ $file, path, size, mime }` 在节点间传递。

## 凭据（API Key 等）

节点类型用 `credentials` 声明需要哪些字段（见 `naturoflow://docs/node-type-spec`），模板里用 `{{credential.api_key}}` 引用。在画布上选中节点，参数面板顶部可以新建、切换、改名或删除凭据：同一类型可以存多个（比如 key 1 / key 2），每个节点各自选用。

- 加密保存在本机 SQLite（AES-256-GCM，密钥在 `~/.naturoflow/secret.key`，权限 600）
- 接口、MCP、运行记录里都不返回明文，日志和错误信息里出现的 key 会替换成 `****`
- AI 通过 MCP 只能 `list_credentials` 看名字，并用 `update_node {credential}` 给节点选凭据，不能读取或填写 key

## 控制流、缓存与发布（M4）

- **core.if**：`condition` 是基于 `value` / `inputs` / `params` 的 JS 表达式，只触发 `true` 或 `false` 一侧；没走到的一侧显示为「未走此分支」（不算失败）。两条分支可以汇入带可选输入的节点（如 `object.merge`）。
- **core.subflow / core.map**：调用另一个已保存的工作流；Map 对列表每一项各跑一次（可并发、可 `pick` 某个输出）。也可以写 `executor: { kind: subflow, workflow: <id> }` 的节点类型，把工作流包装成有类型端口的节点。子运行会记录 `parentRunId`，嵌套超过 8 层报错。
- **参数模板**：节点参数值可以写 `{{workflow.inputs.x}}` 或 `{{inputs.port}}`，执行前渲染，这样工作流输入可以传进参数（见 `examples/workflows/make-gif.json`）。
- **缓存**：节点类型 `cache: true`（示例里 ffmpeg 节点已开启），按「类型定义 + 参数 + 输入（文件按路径/大小/修改时间）」哈希复用输出；输出文件被删会自动失效。工作流节点可用 `cache: false` 单独关闭；运行时 `useCache: false` 跳过缓存。
- **从节点重跑**：`rerun_from_node`（或检查器里「从这里重新运行」）只重跑该节点及下游，上游沿用上次运行的输出。
- **发布为 MCP 工具**：`publish_workflow` 或检查器里的「发布为 MCP 工具」。`core.input` 节点的 `key / type / description / required` 就是工具参数（`file` 类型传绝对路径），`core.output` 是返回值。已连接的 MCP 客户端会收到 `tools/list_changed`。

示例：`examples/workflows/make-gif.json`（已发布为 `make_test_gif`）和 `batch-gifs.json`（If + Map）。用 `pnpm nf import <file>` 导入。
