import { useEffect, useRef, useState } from "react";
import YAML from "yaml";
import { api, ApiError, type Run } from "./api.ts";
import { useStore } from "./store.ts";

const TEMPLATE = `id: my.http-post
name: 我的 HTTP POST
category: network
description: 把输入作为 JSON POST 出去，返回响应体
inputs:
  body: { type: json }
params:
  type: object
  required: [url]
  properties:
    url: { type: string }
outputs:
  response: { type: json }
executor:
  kind: http
  method: POST
  url: "{{params.url}}"
  body: "{{inputs.body}}"
  outputs:
    response: "{{body}}"
timeout: 30s
`;

/** Strip fields the API adds that aren't part of the definition. */
function toYaml(def: Record<string, unknown>) {
  const { source: _s, readonly: _r, ...rest } = def;
  return YAML.stringify(rest);
}

export function NodeTypeEditor() {
  const editor = useStore((s) => s.editor);
  const setEditor = useStore((s) => s.setEditor);
  const notify = useStore((s) => s.notify);
  const loadNodeTypes = useStore((s) => s.loadNodeTypes);
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [readonly, setReadonly] = useState(false);
  const [origId, setOrigId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testInputs, setTestInputs] = useState("{}");
  const [testParams, setTestParams] = useState("{}");
  const [testResult, setTestResult] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editor) return dialog.current?.close();
    setError(null);
    setTestResult(null);
    setTestInputs("{}");
    setTestParams("{}");
    if (editor.mode === "new") {
      setText(TEMPLATE);
      setReadonly(false);
      setOrigId(null);
    } else {
      api.nodeType(editor.id).then((def) => {
        setText(toYaml(def as unknown as Record<string, unknown>));
        setReadonly(def.readonly);
        setOrigId(def.readonly ? null : def.id);
      });
    }
    dialog.current?.showModal();
  }, [editor]);

  const parse = (): Record<string, unknown> | null => {
    try {
      const v = YAML.parse(text);
      if (!v || typeof v !== "object") throw new Error("定义必须是一个对象");
      return v;
    } catch (e) {
      setError(`YAML 解析失败：${(e as Error).message}`);
      return null;
    }
  };

  const save = async () => {
    const def = parse();
    if (!def) return null;
    setBusy(true);
    try {
      const saved =
        origId && def.id === origId ? await api.updateNodeType(origId, def) : await api.createNodeType(def);
      setError(null);
      setOrigId(saved.id);
      setReadonly(false);
      await loadNodeTypes();
      notify("info", `已保存节点类型 ${saved.id}`);
      return saved.id;
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === "CONFLICT" ? `id “${def.id}” 已被占用，换一个 id 再保存` : `${err.message}${(err as { path?: string }).path ? `（${(err as { path?: string }).path}）` : ""}`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const id = await save();
    if (!id) return;
    let inputs: unknown, params: unknown;
    try {
      inputs = JSON.parse(testInputs || "{}");
      params = JSON.parse(testParams || "{}");
    } catch {
      return setError("测试的输入和参数必须是合法的 JSON");
    }
    setBusy(true);
    try {
      setTestResult(await api.testNodeType(id, inputs, params));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!origId || !confirm(`删除节点类型 ${origId}？用到它的工作流会报“找不到节点类型”。`)) return;
    await api.deleteNodeType(origId);
    await loadNodeTypes();
    notify("info", `已删除节点类型 ${origId}`);
    setEditor(null);
  };

  const node = testResult?.nodes.node;

  return (
    <dialog ref={dialog} className="nf-dialog" onClose={() => setEditor(null)} aria-labelledby="nte-title">
      <header className="nf-dialog__head">
        <h2 id="nte-title">{editor?.mode === "new" ? "新建节点类型" : `编辑 ${editor?.mode === "edit" ? editor.id : ""}`}</h2>
        <button className="nf-btn nf-btn--ghost" onClick={() => setEditor(null)}>
          关闭
        </button>
      </header>
      {readonly && (
        <p className="nf-warn">这是内置示例，不能直接修改。改一下 id 再保存，就会在你的节点目录里另存一份。</p>
      )}
      <div className="nf-dialog__body">
        <div className="nf-dialog__editor">
          <textarea
            className="nf-input nf-code nf-yaml"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="节点类型 YAML"
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                const t = e.currentTarget;
                const { selectionStart: a, selectionEnd: b } = t;
                setText(text.slice(0, a) + "  " + text.slice(b));
                requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                save();
              }
            }}
          />
          {error && <p className="nf-field__error">{error}</p>}
          <p className="nf-muted">
            执行器支持 http、command（不经过 shell，程序需在白名单中）、script（js / python）。完整写法见 MCP 资源{" "}
            <code>naturoflow://docs/node-type-spec</code>。
          </p>
        </div>
        <div className="nf-dialog__test">
          <h3>试运行</h3>
          <label className="nf-field__label" htmlFor="nte-in">输入（JSON，按端口名）</label>
          <textarea id="nte-in" className="nf-input nf-code" rows={3} value={testInputs} onChange={(e) => setTestInputs(e.target.value)} />
          <label className="nf-field__label" htmlFor="nte-params">参数（JSON）</label>
          <textarea id="nte-params" className="nf-input nf-code" rows={3} value={testParams} onChange={(e) => setTestParams(e.target.value)} />
          <button className="nf-btn" onClick={test} disabled={busy}>
            保存并试运行
          </button>
          {node && (
            <div className="nf-run">
              <p className="nf-run__status" data-status={node.status}>
                {node.status === "success" ? "成功" : "失败"}
              </p>
              {node.error && <pre className="nf-run__error">{node.error}</pre>}
              {node.outputs && <pre className="nf-log">{JSON.stringify(node.outputs, null, 2)}</pre>}
              {node.logs.length > 0 && <pre className="nf-log">{node.logs.slice(-80).join("\n")}</pre>}
            </div>
          )}
        </div>
      </div>
      <footer className="nf-dialog__foot">
        {origId && (
          <button className="nf-btn nf-btn--danger" onClick={remove}>
            删除类型
          </button>
        )}
        <span className="nf-spacer" />
        <button className="nf-btn nf-btn--primary" onClick={save} disabled={busy}>
          保存
        </button>
      </footer>
    </dialog>
  );
}
