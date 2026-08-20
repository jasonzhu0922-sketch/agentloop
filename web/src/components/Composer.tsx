import { useEffect, useRef, useState } from "react";
import { useAgentLoop } from "../state/context";

function Thinking(): React.ReactNode {
  return (
    <span className="thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

export function Composer(): React.ReactNode {
  const { state, actions } = useAgentLoop();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) {
        setDraft(detail);
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          autoGrow(ta);
        }
      }
    };
    window.addEventListener("agentloop:suggest", handler);
    return () => window.removeEventListener("agentloop:suggest", handler);
  }, []);

  const inConv = state.conversation !== null;
  const canSend = !state.running && state.models.length > 0;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const input = draft.trim();
    if (!input) {
      actions.note("请输入任务内容");
      return;
    }
    setDraft("");
    void actions.startRun(input);
  };

  const autoGrow = (ta: HTMLTextAreaElement): void => {
    ta.style.height = "auto";
    ta.style.height = Math.min(220, ta.scrollHeight) + "px";
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-box">
        {state.running ? (
          <div className="composer-busy">
            <Thinking /> 正在处理…
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          id="input"
          className="composer-input"
          rows={1}
          value={draft}
          disabled={state.running}
          placeholder={inConv ? "继续输入指令，例如：把上面的结果再精简一些" : "输入你的任务…"}
          onChange={(e) => {
            setDraft(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!state.running) (e.target as HTMLFormElement).form?.requestSubmit();
            }
          }}
        />
        <div className="composer-tools">
          <div className="composer-bar">
            <label className="chip">
              模型
              <select
                id="model-select"
                value={state.selectedModelKey || state.defaultModelKey}
                disabled={state.running}
                onChange={(e) => actions.setSelectedModel(e.target.value)}
              >
                {state.models.length > 0
                  ? state.models.map((model) => (
                      <option key={model.key} value={model.key}>
                        {model.displayName || model.key}
                      </option>
                    ))
                  : <option value="">未配置模型</option>}
              </select>
            </label>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            <span className="composer-spacer" />
            <button type="submit" className="send-btn" disabled={!canSend} aria-label="发送">
              ↑
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
