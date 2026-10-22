/** Served as the `naturoflow://docs/node-type-spec` resource so agents can write valid node types. */
export const NODE_TYPE_SPEC = `# naturoflow node type spec

A node type is a YAML/JSON object. Save it with \`create_node_type\` (object or YAML string).

\`\`\`yaml
id: ffmpeg.transcode          # letters, digits, _ . -
name: FFmpeg transcode
category: media
description: optional
inputs:                       # ports fed by upstream edges
  video: { type: file }       # type: any|string|number|boolean|json|file|list<T>; required defaults to true
params:                       # JSON Schema for user-configurable params (UI form is generated from it)
  type: object
  required: []
  properties:
    crf: { type: integer, default: 23 }
outputs:
  video: { type: file }
executor: ...                 # see below
timeout: 10m                  # ms number or "500ms" / "30s" / "10m" / "1h"; default 10m
retry: { max: 2, backoff: 1s }
\`\`\`

## Templates
Strings in the executor are templates: \`{{inputs.video.path}}\`, \`{{params.crf}}\`, \`{{ctx.outDir}}\`, \`{{env.HOME}}\`.
- A string that is exactly one \`{{...}}\` keeps the raw value type (object, number, file ref).
- Filters: \`json\`, \`fromjson\`, \`get:'a.b[0]'\`, \`default:5\`, \`basename\`, \`string\`, \`number\`.
- A file value interpolated into a string becomes its path.
- \`ctx.outDir\` is a fresh per-node directory; write output files there.

## Executors
Each executor's \`outputs\` maps output port -> template evaluated against the executor result.
Output ports typed \`file\` accept a path string; it is converted to {$file, path, size, mime}.

### http
\`\`\`yaml
executor:
  kind: http
  method: POST                 # template ok
  url: "{{params.url}}"
  headers: { Authorization: "Bearer {{env.MY_TOKEN}}" }   # or a single template evaluating to an object
  query: { q: "{{params.q}}" }
  body: "{{inputs.body}}"      # any JSON; bodyType: json (default) | form | text
  responseType: json           # json | text | file (body becomes a downloaded file path)
  failOnError: true            # non-2xx throws
  outputs: { body: "{{body}}", status: "{{status}}", id: "{{body.data.id}}" }
\`\`\`
Result scope: status, headers, body.

### command
Spawns a binary with an argv array. No shell is involved, so templated values cannot inject commands.
The binary must be in the server's allowedBins (default: ffmpeg, ffprobe, echo, cat, curl, convert, magick, sox).
Array-valued args are spread in place; empty strings are dropped.
\`\`\`yaml
executor:
  kind: command
  bin: ffmpeg
  args: ["-y", "-i", "{{inputs.video}}", "-crf", "{{params.crf}}", "{{ctx.outDir}}/out.mp4"]
  outputs: { video: "{{ctx.outDir}}/out.mp4" }
\`\`\`
Result scope: stdout, stderr, exitCode. Without \`outputs\`, the node returns { stdout }.

### script
\`\`\`yaml
executor:
  kind: script
  language: js                 # js (worker thread) | python (python3 subprocess)
  code: |
    export default async ({ inputs, params, ctx }) => {
      ctx.log("hello");
      return { result: inputs.x * 2 };   # object keyed by output port
    };
\`\`\`
Python: define \`def main(inputs, params, ctx): return {...}\`; \`ctx.log(...)\`, \`ctx.outDir\`.
Use \`file: ./script.py\` instead of \`code\` to reference a file next to the YAML.

### subflow
Wrap another workflow as a node type with typed ports. Input ports map to the workflow's core.input keys,
output ports to its core.output keys.
\`\`\`yaml
executor:
  kind: subflow
  workflow: video-to-gif
\`\`\`

## Builtin node types
- core.input  — params.key (+ type, description, required, default): reads a workflow run input; output \`value\`.
  These define the workflow's interface, also used when it is published as an MCP tool.
- core.output — params.key: input \`value\` becomes run output [key]
- core.const  — params.value; output \`value\`

## Control flow (builtin node types)
- core.if — input \`value\`; params.condition is a JS expression over value / inputs / params (e.g. \`value.status === 200\`).
  Fires \`true\` or \`false\`. Nodes on the untaken side are skipped (not failed); a node whose required input did not
  fire, or none of whose inputs fired, is skipped. Merge both sides into a node with optional inputs (e.g. object.merge).
- core.subflow — params.workflow; input \`inputs\` (object of run inputs) -> output \`outputs\` (object of run outputs).
- core.map — params.workflow, itemKey (default "item"), pick, concurrency, continueOnError; input \`items\` (list),
  optional \`context\` (object merged into each run's inputs) -> output \`results\` (list).

## Credentials
Declare what a node needs instead of reading env vars; users save any number of credentials per type
in the canvas (encrypted at rest) and pick one per node. Values are \`{{credential.<field>}}\` in templates
(\`ctx.credential\` in scripts) and are masked in logs.
\`\`\`yaml
credentials:
  type: byteplus-ark        # optional; node types sharing a type share saved credentials (default: node type id)
  name: BytePlus ModelArk
  fields:
    api_key: { label: API Key }            # secret by default
    region:  { label: Region, secret: false, required: false }
executor:
  kind: http
  headers: { Authorization: "Bearer {{credential.api_key}}" }
\`\`\`

## Templated params
A workflow node's param value may itself be a template over that node's \`inputs\` and the run's inputs:
\`{ "duration": "{{workflow.inputs.seconds}}" }\`. This is how a workflow input reaches a param.

## Translations
The canvas UI is shown in Chinese or English. Write \`name\`, \`description\` and help texts in one language and add the
other under \`i18n\`, keyed by language (\`zh\` or \`en\`); anything left out falls back to the main text:
\`\`\`yaml
i18n:
  en:
    name: Video to GIF
    description: Convert a video into an animated GIF
    params: { fps: Frames per second }       # param key -> help text
    inputs: { video: The video to convert }  # port -> help text (outputs: likewise)
    credentials: { name: My API, fields: { api_key: { label: API key, description: Where to find it } } }
\`\`\`

## Caching
\`cache: true\` on a node type (or \`cache\` on a workflow node) reuses outputs when the type definition, params and
inputs (files by path + size + mtime) match an earlier execution. Only enable it for deterministic nodes.

## Workflows
Workflow = { id, name, nodes: [{id, type, params, position}], edges: [{from: {node, port}, to: {node, port}}] }.
An input port accepts exactly one edge; use a merge node to combine several values.
Prefer \`apply_workflow_patch\` to make several edits atomically, then \`validate_workflow\`.
`;
