import { timeAgo } from "../lib/format";
import { useAgentLoop } from "../state/context";

export function Sidebar(): React.ReactNode {
  const { state, actions } = useAgentLoop();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">A</div>
        <div className="brand-text">
          <strong>AgentLoop</strong>
          <small>智能助手</small>
        </div>
      </div>
      <button type="button" className="new-chat" onClick={() => actions.newChat()}>
        + 新对话
      </button>
      <div className="sessions">
        {state.conversations.length === 0 ? (
          <div className="sessions-empty">还没有对话</div>
        ) : (
          <>
            {state.conversations.map((c) => {
              const active = state.conversation?.conversation.id === c.id;
              return (
                <div className="session-wrap" key={c.id}>
                  <button
                    type="button"
                    className={"session" + (active ? " active" : "")}
                    onClick={() => void actions.openConversation(c.id)}
                  >
                    <span className={"session-dot " + (c.lastStatus ?? "")} />
                    <span className="session-body">
                      <span className="session-title">{c.title}</span>
                      <span className="session-time">
                        {timeAgo(c.updatedAt)} · {c.runCount} 轮
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="session-delete"
                    aria-label="删除会话"
                    title="删除会话"
                    onClick={() => void actions.deleteConversation(c.id, c.title)}
                  >
                    &times;
                  </button>
                </div>
              );
            })}
            {state.conversationsHasMore ? (
              <button
                type="button"
                className="sessions-more"
                disabled={state.conversationsLoadingMore}
                onClick={() => void actions.loadMoreConversations()}
              >
                {state.conversationsLoadingMore ? "加载中…" : "查看更多"}
              </button>
            ) : null}
          </>
        )}
      </div>
      <div className="sidebar-foot">
        <div className="identity" title={state.user?.email}>
          {state.user?.email}
        </div>
        <div className="foot-actions">
          <button type="button" className="icon-btn" title="切换主题" onClick={() => actions.toggleTheme()}>
            {state.theme === "dark" ? "☀" : "◐"}
          </button>
          <button type="button" className="icon-btn" title="退出登录" onClick={() => void actions.logout()}>
            ⎋
          </button>
        </div>
      </div>
    </aside>
  );
}
