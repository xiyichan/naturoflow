import { useEffect, useState } from "react";
import type { JsonSchema } from "./api.ts";
import { useStore } from "./store.ts";

/**
 * Renders a form from a node type's params JSON Schema. Scalars get native inputs;
 * objects, arrays and untyped values are edited as JSON. Values may be `{{ }}` templates.
 */
export function ParamForm({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (key: string, v: unknown) => void;
}) {
  const props = Object.entries(schema.properties ?? {});
  if (!props.length) return <p className="nf-muted">这个节点没有可配置的参数。</p>;
  const required = new Set(schema.required ?? []);
  return (
    <div className="nf-form">
      {props.map(([key, s]) => (
        <Field key={key} name={key} schema={s} required={required.has(key)} value={value[key]} onChange={(v) => onChange(key, v)} />
      ))}
    </div>
  );
}

function Field({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `param-${name}`;
  const isDefault = value === undefined;
  const shown = isDefault ? schema.default : value;
  const label = (
    <label htmlFor={id} className="nf-field__label">
      <span>{schema.title ?? name}</span>
      {required && <em>必填</em>}
      {!isDefault && schema.default !== undefined && (
        <button type="button" className="nf-link" onClick={() => onChange(undefined)}>
          恢复默认
        </button>
      )}
    </label>
  );
  const help = schema.description && <small className="nf-field__help">{schema.description}</small>;

  let control: React.ReactNode;
  if (schema.format === "workflow-id") {
    control = <WorkflowPicker id={id} value={shown} onChange={onChange} />;
  } else if (schema.enum) {
    control = (
      <select id={id} className="nf-input" value={String(shown ?? "")} onChange={(e) => onChange(e.target.value || undefined)}>
        {(!required || schema.default === undefined) && <option value="">（未设置）</option>}
        {schema.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === "boolean" && schema.default === undefined) {
    // No default: "not set" must be distinguishable from false, so the API's own default applies.
    control = (
      <select
        id={id}
        className="nf-input"
        value={shown === undefined ? "" : String(shown)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}
      >
        <option value="">（未设置）</option>
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  } else if (schema.type === "boolean") {
    control = (
      <input id={id} type="checkbox" className="nf-check" checked={!!shown} onChange={(e) => onChange(e.target.checked)} />
    );
  } else if (schema.type === "number" || schema.type === "integer") {
    control = <NumberInput id={id} value={shown} integer={schema.type === "integer"} onChange={onChange} />;
  } else if (schema.type === "string") {
    const long = name === "code" || (typeof shown === "string" && (shown.length > 60 || shown.includes("\n")));
    // An emptied field means "not set" (the default applies / the field is left out of requests).
    const set = (v: string) => onChange(v === "" ? undefined : v);
    control = long ? (
      <textarea id={id} className="nf-input nf-code" rows={6} spellCheck={false} value={String(shown ?? "")} onChange={(e) => set(e.target.value)} />
    ) : (
      <input id={id} className="nf-input" value={String(shown ?? "")} placeholder={schema.default === undefined ? "未设置" : undefined} onChange={(e) => set(e.target.value)} />
    );
  } else {
    control = <JsonInput id={id} value={shown} onChange={onChange} />;
  }

  return (
    <div className="nf-field" data-default={isDefault || undefined}>
      {label}
      {control}
      {help}
    </div>
  );
}

function NumberInput({ id, value, integer, onChange }: { id: string; value: unknown; integer: boolean; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  return (
    <input
      id={id}
      className="nf-input"
      inputMode={integer ? "numeric" : "decimal"}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim();
        // Allow templates like {{inputs.n}} as well as numbers.
        if (t === "") onChange(undefined);
        else if (!Number.isNaN(Number(t))) onChange(Number(t));
        else if (t.startsWith("{{")) onChange(t);
      }}
    />
  );
}

function JsonInput({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const fmt = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));
  const [text, setText] = useState(fmt(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(fmt(value));
    setError(null);
  }, [value]);
  return (
    <>
      <textarea
        id={id}
        className="nf-input nf-code"
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        spellCheck={false}
        value={text}
        aria-invalid={!!error}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() === "") return onChange(undefined);
          try {
            onChange(JSON.parse(text));
            setError(null);
          } catch {
            setError("不是合法的 JSON，没有保存");
          }
        }}
      />
      {error && <small className="nf-field__error">{error}</small>}
    </>
  );
}

function WorkflowPicker({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const workflows = useStore((s) => s.workflows);
  const current = useStore((s) => s.workflow?.id);
  const openWorkflow = useStore((s) => s.openWorkflow);
  const v = typeof value === "string" ? value : "";
  return (
    <div className="nf-picker">
      <select id={id} className="nf-input" value={v} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">选择工作流</option>
        {workflows
          .filter((w) => w.id !== current)
          .map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}（{w.id}）
            </option>
          ))}
        {v && !workflows.some((w) => w.id === v) && <option value={v}>{v}（不存在）</option>}
      </select>
      {v && workflows.some((w) => w.id === v) && (
        <button type="button" className="nf-link" onClick={() => openWorkflow(v)}>
          打开
        </button>
      )}
    </div>
  );
}
