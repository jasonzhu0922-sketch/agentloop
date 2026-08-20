import { createContext, useContext } from "react";
import type {
  ConversationDetail,
  ConversationSummary,
  ModelSummary,
  ProviderSummary,
  RunDetail,
  RunEvent,
  RunRecord,
  SkillSummary,
} from "../lib/types";

export interface AppState {
  readonly token: string;
  readonly user: { id: string; email: string } | null;
  readonly skills: readonly SkillSummary[];
  readonly providers: readonly ProviderSummary[];
  readonly models: readonly ModelSummary[];
  readonly defaultProviderKey: string;
  readonly defaultModelKey: string;
  readonly conversations: readonly ConversationSummary[];
  readonly conversation: ConversationDetail | null;
  readonly currentRun: RunDetail | null;
  readonly running: boolean;
  readonly activeRunId: string | null;
  readonly selectedSkillId: string;
  readonly selectedModelKey: string;
  readonly showDetails: boolean;
  readonly theme: "auto" | "light" | "dark";
}

export interface AppActions {
  setToken(token: string): void;
  logout(): Promise<void>;
  startRun(input: string): Promise<void>;
  openConversation(id: string): Promise<void>;
  deleteConversation(id: string, title: string): Promise<void>;
  selectRun(runId: string): Promise<void>;
  newChat(): void;
  toggleDetails(): void;
  toggleTheme(): void;
  setSelectedSkill(id: string): void;
  setSelectedModel(key: string): void;
  note(message: string): void;
  refresh(): Promise<void>;
  loadRunDetail(runId: string): Promise<RunDetail>;
  handleEvent(event: RunEvent): void;
  finalizeRun(runId: string): Promise<void>;
  subscribeRun(runId: string): void;
  stopStreaming(): void;
}

export interface AgentLoopContextValue {
  readonly state: AppState;
  readonly actions: AppActions;
  readonly currentRun: RunRecord | null;
  readonly runEvents: readonly RunEvent[];
}

export const AgentLoopContext = createContext<AgentLoopContextValue | null>(null);

export function useAgentLoop(): AgentLoopContextValue {
  const value = useContext(AgentLoopContext);
  if (value === null) throw new Error("useAgentLoop must be used within AgentLoopProvider");
  return value;
}
