import { useEffect } from "react";
import { AgentLoopProvider as ProviderImpl } from "./state/AgentLoopProvider";
import { useAgentLoop } from "./state/context";
import { AuthScreen } from "./components/AuthScreen";
import { Sidebar } from "./components/Sidebar";
import { ConversationView } from "./components/ConversationView";
import { Composer } from "./components/Composer";
import { DetailsPanel } from "./components/DetailsPanel";

function Shell(): React.ReactNode {
  const { state, actions } = useAgentLoop();

  useEffect(() => {
    if (state.token !== "" && state.user === null) {
      void actions.refresh().catch(() => {
        actions.logout();
      });
    }
  }, [state.token, state.user, actions]);

  if (state.token === "" || state.user === null) {
    return <AuthScreen />;
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main">
        <header className="topbar">
          <div className="crumb">
            会话 / <b>{state.conversation ? state.conversation.conversation.title : "新对话"}</b>
          </div>
          <div className="topbar-right">
            <span className="status-pill">
              <i className="status-dot" /> {modelLabel(state.models, state.selectedModelKey || state.defaultModelKey)}
            </span>
            <button type="button" className="chip-btn" onClick={() => actions.toggleDetails()}>
              {state.showDetails ? "收起详情" : "详情"}
            </button>
          </div>
        </header>
        <div className={"main-grid" + (state.showDetails ? " has-details" : "")}>
          <section className="conversation">
            <div className="conversation-scroll">
              <ConversationView />
            </div>
            <Composer />
          </section>
          {state.showDetails ? <DetailsPanel /> : null}
        </div>
      </main>
    </div>
  );
}

export function providerLabel(providers: readonly { key: string; defaultModel?: string }[], defaultKey: string): string {
  const p = providers.find((x) => x.key === defaultKey) ?? providers[0];
  return p ? (p.defaultModel || p.key) : "未配置模型";
}

export function modelLabel(models: readonly { key: string; displayName?: string }[], selectedKey: string): string {
  const model = models.find((item) => item.key === selectedKey) ?? models[0];
  return model ? (model.displayName || model.key) : "未配置模型";
}

export function App(): React.ReactNode {
  return (
    <ProviderImpl>
      <Shell />
    </ProviderImpl>
  );
}
