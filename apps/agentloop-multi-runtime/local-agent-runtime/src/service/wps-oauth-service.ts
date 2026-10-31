import { randomBytes } from "node:crypto";

export interface WpsOAuthProviderConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

export interface WpsOAuthAuthorization {
  readonly authorizationUrl: string;
  readonly attemptId: string;
}

export interface WpsOAuthToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}

interface PendingAuthorization {
  readonly attemptId: string;
  readonly runtimeId: string;
  readonly origin: string;
  readonly expiresAt: number;
}

/**
 * Owns the WPS OAuth boundary: WPS application credentials stay in the
 * device-owned Local Agent environment, while user tokens are returned only
 * to the caller that initiated the loopback authorization.
 */
export class WpsOAuthService {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(environment: Readonly<Record<string, string | undefined>> = {}) {
    this.environment = environment;
  }

  isConfigured(): boolean {
    return this.configuration() !== undefined;
  }

  start(input: { readonly runtimeId: string; readonly origin: string }): WpsOAuthAuthorization {
    const configuration = this.requiredConfiguration();
    this.removeExpired();
    const state = randomState();
    const attemptId = randomState();
    this.pending.set(state, {
      attemptId,
      runtimeId: input.runtimeId,
      origin: input.origin,
      expiresAt: Date.now() + 10 * 60_000,
    });
    const url = new URL("https://openapi.wps.cn/oauth2/auth");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", configuration.clientId);
    url.searchParams.set("redirect_uri", configuration.redirectUri);
    url.searchParams.set("scope", configuration.scopes.join(","));
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), attemptId };
  }

  async complete(input: { readonly state?: string; readonly code?: string; readonly error?: string }): Promise<{
    readonly pending?: PendingAuthorization;
    readonly token?: WpsOAuthToken;
    readonly error?: string;
  }> {
    this.removeExpired();
    if (input.state === undefined || input.state.length === 0) return { error: "授权回调缺少 state。" };
    const pending = this.pending.get(input.state);
    this.pending.delete(input.state);
    if (pending === undefined) return { error: "授权已过期或不属于当前设备，请从 Connector 页面重新发起。" };
    if (input.error !== undefined && input.error.length > 0) return { pending, error: "金山文档未授予访问权限。" };
    if (input.code === undefined || input.code.length === 0) return { pending, error: "授权回调缺少 code。" };
    try {
      return { pending, token: await this.exchangeCode(input.code) };
    } catch {
      return { pending, error: "金山文档授权码兑换失败，请重新连接。" };
    }
  }

  async refreshCredentials(credentials: Readonly<Record<string, string>>): Promise<Readonly<Record<string, string>>> {
    const refreshToken = string(credentials.refreshToken);
    const expiresAt = string(credentials.expiresAt);
    if (refreshToken === undefined || expiresAt === undefined || Date.parse(expiresAt) > Date.now() + 60_000) return credentials;
    const configuration = this.requiredConfiguration();
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      refresh_token: refreshToken,
    });
    const response = await fetch("https://openapi.wps.cn/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("wps_oauth_refresh_failed");
    const value = body as Record<string, unknown>;
    const accessToken = string(value.access_token);
    const nextRefreshToken = string(value.refresh_token);
    const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in) ? value.expires_in : undefined;
    if (accessToken === undefined || nextRefreshToken === undefined || expiresIn === undefined) throw new Error("wps_oauth_refresh_response_invalid");
    return { ...credentials, accessToken, refreshToken: nextRefreshToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  }

  private async exchangeCode(code: string): Promise<WpsOAuthToken> {
    const configuration = this.requiredConfiguration();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      code,
      redirect_uri: configuration.redirectUri,
    });
    const response = await fetch("https://openapi.wps.cn/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("wps_oauth_token_exchange_failed");
    const value = body as Record<string, unknown>;
    const accessToken = string(value.access_token);
    const refreshToken = string(value.refresh_token);
    const expiresIn = typeof value.expires_in === "number" && Number.isFinite(value.expires_in) ? value.expires_in : undefined;
    if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined) throw new Error("wps_oauth_token_response_invalid");
    return { accessToken, refreshToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  }

  private configuration(): WpsOAuthProviderConfiguration | undefined {
    const clientId = string(this.environment.WPS_OAUTH_CLIENT_ID);
    const clientSecret = string(this.environment.WPS_OAUTH_CLIENT_SECRET);
    const redirectUri = validRedirectUri(this.environment.WPS_OAUTH_REDIRECT_URI);
    if (clientId === undefined || clientSecret === undefined || redirectUri === undefined) return undefined;
    const scopes = (this.environment.WPS_OAUTH_SCOPES ?? "kso.file.read,kso.file_search.readwrite")
      .split(",").map((value) => value.trim()).filter(Boolean);
    return scopes.length === 0 ? undefined : { clientId, clientSecret, redirectUri, scopes };
  }

  private requiredConfiguration(): WpsOAuthProviderConfiguration {
    const configuration = this.configuration();
    if (configuration === undefined) throw Object.assign(new Error("wps_oauth_not_configured"), { status: 409 });
    return configuration;
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [state, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(state);
  }
}

function randomState(): string { return randomBytes(32).toString("base64url"); }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim().length > 0 ? value : undefined; }
function validRedirectUri(value: unknown): string | undefined {
  const source = string(value);
  if (source === undefined) return undefined;
  try {
    const url = new URL(source);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) return undefined;
    return url.toString();
  } catch { return undefined; }
}
