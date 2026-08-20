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
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillIdState] = useState("");
  const [selectedModelKey, setSelectedModelKeyState] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [theme, setTheme] = useState<"auto" | "light" | "dark">(initialTheme);
  const [notice, setNotice] = useState<string>("");
  const noticeTimer = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  const stopStreaming = useCallback((): void => {
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const loadRunDetail = useCallback(async (runId: string): Promise<RunDetail> => {
    const [run, events, detail, artifacts] = await Promise.all([
      api.run(token, runId),
      api.runEvents(token, runId),
      api.runPlan(token, runId),
      api.runArtifacts(token, runId),
    ]);
    const next = {
      run: run.run,
      detail,
      events: events.events,
      artifacts: artifacts.artifacts,
    };
    setCurrentRun(next);
    return next;
  }, [token]);

  const loadConversations = useCallback(async (): Promise<void> => {
    try {
      const body = await api.conversations(token);
      setConversations([...body.conversations]);
    } catch {
      // ignore
    }
  }, [token]);

  const handleEvent = useCallback((event: RunEvent): void => {
    setCurrentRun((previous) => {
      if (previous === null) return previous;
      const list = [...previous.events];
      if (!list.some((e) => e.seq === event.seq)) {
        list.push(event);
        list.sort((a, b) => a.seq - b.seq);
      }
      return { ...previous, events: list };
    });
  }, []);

  const finalizeRun = useCallback(
    async (runId: string): Promise<void> => {
      setRunning(false);
      setActiveRunId(null);
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
    [token, loadConversations, loadRunDetail, note],
  );

  const subscribeRun = useCallback(
    (runId: string): void => {
      stopStreaming();
      const controller = new AbortController();
      abortRef.current = controller;
      subscribeRunEvents(
        token,
        runId,
        handleEvent,
        () => {
          void finalizeRun(runId);
        },
        (message) => {
          setRunning(false);
          note(message);
        },
        controller.signal,
      );
    },
    [token, handleEvent, finalizeRun, stopStreaming, note],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (token === "") throw new Error("not authenticated");
    const me = await api.me(token);
    const [skillBody, toolBody, providerBody, conversationBody] = await Promise.all([
      api.skills(token),
      api.tools(token),
      api.providers(token),
      api.conversations(token),
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
    async (input: string): Promise<void> => {
      stopStreaming();
      setRunning(true);
      const conversationId = conversation?.conversation.id;
      let run: RunRecord;
      try {
        const body = await api.startRun(token, input, {
          ...(selectedModelKey === "" ? {} : { modelKey: selectedModelKey }),
          ...(conversationId === undefined ? {} : { conversationId }),
        });
        run = body.run;
      } catch (error) {
        setRunning(false);
        note(error instanceof Error ? error.message : "启动任务失败");
        return;
      }
      if (conversation === null) {
        setConversation({
          conversation: {
            id: run.conversationId ?? "",
            title: truncate(input, 60),
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
            createdAt: run.createdAt,
            updatedAt: run.createdAt,
            runCount: 1,
            lastStatus: run.status,
          },
          ...previous,
        ]);
      } else {
        setConversation((previous) => (previous === null ? previous : { ...previous, runs: [...previous.runs, run] }));
      }
      setActiveRunId(run.id);
      if (run.modelKey !== undefined) setSelectedModelKeyState(run.modelKey);
      setCurrentRun({ run, detail: emptyDetail(), events: [], artifacts: [] });
      subscribeRun(run.id);
    },
    [token, selectedModelKey, conversation, subscribeRun, stopStreaming, note],
  );

  const openConversation = useCallback(
    async (id: string): Promise<void> => {
      stopStreaming();
      setRunning(false);
      setActiveRunId(null);
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
      if (latest) {
        await loadRunDetail(latest.id);
      } else {
        setCurrentRun(null);
      }
      if (latest && latest.status === "running") {
        setRunning(true);
        setActiveRunId(latest.id);
        subscribeRun(latest.id);
      }
    },
    [token, loadRunDetail, subscribeRun, stopStreaming, note],
  );

  const deleteConversation = useCallback(
    async (id: string, title: string): Promise<void> => {
      if (!window.confirm(`删除会话“${title}”？该会话的运行记录、计划与评估也会被删除。`)) return;
      await api.deleteConversation(token, id);
      setConversations((previous) => previous.filter((c) => c.id !== id));
      if (conversation?.conversation.id === id) {
        stopStreaming();
        setConversation(null);
        setCurrentRun(null);
        setActiveRunId(null);
        setRunning(false);
        setShowDetails(false);
      }
      note("会话已删除");
    },
    [token, conversation, stopStreaming, note],
  );

  const selectRun = useCallback(
    async (runId: string): Promise<void> => {
      if (activeRunId === runId) return;
      stopStreaming();
      setRunning(false);
      setActiveRunId(null);
      try {
        await loadRunDetail(runId);
      } catch (error) {
        note(error instanceof Error ? error.message : "载入详情失败");
        return;
      }
      if (currentRun?.run.status === "running") {
        // not reached: currentRun updated asynchronously by loadRunDetail
      }
      const latestRun = conversation?.runs.find((r) => r.id === runId);
      if (latestRun?.status === "running") {
        setRunning(true);
        setActiveRunId(runId);
        subscribeRun(runId);
      }
    },
    [activeRunId, stopStreaming, loadRunDetail, currentRun, conversation, subscribeRun, note],
  );

  const newChat = useCallback((): void => {
    stopStreaming();
    setConversation(null);
    setCurrentRun(null);
    setActiveRunId(null);
    setRunning(false);
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
    setActiveRunId(null);
    setRunning(false);
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
      openConversation,
      deleteConversation,
      selectRun,
      newChat,
      toggleDetails,
      toggleTheme,
      setSelectedSkill,
      setSelectedModel,
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
      openConversation,
      deleteConversation,
      selectRun,
      newChat,
      toggleDetails,
      toggleTheme,
      setSelectedSkill,
      setSelectedModel,
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
      running,
      activeRunId,
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
      running,
      activeRunId,
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
