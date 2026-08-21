import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { LocalDirectoryListing } from "../lib/types";
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

function FolderIcon(): React.ReactNode {
  return (
    <span className="folder-icon" aria-hidden="true">
      <span />
    </span>
  );
}

export function Composer(): React.ReactNode {
  const { state, actions } = useAgentLoop();
  const [draft, setDraft] = useState("");
  const [visibleDirectories, setVisibleDirectories] = useState<readonly string[]>([]);
  const [directoryModalOpen, setDirectoryModalOpen] = useState(false);
  const [directoryListing, setDirectoryListing] = useState<LocalDirectoryListing | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationDirectoryFingerprint = state.conversation?.conversation.visibleDirectories.join("\n") ?? "";

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

  useEffect(() => {
    setVisibleDirectories(state.conversation?.conversation.visibleDirectories ?? []);
  }, [state.conversation?.conversation.id, conversationDirectoryFingerprint]);

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
    void actions.startRun(input, visibleDirectories);
  };

  const autoGrow = (ta: HTMLTextAreaElement): void => {
    ta.style.height = "auto";
    ta.style.height = Math.min(220, ta.scrollHeight) + "px";
  };

  const addVisibleDirectories = (paths: readonly string[]): void => {
    const normalized = paths.map(normalizeDirectoryInputPath).filter(Boolean);
    if (normalized.length === 0) return;
    const next = mergeDirectoryPaths(visibleDirectories, normalized).slice(0, 12);
    if (state.conversation !== null) {
      void actions.updateConversationVisibleDirectories(next);
    } else {
      setVisibleDirectories(next);
    }
  };

  const removeVisibleDirectory = (path: string): void => {
    const next = visibleDirectories.filter((item) => directoryKey(item) !== directoryKey(path));
    if (state.conversation !== null) {
      void actions.updateConversationVisibleDirectories(next);
    } else {
      setVisibleDirectories(next);
    }
  };

  const selectVisibleDirectory = (): void => {
    if (directoryListing === null) return;
    addVisibleDirectories([directoryListing.currentPath]);
    setDirectoryModalOpen(false);
  };

  const addVisibleDirectoryScope = (): void => {
    setDirectoryModalOpen(true);
    void loadDirectory();
  };

  const loadDirectory = async (path?: string): Promise<void> => {
    setDirectoryLoading(true);
    setDirectoryError("");
    try {
      setDirectoryListing(await api.localDirectories(state.token, path));
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "目录不可访问");
    } finally {
      setDirectoryLoading(false);
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-box">
        {state.running ? (
          <div className="composer-busy">
            <Thinking /> 正在处理…
          </div>
        ) : null}
        {visibleDirectories.length > 0 ? (
          <div className="visible-dir-row" aria-label="本次可见目录">
            {visibleDirectories.map((path) => (
              <span className="visible-dir-chip" key={directoryKey(path)} title={path}>
                <FolderIcon />
                <span>{directoryLabel(path)}</span>
                <button
                  type="button"
                  aria-label={`移除 ${directoryLabel(path)}`}
                  disabled={state.running}
                  onClick={() => removeVisibleDirectory(path)}
                >
                  ×
                </button>
              </span>
            ))}
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
            <button
              type="button"
              className="dir-picker-btn"
              disabled={state.running}
              title="添加本地可见目录"
              aria-label="添加本地可见目录"
              onClick={addVisibleDirectoryScope}
            >
              <FolderIcon />
              <span>添加目录</span>
            </button>
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
            {state.running ? (
              <button
                type="button"
                className="stop-btn"
                title="停止当前任务"
                aria-label="停止当前任务"
                onClick={() => void actions.cancelRun()}
              >
                ■
              </button>
            ) : (
              <button type="submit" className="send-btn" disabled={!canSend} aria-label="发送">
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
      {directoryModalOpen ? (
        <div
          className="directory-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDirectoryModalOpen(false);
          }}
        >
          <div
            className="directory-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="directory-modal-title"
          >
            <div className="directory-modal-head">
              <strong id="directory-modal-title">选择目录</strong>
              <button
                type="button"
                className="directory-modal-close"
                aria-label="关闭"
                onClick={() => setDirectoryModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="directory-current-path" title={directoryListing?.currentPath ?? ""}>
              {directoryListing?.currentPath ?? "载入中…"}
            </div>
            {directoryError !== "" ? <div className="directory-error">{directoryError}</div> : null}
            <div className="directory-list" role="listbox" aria-label="目录列表">
              {directoryListing?.parentPath !== undefined ? (
                <button
                  type="button"
                  className="directory-row"
                  onClick={() => void loadDirectory(directoryListing.parentPath)}
                >
                  <span aria-hidden="true">↥</span>
                  <span>上级目录</span>
                </button>
              ) : null}
              {directoryLoading ? <div className="directory-empty">载入中…</div> : null}
              {!directoryLoading && directoryListing?.entries.length === 0 ? (
                <div className="directory-empty">没有可进入目录</div>
              ) : null}
              {!directoryLoading && directoryListing?.entries.map((entry) => (
                <button
                  type="button"
                  className="directory-row"
                  key={entry.path}
                  onClick={() => void loadDirectory(entry.path)}
                >
                  <FolderIcon />
                  <span>{entry.name}</span>
                </button>
              ))}
            </div>
            <div className="directory-modal-actions">
              <button type="button" className="directory-modal-cancel" onClick={() => setDirectoryModalOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="directory-modal-add"
                disabled={directoryListing === null}
                onClick={selectVisibleDirectory}
              >
                选择当前目录
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}

function normalizeDirectoryInputPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function trimTrailingSeparator(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path;
  if (/^\/+$/.test(path)) return "/";
  if (/^\\\\[^\\/]+[\\/]?[^\\/]+[\\/]?$/.test(path)) return path.replace(/[\\/]$/, "");
  return path.replace(/[\\/]+$/, "");
}

function mergeDirectoryPaths(existingDirectories: readonly string[], addedDirectories: readonly string[]): string[] {
  const seen = new Set(existingDirectories.map(directoryKey));
  const next = [...existingDirectories];
  for (const path of addedDirectories) {
    const key = directoryKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(path);
  }
  return next;
}

function directoryKey(path: string): string {
  const normalized = trimTrailingSeparator(path);
  if (/^[A-Za-z]:[\\/]/.test(normalized) || /^\\\\/.test(normalized)) {
    return normalized.replace(/\//g, "\\").toLowerCase();
  }
  return normalized;
}

function directoryLabel(path: string): string {
  const normalized = trimTrailingSeparator(path);
  if (/^[A-Za-z]:[\\/]?$/.test(normalized)) return normalized;
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}
