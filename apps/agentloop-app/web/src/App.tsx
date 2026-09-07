import { useEffect, useLayoutEffect, useRef } from "react";
import { AgentLoopProvider as ProviderImpl } from "./state/AgentLoopProvider";
import { useAgentLoop } from "./state/context";
import { AuthScreen } from "./components/AuthScreen";
import { Sidebar } from "./components/Sidebar";
import { ConversationView } from "./components/ConversationView";
import { Composer } from "./components/Composer";
import { ArtifactsPanel } from "./components/DetailsPanel";

function Shell(): React.ReactNode {
  const { state, actions } = useAgentLoop();
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const activeEventVersion = activeRunEventVersion(state.activeRunIds, state.runDetailsById);

  useEffect(() => {
    if (state.token !== "" && state.user === null) {
      void actions.refresh().catch(() => {
        actions.logout();
      });
    }
  }, [state.token, state.user, actions]);

  useLayoutEffect(() => {
    scrollToBottom(conversationScrollRef.current);
  }, [state.conversation?.runs.length, state.running, activeEventVersion]);

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
          </div>
        </header>
        <div className="main-grid">
          <section className="conversation">
            <div className="conversation-scroll" ref={conversationScrollRef}>
              <ConversationView />
            </div>
            <Composer />
          </section>
          <ArtifactsPanel />
        </div>
      </main>
    </div>
  );
}

/** A stream event changes the live card's height and must advance the actual scroll container. */
export function activeRunEventVersion(
  activeRunIds: readonly string[],
  runDetailsById: Readonly<Record<string, { readonly events: readonly { readonly seq: number }[] }>>,
): string {
  return activeRunIds.map((runId) => {
    const events = runDetailsById[runId]?.events ?? [];
    const last = events[events.length - 1];
    return `${runId}:${events.length}:${last?.seq ?? 0}`;
  }).join("|");
}

export function scrollToBottom(container: Pick<HTMLElement, "scrollHeight" | "scrollTop"> | null): void {
  if (container !== null) container.scrollTop = container.scrollHeight;
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
