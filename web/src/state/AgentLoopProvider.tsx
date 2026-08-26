import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, clearToken, loadToken, saveToken } from "../lib/api";
import { subscribeRunEvents } from "../lib/sse";
import { truncate } from "../lib/format";
import { mergeRunIntoConversation } from "./run-state";
import type {
  ConversationDetail,
  ConversationSummary,
  ModelSummary,
  PlanDetail,
  ProviderSummary,
  RunDetail,
  RunEvent,
  RunRecord,
  SkillSummary,
} from "../lib/types";
import { AgentLoopContext, type AppState } from "./context";

const THEME_KEY = "agentloop-theme";

function emptyDetail(): PlanDetail {
  return {
    state: "pending",
    plan: { id: "", runId: "", version: 0, status: "pending", goal: "", steps: [] },
    assessments: [],
  };
}

function initialTheme(): "auto" | "light" | "dark" {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  return "auto";
}

export function AgentLoopProvider({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  const [token, setTokenState] = useState<string>(() => loadToken());
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [providers, setProviders] = useState<readonly ProviderSummary[]>([]);
  const [models, setModels] = useState<readonly ModelSummary[]>([]);
  const [defaultProviderKey, setDefaultProviderKey] = useState("");
  const [defaultModelKey, setDefaultModelKey] = useState("");
  const [conversations, setConversations] = useState<readonly ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [currentRun, setCurrentRun] = useState<RunDetail | null>(null);
  const [runDetailsById, setRunDetailsById] = useState<Readonly<Record<string, RunDetail>>>({});
  const [activeRunIds, setActiveRunIds] = useState<readonly string[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const running = activeRunIds.length > 0;
  const [selectedSkillId, setSelectedSkillIdState] = useState("");
  const [selectedModelKey, setSelectedModelKeyState] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [theme, setTheme] = useState<"auto" | "light" | "dark">(initialTheme);
  const [notice, setNotice] = useState<string>("");
  const noticeTimer = useRef<number | null>(null);
  const abortRef = useRef<Map<string, AbortController>>(new Map());

  const note = useCallback((message: string): void => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 4200);
  }, []);

  const applyTheme = useCallback((mode: "auto" | "light" | "dark"): void => {
    const resolved =
      mode === "auto" && window.matchMedia ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
    document.documentElement.setAttribute("data-theme", resolved);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme, applyTheme]);

  const stopStreaming = useCallback((runId?: string): void => {
    if (runId !== undefined) {
      const controller = abortRef.current.get(runId);
      if (controller !== undefined) {
        controller.abort();
        abortRef.current.delete(runId);
      }
      return;
    }
    for (const controller of abortRef.current.values()) controller.abort();
    abortRef.current.clear();
  }, []);

  const rememberRunDetail = useCallback((detail: RunDetail): void => {
    setRunDetailsById((previous) => ({ ...previous, [detail.run.id]: detail }));
  }, []);

  const addActiveRun = useCallback((runId: string): void => {
    setActiveRunIds((previous) => previous.includes(runId) ? previous : [...previous, runId]);
    setActiveRunId(runId);
  }, []);

  const removeActiveRun = useCallback((runId: string): void => {
    setActiveRunIds((previous) => {
      const next = previous.filter((id) => id !== runId);
      setActiveRunId((current) => current === runId ? (next[next.length - 1] ?? null) : current);
      return next;
    });
  }, []);

  const fetchRunDetail = useCallback(async (runId: string): Promise<RunDetail> => {
    const [run, events, detail, artifacts] = await Promise.all([
      api.run(token, runId),
      api.runEvents(token, runId),
      api.runPlan(token, runId),
      api.runArtifacts(token, runId),
    ]);
    return {
      run: run.run,
      detail,
      events: events.events,
      artifacts: artifacts.artifacts,
    };
  }, [token]);

  const loadRunDetail = useCallback(async (runId: string): Promise<RunDetail> => {
    const next = await fetchRunDetail(runId);
    setCurrentRun(next);
    rememberRunDetail(next);
    return next;
  }, [fetchRunDetail, rememberRunDetail]);

  const loadConversations = useCallback(async (): Promise<void> => {
    try {
      const body = await api.conversations(token);
      setConversations([...body.conversations]);
    } catch {
      // ignore
    }
  }, [token]);

  const handleEvent = useCallback((runId: string, event: RunEvent): void => {
    const mergeEvent = (previous: RunDetail): RunDetail => {
      const list = [...previous.events];
      if (!list.some((e) => e.seq === event.seq)) {
        list.push(event);
        list.sort((a, b) => a.seq - b.seq);
      }
      return { ...previous, events: list };
    };
    setRunDetailsById((previous) => {
      const detail = previous[runId];
      if (detail === undefined) return previous;
      return { ...previous, [runId]: mergeEvent(detail) };
    });
    setCurrentRun((previous) => {
      if (previous === null || previous.run.id !== runId) return previous;
      return mergeEvent(previous);
    });
  }, []);

  const finalizeRun = useCallback(
    async (runId: string): Promise<void> => {
      removeActiveRun(runId);
      stopStreaming(runId);
      try {
        const detail = await loadRunDetail(runId);
        setConversation((previous) => mergeRunIntoConversation(previous, detail.run));
        if (detail.run.conversationId !== undefined) {
          try {
            const body = await api.conversation(token, detail.run.conversationId);
            setConversation((previous) => (
              previous?.conversation.id === body.conversation.id ? { ...body, runs: body.runs } : previous
            ));
          } catch {
            // The run detail above already moved the selected conversation out of running state.
          }
        }
        await loadConversations();
        note("本轮已完成，可继续输入下一条指令。");
      } catch (error) {
        note(error instanceof Error ? error.message : "刷新任务终态失败");
      }
    },
    [token, loadConversations, loadRunDetail, note, removeActiveRun, stopStreaming],
  );

  const subscribeRun = useCallback(
    (runId: string): void => {
      if (abortRef.current.has(runId)) return;
      const controller = new AbortController();
      abortRef.current.set(runId, controller);
      subscribeRunEvents(
        token,
        runId,
        (event) => handleEvent(runId, event),
        () => {
          void finalizeRun(runId);
        },
        (message) => {
          removeActiveRun(runId);
          abortRef.current.delete(runId);
          note(message);
        },
        controller.signal,
      );
    },
    [token, handleEvent, finalizeRun, note, removeActiveRun],
  );

  const refresh = useCallback(async (nextToken = token): Promise<void> => {
    if (nextToken === "") throw new Error("not authenticated");
    const me = await api.me(nextToken);
    const [skillBody, toolBody, providerBody, conversationBody] = await Promise.all([
      api.skills(nextToken),
      api.tools(nextToken),
      api.providers(nextToken),
      api.conversations(nextToken),
    ]);
    setUser(me.user);
    setSkills(skillBody.skills);
    setProviders(providerBody.providers);
    const modelList = providerBody.models ?? [];
    setModels(modelList);
    setDefaultProviderKey(providerBody.defaultProviderKey ?? "");
    setDefaultModelKey(providerBody.defaultModelKey ?? "");
    setConversations([...conversationBody.conversations]);
    void toolBody;
    setSelectedSkillIdState((previous) =>
      skillBody.skills.some((s) => s.id === previous) ? previous : (skillBody.skills[0]?.id ?? ""),
    );
    setSelectedModelKeyState((previous) =>
      modelList.some((model) => model.key === previous)
        ? previous
        : (providerBody.defaultModelKey ?? modelList[0]?.key ?? ""),
    );
  }, [token]);

  const startRun = useCallback(
    async (input: string, visibleDirectories: readonly string[] = [], sourceIds: readonly string[] = []): Promise<void> => {
      const conversationId = conversation?.conversation.id;
      const nextVisibleDirectories = mergeDirectoryPaths(
        conversation?.conversation.visibleDirectories ?? [],
        visibleDirectories,
      );
      let run: RunRecord;
      try {
        const body = await api.startRun(token, input, {
          ...(selectedModelKey === "" ? {} : { modelKey: selectedModelKey }),
          ...(visibleDirectories.length === 0 ? {} : { visibleDirectories }),
          ...(sourceIds.length === 0 ? {} : { sourceIds }),
          ...(conversationId === undefined ? {} : { conversationId }),
        });
        run = body.run;
      } catch (error) {
        note(error instanceof Error ? error.message : "启动任务失败");
        return;
      }
      if (conversation === null) {
        setConversation({
          conversation: {
            id: run.conversationId ?? "",
            title: truncate(input, 60),
            visibleDirectories: nextVisibleDirectories,
            createdAt: run.createdAt,
            updatedAt: run.createdAt,
            runCount: 1,
            lastStatus: run.status,
          },
          runs: [run],
        });
        setConversations((previous) => [
          {
            id: run.conversationId ?? "",
            title: truncate(input, 60),
            visibleDirectories: nextVisibleDirectories,
            createdAt: run.createdAt,
            updatedAt: run.createdAt,
            runCount: 1,
            lastStatus: run.status,
          },
          ...previous,
        ]);
      } else {
        setConversation((previous) => (previous === null ? previous : {
          ...previous,
          conversation: { ...previous.conversation, visibleDirectories: nextVisibleDirectories },
          runs: [...previous.runs, run],
        }));
      }
      if (run.modelKey !== undefined) setSelectedModelKeyState(run.modelKey);
      const detail = { run, detail: emptyDetail(), events: [], artifacts: [] };
      setCurrentRun(detail);
      rememberRunDetail(detail);
      addActiveRun(run.id);
      subscribeRun(run.id);
    },
    [token, selectedModelKey, conversation, subscribeRun, note, rememberRunDetail, addActiveRun],
  );

  const cancelRun = useCallback(async (): Promise<void> => {
    const runId = activeRunId ?? activeRunIds[activeRunIds.length - 1] ?? null;
    if (runId === null) return;
    try {
      const body = await api.cancelRun(token, runId);
      setConversation((previous) => mergeRunIntoConversation(previous, body.run));
      if (body.run.status !== "running") {
        removeActiveRun(runId);
        stopStreaming(runId);
        await loadRunDetail(runId);
        await loadConversations();
        note("任务已停止。");
      } else {
        note("已请求停止当前任务。");
      }
    } catch (error) {
      note(error instanceof Error ? error.message : "停止任务失败");
    }
  }, [token, activeRunId, activeRunIds, loadRunDetail, loadConversations, note, removeActiveRun, stopStreaming]);

  const updateConversationVisibleDirectories = useCallback(
    async (visibleDirectories: readonly string[]): Promise<void> => {
      const conversationId = conversation?.conversation.id;
      if (conversationId === undefined) return;
      try {
        const body = await api.updateConversationVisibleDirectories(token, conversationId, visibleDirectories);
        setConversation((previous) => (
          previous?.conversation.id === body.conversation.id
            ? { ...previous, conversation: body.conversation }
            : previous
        ));
        setConversations((previous) => previous.map((item) =>
          item.id === body.conversation.id ? body.conversation : item
        ));
      } catch (error) {
        note(error instanceof Error ? error.message : "更新会话目录失败");
      }
    },
    [token, conversation, note],
  );

  const openConversation = useCallback(
    async (id: string): Promise<void> => {
      stopStreaming();
      setActiveRunId(null);
      setActiveRunIds([]);
      setRunDetailsById({});
      let body: ConversationDetail;
      try {
        body = await api.conversation(token, id);
      } catch (error) {
        note(error instanceof Error ? error.message : "载入对话失败");
        return;
      }
      setConversation(body);
      const latest = body.runs[body.runs.length - 1];
      if (latest?.modelKey !== undefined) setSelectedModelKeyState(latest.modelKey);
      const runningRuns = body.runs.filter((run) => run.status === "running");
      if (latest) {
        const latestDetail = await fetchRunDetail(latest.id);
        const otherRunningIds = runningRuns.map((run) => run.id).filter((runId) => runId !== latest.id);
        const runningDetails = await Promise.all(otherRunningIds.map((runId) => fetchRunDetail(runId)));
        const details = [latestDetail, ...runningDetails];
        setRunDetailsById(Object.fromEntries(details.map((detail) => [detail.run.id, detail])));
        setCurrentRun(latestDetail);
      } else {
        setCurrentRun(null);
      }
      if (runningRuns.length > 0) {
        setActiveRunIds(runningRuns.map((run) => run.id));
        setActiveRunId(runningRuns[runningRuns.length - 1]?.id ?? null);
        for (const run of runningRuns) subscribeRun(run.id);
      }
    },
    [token, fetchRunDetail, subscribeRun, stopStreaming, note],
  );

  const deleteConversation = useCallback(
    async (id: string, title: string): Promise<void> => {
      if (!window.confirm(`删除会话“${title}”？该会话的运行记录、计划与评估也会被删除。`)) return;
      try {
        await api.deleteConversation(token, id);
      } catch (error) {
        note(error instanceof Error ? error.message : "删除会话失败");
        return;
      }
      setConversations((previous) => previous.filter((c) => c.id !== id));
      if (conversation?.conversation.id === id) {
        stopStreaming();
        setConversation(null);
        setCurrentRun(null);
        setRunDetailsById({});
        setActiveRunId(null);
        setActiveRunIds([]);
        setShowDetails(false);
      }
      note("会话已删除");
    },
    [token, conversation, stopStreaming, note],
  );

  const selectRun = useCallback(
    async (runId: string): Promise<void> => {
      if (currentRun?.run.id === runId) return;
      try {
        const detail = await loadRunDetail(runId);
        if (detail.run.status === "running") {
          addActiveRun(runId);
          subscribeRun(runId);
        } else {
          removeActiveRun(runId);
          stopStreaming(runId);
        }
      } catch (error) {
        note(error instanceof Error ? error.message : "载入详情失败");
        return;
      }
    },
    [currentRun, loadRunDetail, addActiveRun, subscribeRun, removeActiveRun, stopStreaming, note],
  );

  const newChat = useCallback((): void => {
    stopStreaming();
    setConversation(null);
    setCurrentRun(null);
    setRunDetailsById({});
    setActiveRunId(null);
    setActiveRunIds([]);
    setShowDetails(false);
  }, [stopStreaming]);

  const logout = useCallback(async (): Promise<void> => {
    stopStreaming();
    try {
      await api.logout(token);
    } catch {
      // ignore
    }
    clearToken();
    setTokenState("");
    setUser(null);
    setConversation(null);
    setCurrentRun(null);
    setRunDetailsById({});
    setActiveRunId(null);
    setActiveRunIds([]);
  }, [token, stopStreaming]);

  const setToken = useCallback((next: string): void => {
    saveToken(next);
    setTokenState(next);
  }, []);

  const toggleDetails = useCallback((): void => setShowDetails((v) => !v), []);
  const toggleTheme = useCallback((): void => {
    setTheme((previous) => {
      const next = previous === "dark" ? "light" : previous === "light" ? "auto" : "dark";
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);
  const setSelectedSkill = useCallback((id: string): void => setSelectedSkillIdState(id), []);
  const setSelectedModel = useCallback((key: string): void => {
    if (!models.some((model) => model.key === key)) return;
    setSelectedModelKeyState(key);
  }, [models]);

  const actions = useMemo(
    () => ({
      setToken,
      logout,
      startRun,
      cancelRun,
      openConversation,
      deleteConversation,
      selectRun,
      newChat,
      toggleDetails,
      toggleTheme,
      setSelectedSkill,
      setSelectedModel,
      updateConversationVisibleDirectories,
      note,
      refresh,
      loadRunDetail,
      handleEvent,
      finalizeRun,
      subscribeRun,
      stopStreaming,
    }),
    [
      setToken,
      logout,
      startRun,
      cancelRun,
      openConversation,
      deleteConversation,
      selectRun,
      newChat,
      toggleDetails,
      toggleTheme,
      setSelectedSkill,
      setSelectedModel,
      updateConversationVisibleDirectories,
      note,
      refresh,
      loadRunDetail,
      handleEvent,
      finalizeRun,
      subscribeRun,
      stopStreaming,
    ],
  );

  const state: AppState = useMemo(
    () => ({
      token,
      user,
      skills,
      providers,
      models,
      defaultProviderKey,
      defaultModelKey,
      conversations,
      conversation,
      currentRun,
      runDetailsById,
      running,
      activeRunId,
      activeRunIds,
      selectedSkillId,
      selectedModelKey,
      showDetails,
      theme,
    }),
    [
      token,
      user,
      skills,
      providers,
      models,
      defaultProviderKey,
      defaultModelKey,
      conversations,
      conversation,
      currentRun,
      runDetailsById,
      running,
      activeRunId,
      activeRunIds,
      selectedSkillId,
      selectedModelKey,
      showDetails,
      theme,
    ],
  );

  return (
    <AgentLoopContext.Provider
      value={{
        state,
        actions,
        currentRun: currentRun?.run ?? null,
        runEvents: currentRun?.events ?? [],
      }}
    >
      {children}
      <Notice message={notice} />
    </AgentLoopContext.Provider>
  );
}

function Notice({ message }: { readonly message: string }): React.ReactNode {
  if (message === "") return null;
  return (
    <div id="notice" className="show" role="status" aria-live="polite">
      {message}
    </div>
  );
}

function mergeDirectoryPaths(
  existingDirectories: readonly string[],
  addedDirectories: readonly string[],
): readonly string[] {
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

function trimTrailingSeparator(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path;
  if (/^\/+$/.test(path)) return "/";
  if (/^\\\\[^\\/]+[\\/]?[^\\/]+[\\/]?$/.test(path)) return path.replace(/[\\/]$/, "");
  return path.replace(/[\\/]+$/, "");
}

function directoryKey(path: string): string {
  const normalized = trimTrailingSeparator(path);
  if (/^[A-Za-z]:[\\/]/.test(normalized) || /^\\\\/.test(normalized)) {
    return normalized.replace(/\//g, "\\").toLowerCase();
  }
  return normalized;
}
