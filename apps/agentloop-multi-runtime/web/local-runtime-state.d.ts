export interface LocalRuntimeState {
  device: Record<string, unknown> | undefined;
  runtimeId: string;
  sessionRefresh: Promise<unknown> | undefined;
  sessionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  scopes: Array<Record<string, unknown>>;
  runtimes: Array<Record<string, unknown>>;
  agentHealth: Record<string, unknown> | undefined;
  agentConfig: Record<string, unknown> | undefined;
  agentStatus: string;
  agentInstallPoll: ReturnType<typeof setInterval> | undefined;
  agentReprobe: ReturnType<typeof setTimeout> | undefined;
  hydratedPreferenceKey: string;
  clear(): void;
}

export function createLocalRuntimeState(): LocalRuntimeState;
