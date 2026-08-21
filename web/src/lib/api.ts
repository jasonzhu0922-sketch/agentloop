import type {
  ConversationDetail,
  ConversationSummary,
  ModelSummary,
  LocalDirectoryListing,
  PlanDetail,
  ProcessArtifact,
  ArtifactPreview,
  ProviderSummary,
  RunEvent,
  RunRecord,
  SkillSummary,
  ToolSummary,
  User,
} from "./types";

export interface AuthResult {
  readonly user: User;
  readonly token: string;
}

const TOKEN_KEY = "agentloop-token";

export function loadToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly traceId?: string;

  constructor(message: string, status: number, code?: string, traceId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.traceId = traceId;
  }
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly token?: string;
  readonly headers?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(options.token === undefined || options.token === ""
      ? {}
      : { authorization: `Bearer ${options.token}` }),
    ...options.headers,
  };
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    throw new ApiError(
      "无法连接 AgentLoop 服务：" + (error instanceof Error ? error.message : "网络错误"),
      0,
    );
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiError("服务返回了无效 JSON", response.status);
  }
  if (!response.ok) {
    const payload = body as { error?: { code?: string; message?: string; traceId?: string } };
    const trace = payload.error?.traceId ? ` (traceId: ${payload.error.traceId})` : "";
    throw new ApiError(
      (payload.error?.message ?? response.statusText) + trace,
      response.status,
      payload.error?.code,
      payload.error?.traceId,
    );
  }
  return body as T;
}

export const api = {
  register(email: string, password: string): Promise<AuthResult> {
    return request("/v1/auth/register", { method: "POST", body: { email, password } });
  },
  login(email: string, password: string): Promise<AuthResult> {
    return request("/v1/auth/login", { method: "POST", body: { email, password } });
  },
  logout(token: string): Promise<void> {
    return request("/v1/auth/logout", { method: "POST", token });
  },
  me(token: string): Promise<{ user: User }> {
    return request("/v1/me", { token });
  },
  skills(token: string): Promise<{ skills: readonly SkillSummary[] }> {
    return request("/v1/skills", { token });
  },
  tools(token: string): Promise<{ tools: readonly ToolSummary[] }> {
    return request("/v1/tools", { token });
  },
  localDirectories(token: string, path?: string): Promise<LocalDirectoryListing> {
    return request(`/v1/local-directories${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`, { token });
  },
  providers(token: string): Promise<{
    providers: readonly ProviderSummary[];
    models?: readonly ModelSummary[];
    defaultProviderKey?: string;
    defaultModelKey?: string;
  }> {
    return request("/v1/providers", { token });
  },
  conversations(token: string): Promise<{ conversations: readonly ConversationSummary[] }> {
    return request("/v1/conversations", { token });
  },
  conversation(token: string, id: string): Promise<ConversationDetail> {
    return request(`/v1/conversations/${encodeURIComponent(id)}`, { token });
  },
  deleteConversation(token: string, id: string): Promise<void> {
    return request(`/v1/conversations/${encodeURIComponent(id)}`, { method: "DELETE", token });
  },
  updateConversationVisibleDirectories(
    token: string,
    id: string,
    visibleDirectories: readonly string[],
  ): Promise<{ conversation: ConversationSummary }> {
    return request(`/v1/conversations/${encodeURIComponent(id)}/visible-directories`, {
      method: "PATCH",
      token,
      body: { visibleDirectories },
    });
  },
  startRun(
    token: string,
    input: string,
    options: {
      allowDangerousTools?: boolean;
      conversationId?: string;
      modelKey?: string;
      visibleDirectories?: readonly string[];
    } = {},
  ): Promise<{ run: RunRecord }> {
    return request("/v1/runs/async", {
      method: "POST",
      token,
      body: {
        input,
        allowDangerousTools: options.allowDangerousTools ?? true,
        conversationIntent: "auto",
        ...(options.modelKey === undefined ? {} : { modelKey: options.modelKey }),
        ...(options.visibleDirectories === undefined || options.visibleDirectories.length === 0
          ? {}
          : { visibleDirectories: options.visibleDirectories }),
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      },
    });
  },
  run(token: string, id: string): Promise<{ run: RunRecord }> {
    return request(`/v1/runs/${encodeURIComponent(id)}`, { token });
  },
  cancelRun(token: string, id: string): Promise<{ run: RunRecord }> {
    return request(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", token });
  },
  runEvents(token: string, id: string): Promise<{ events: readonly RunEvent[] }> {
    return request(`/v1/runs/${encodeURIComponent(id)}/events`, { token });
  },
  runPlan(token: string, id: string): Promise<PlanDetail> {
    return request(`/v1/runs/${encodeURIComponent(id)}/plan`, { token });
  },
  runArtifacts(token: string, id: string): Promise<{ artifacts: readonly ProcessArtifact[] }> {
    return request(`/v1/runs/${encodeURIComponent(id)}/artifacts`, { token });
  },
  runArtifactPreview(token: string, runId: string, artifactId: string): Promise<{ preview: ArtifactPreview }> {
    return request(`/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/preview`, { token });
  },
  runArtifactBytes(token: string, runId: string, artifactId: string): Promise<Blob> {
    return fetch(`/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then(async (response) => {
      if (!response.ok) throw new ApiError(`无法打开过程产物（HTTP ${response.status}）`, response.status);
      return response.blob();
    });
  },
};
