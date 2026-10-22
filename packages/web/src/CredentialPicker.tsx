import { useEffect, useState } from "react";
import { api, ApiError, type CredentialInfo, type CredentialSpec, type WorkflowNode } from "./api.ts";
import { useStore } from "./store.ts";

/**
 * Per-node credential choice for node types that declare `credentials`.
 * Users can save several credentials per type (e.g. key 1 / key 2) and switch between them.
 */
export function CredentialPicker({ node, spec, typeId }: { node: WorkflowNode; spec: CredentialSpec; typeId: string }) {
  const credType = spec.type ?? typeId;
  const credVersion = useStore((s) => s.credVersion);
  const patch = useStore((s) => s.patch);
  const notify = useStore((s) => s.notify);
  const [list, setList] = useState<CredentialInfo[] | null>(null);
  const [mode, setMode] = useState<"view" | "new" | "edit">("view");

  useEffect(() => {
    api.credentials(credType).then((l) => {
      setList(l);
      // Nothing saved yet: go straight to the form instead of making people hunt for a link.
      if (l.length === 0) setMode((m) => (m === "view" ? "new" : m));
    }).catch(() => setList([]));
  }, [credType, credVersion]);

  const selected = list?.find((c) => c.id === node.credential);
  const choose = (id: string | null) => patch([{ op: "update_node", id: node.id, credential: id }]);
  const title = spec.name ?? credType;

  return (
    <section className="nf-cred" aria-label="凭据">
      <div className="nf-field__label">
        <span>凭据：{title}</span>
        {spec.required && <em>必填</em>}
      </div>
      {list && list.length === 0 ? (
        <p className="nf-muted nf-cred__empty">还没有保存过 {title} 的凭据。填好下面的信息保存后，这个节点就会使用它。</p>
      ) : (
        <div className="nf-cred__row">
          <select
            className="nf-input"
            aria-label="选择凭据"
            value={node.credential ?? ""}
            onChange={(e) => choose(e.target.value || null)}
          >
            <option value="">{spec.required ? "请选择凭据" : "不使用凭据"}</option>
            {list?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {node.credential && list && !selected && <option value={node.credential}>（已删除的凭据）</option>}
          </select>
          {selected && mode === "view" && (
            <button type="button" className="nf-link" onClick={() => setMode("edit")}>
              管理
            </button>
          )}
        </div>
      )}
      {mode === "view" && (
        <button type="button" className="nf-btn nf-cred__add" onClick={() => setMode("new")}>
          新建凭据
        </button>
      )}
      {mode === "new" && (
        <CredentialForm
          spec={spec}
          onCancel={() => setMode("view")}
          onSave={async (name, data) => {
            const c = await api.createCredential(credType, name, data);
            await choose(c.id);
            notify("info", `已保存凭据“${c.name}”，并用在这个节点上`);
            setMode("view");
          }}
        />
      )}
      {mode === "edit" && selected && (
        <CredentialForm
          spec={spec}
          existing={selected}
          onCancel={() => setMode("view")}
          onSave={async (name, data) => {
            await api.updateCredential(selected.id, { name, data });
            notify("info", `已更新凭据“${name}”`);
            setMode("view");
          }}
          onDelete={async () => {
            const usage = await api.credentialUsage(selected.id);
            const others = usage.filter((u) => u.nodeId !== node.id || u.workflowId !== useStore.getState().workflow?.id).length;
            const msg = `删除凭据“${selected.name}”？${others ? `另外还有 ${others} 个节点在用它，它们会提示需要重新选择凭据。` : ""}`;
            if (!confirm(msg)) return;
            await api.deleteCredential(selected.id);
            notify("info", `已删除凭据“${selected.name}”`);
            setMode("view");
          }}
        />
      )}
    </section>
  );
}

function CredentialForm({
  spec,
  existing,
  onSave,
  onCancel,
  onDelete,
}: {
  spec: CredentialSpec;
  existing?: CredentialInfo;
  onSave: (name: string, data: Record<string, string>) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [data, setData] = useState<Record<string, string>>(() => ({ ...(existing?.values ?? {}) }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim(), data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="nf-cred__form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="nf-field">
        <span className="nf-field__label">名称</span>
        <input className="nf-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：key 1、公司账号" required autoFocus />
      </label>
      {Object.entries(spec.fields).map(([key, f]) => {
        const stored = existing?.fields.includes(key);
        return (
          <label key={key} className="nf-field">
            <span className="nf-field__label">
              <span>{f.label ?? key}</span>
              {f.required && !existing && <em>必填</em>}
            </span>
            <input
              className="nf-input nf-code"
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              value={data[key] ?? ""}
              placeholder={existing && f.secret && stored ? "已保存，留空则不修改" : ""}
              onChange={(e) => setData({ ...data, [key]: e.target.value })}
            />
            {f.description && <small className="nf-field__help">{f.description}</small>}
          </label>
        );
      })}
      <p className="nf-muted nf-cred__note">加密保存在本机，界面和 AI 都看不到明文，运行日志里会打码。</p>
      {error && <p className="nf-field__error">{error}</p>}
      <div className="nf-row">
        <button type="submit" className="nf-btn nf-btn--primary" disabled={busy || !name.trim()}>
          {existing ? "保存修改" : "保存凭据"}
        </button>
        <button type="button" className="nf-btn nf-btn--ghost" onClick={onCancel}>
          取消
        </button>
        {onDelete && (
          <button type="button" className="nf-btn nf-btn--ghost nf-cred__delete" onClick={onDelete}>
            删除
          </button>
        )}
      </div>
    </form>
  );
}
