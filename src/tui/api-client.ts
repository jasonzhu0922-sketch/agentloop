export interface TuiApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly traceId?: string;
  };
}

export class TuiApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly traceId?: string;

  constructor(message: string, status: number, details: { code?: string; traceId?: string } = {}) {
    super(message);
    this.name = "TuiApiError";
    this.status = status;
    this.code = details.code;
    this.traceId = details.traceId;
  }
}

export interface TuiUser {
  readonly id: string;
  readonly email: string;
}

export interface TuiAuthResult {
  readonly user: TuiUser;
  readonly token: string;
  readonly expiresAt: number;
}

export interface TuiProvider {
  readonly key: string;
  readonly kind: string;
  readonly defaultModel: string;
}

export interface TuiTool {
  readonly name: string;
  readonly dangerous: boolean;
  readonly description: string;
}

export interface TuiRun {
  readonly id: string;
  readonly status: string;
  readonly input: string;
  readonly output?: string;
  readonly errorCode?: string;
  readonly createdAt: number;
  readonly finishedAt?: number;
}

export interface TuiRunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export class TuiApiClient {
  private readonly baseUrl: URL;
  private token?: string;

  constructor(baseUrl = "http://127.0.0.1:8787", token?: string) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new TypeError("AGENTLOOP_URL must be a valid http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("AGENTLOOP_URL must use http or https");
    }
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
      throw new TypeError("AGENTLOOP_URL must not include credentials, query parameters, or a fragment");
    }
    this.baseUrl = parsed;
    this.token = token;
  }

  get endpoint(): string {
    return this.baseUrl.toString().replace(/\/$/, "");
  }

  get authenticated(): boolean {
    return this.token !== undefined;
  }

  clearToken(): void {
    this.token = undefined;
  }

  async health(): Promise<void> {
    const body = await this.request<{ status?: unknown }>("/healthz", { authenticated: false });
    if (body.status !== "ok") throw new TuiApiError("AgentLoop service returned an invalid health response", 502);
  }

  async login(email: string, password: string): Promise<TuiAuthResult> {
    const result = await this.request<TuiAuthResult>("/v1/auth/login", {
      method: "POST",
      body: { email, password },
      authenticated: false,
    });
    this.token = result.token;
    return result;
  }

  async register(email: string, password: string): Promise<TuiAuthResult> {
    const result = await this.request<TuiAuthResult>("/v1/auth/register", {
      method: "POST",
      body: { email, password },
      authenticated: false,
    });
    this.token = result.token;
    return result;
  }

  async logout(): Promise<void> {
    try {
      await this.request<undefined>("/v1/auth/logout", { method: "POST" });
    } finally {
      this.clearToken();
    }
  }

  me(): Promise<{ user: TuiUser }> {
    return this.request("/v1/me");
  }

  providers(): Promise<{ providers: TuiProvider[]; defaultProviderKey?: string }> {
    return this.request("/v1/providers");
  }

  tools(): Promise<{ tools: TuiTool[] }> {
    return this.request("/v1/tools");
  }

  executeRun(input: {
    readonly input: string;
    readonly allowDangerousTools: boolean;
  }): Promise<{ run: TuiRun }> {
    return this.request("/v1/runs", { method: "POST", body: input });
  }

  run(id: string): Promise<{ run: TuiRun }> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}`);
  }

  runPlan(id: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/plan`);
  }

  runEvents(id: string): Promise<{ events: TuiRunEvent[] }> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/events`);
  }

  private async request<T>(
    path: string,
    options: {
      readonly method?: "GET" | "POST";
      readonly body?: unknown;
      readonly authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const authenticated = options.authenticated ?? true;
    if (authenticated && this.token === undefined) throw new TuiApiError("Please log in first", 401);
    const headers: Record<string, string> = { accept: "application/json" };
    if (authenticated && this.token !== undefined) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      throw new TuiApiError(`Cannot reach AgentLoop at ${this.endpoint}: ${message}`, 503);
    }
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) {
      const error = isRecord(body) ? body as TuiApiErrorBody : {};
      const message = error.error?.message ?? `AgentLoop returned HTTP ${response.status}`;
      throw new TuiApiError(message, response.status, {
        code: error.error?.code,
        traceId: error.error?.traceId,
      });
    }
    if (body === undefined) throw new TuiApiError("AgentLoop returned an empty JSON response", 502);
    return body as T;
  }
}

function parseJson(value: string): unknown {
  if (value.trim().length === 0) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
