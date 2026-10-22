import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useState } from "react";
import { subscribe } from "./api.ts";
import { Canvas } from "./Canvas.tsx";
import { Gallery } from "./Gallery.tsx";
import { Inspector } from "./Inspector.tsx";
import { Lightbox } from "./Lightbox.tsx";
import { NodeTypeEditor } from "./NodeTypeEditor.tsx";
import { Palette } from "./Palette.tsx";
import { RunDrawer } from "./RunDrawer.tsx";
import { useStore } from "./store.ts";
import { TopBar } from "./TopBar.tsx";
import { t } from "./i18n.ts";

export function App() {
  const auth = useStore((s) => s.auth);
  const workflowId = useStore((s) => s.workflow?.id);
  const notice = useStore((s) => s.notice);
  const view = useStore((s) => s.view);

  useEffect(() => {
    useStore.getState().init();
  }, []);

  useEffect(() => {
    if (auth !== "ok") return;
    let everConnected = false;
    let lastConnected = false;
    return subscribe(
      (e) => useStore.getState().handleEvent(e),
      (connected) => {
        useStore.setState({ connected });
        // After a reconnect (not the first connect), resync anything we may have missed.
        const wf = useStore.getState().workflow;
        if (connected && everConnected && !lastConnected && wf) useStore.getState().openWorkflow(wf.id);
        everConnected ||= connected;
        lastConnected = connected;
      },
    );
  }, [auth]);

  if (auth === "checking") return <div className="nf-splash">{t("正在连接 naturoflow…")}</div>;
  if (auth === "needed") return <AuthScreen />;

  return (
    <ReactFlowProvider>
      <div className="nf-app" data-view={view}>
        <TopBar />
        {view === "gallery" ? (
          <Gallery />
        ) : (
          <>
            <Palette />
            <main className="nf-canvas">
              <Canvas key={workflowId ?? "none"} />
            </main>
            <Inspector />
            <RunDrawer />
          </>
        )}
      </div>
      <NodeTypeEditor />
      <Lightbox />
      {notice && (
        <div className="nf-toast" data-kind={notice.kind} role="status">
          {notice.text}
        </div>
      )}
    </ReactFlowProvider>
  );
}

function AuthScreen() {
  const [token, setToken] = useState("");
  return (
    <div className="nf-splash">
      <form
        className="nf-auth"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) location.href = `/auth?token=${encodeURIComponent(token.trim())}`;
        }}
      >
        <h1>{t("打开 naturoflow 需要访问令牌")}</h1>
        <p>
          
          {t("在终端运行")} <code>pnpm nf serve</code>{t("，打开它打印的链接即可自动登录。令牌也保存在")}{" "}
          <code>~/.naturoflow/server.json</code>  {t("里，可以粘贴到下面。")}
        </p>
        <input className="nf-input" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("访问令牌")} aria-label={t("访问令牌")} />
        <button className="nf-btn nf-btn--primary" type="submit">
          
          {t("登录")}
        </button>
      </form>
    </div>
  );
}
