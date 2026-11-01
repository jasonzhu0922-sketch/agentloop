import { randomBytes } from "node:crypto";

export interface FeishuOAuthProviderConfiguration {
  readonly appId: string;
  readonly appSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly appAccessTokenUrl: string;
}

export interface FeishuOAuthAuthorization {
  readonly authorizationUrl: string;
  readonly attemptId: string;
}

export interface FeishuOAuthToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly refreshExpiresAt?: string;
}

interface PendingAuthorization {
  readonly attemptId: string;
  readonly runtimeId: string;
  readonly origin: string;
  readonly expiresAt: number;
}

/** Owns the Feishu OAuth boundary; Connector code only receives user credentials. */
export class FeishuOAuthService {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(environment: Readonly<Record<string, string | undefined>> = {}) {
    this.environment = environment;
  }

  isConfigured(): boolean { return this.configuration() !== undefined; }

  start(input: { readonly runtimeId: string; readonly origin: string }): FeishuOAuthAuthorization {
    const configuration = this.requiredConfiguration();
    this.removeExpired();
    const state = randomState();
    const attemptId = randomState();
    this.pending.set(state, { attemptId, runtimeId: input.runtimeId, origin: input.origin, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL("https://open.feishu.cn/open-apis/authen/v1/index");
    url.searchParams.set("app_id", configuration.appId);
    url.searchParams.set("redirect_uri", configuration.redirectUri);
    url.searchParams.set("state", state);
    if (configuration.scopes.length > 0) url.searchParams.set("scope", configuration.scopes.join(" "));
    return { authorizationUrl: url.toString(), attemptId };
  }

  async complete(input: { readonly state?: string; readonly code?: string; readonly error?: string }): Promise<{
    readonly pending?: PendingAuthorization;
    readonly token?: FeishuOAuthToken;
    readonly error?: string;
  }> {
    this.removeExpired();
    if (input.state === undefined || input.state.length === 0) return { error: "授权回调缺少 state。" };
    const pending = this.pending.get(input.state);
    this.pending.delete(input.state);
    if (pending === undefined) return { error: "授权已过期或不属于当前设备，请从 Connector 页面重新发起。" };
    if (input.error !== undefined && input.error.length > 0) return { pending, error: "飞书未授予访问权限。" };
    if (input.code === undefined || input.code.length === 0) return { pending, error: "授权回调缺少 code。" };
    try {
      return { pending, token: await this.exchangeCode(input.code) };
    } catch {
      return { pending, error: "飞书授权码兑换失败，请重新连接。" };
    }
  }

  async refreshCredentials(credentials: Readonly<Record<string, string>>): Promise<Readonly<Record<string, string>>> {
    if (credentials.provider !== "feishu") return credentials;
    const refreshToken = string(credentials.refreshToken);
    const expiresAt = string(credentials.expiresAt);
    if (refreshToken === undefined || expiresAt === undefined || Date.parse(expiresAt) > Date.now() + 60_000) return credentials;
    const token = await this.requestUserToken({ grantType: "refresh_token", refreshToken });
    return {
      ...credentials,
      provider: "feishu",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      ...(token.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: token.refreshExpiresAt }),
    };
  }

  private async exchangeCode(code: string): Promise<FeishuOAuthToken> {
    return await this.requestUserToken({ grantType: "authorization_code", code });
  }

  private async requestUserToken(input: { readonly grantType: "authorization_code" | "refresh_token"; readonly code?: string; readonly refreshToken?: string }): Promise<FeishuOAuthToken> {
    const configuration = this.requiredConfiguration();
    const appAccessToken = await this.fetchAppAccessToken(configuration);
    const response = await fetch(input.grantType === "refresh_token"
      ? "https://open.feishu.cn/open-apis/authen/v1/refresh_access_token"
      : "https://open.feishu.cn/open-apis/authen/v1/access_token", {
      method: "POST",
      headers: { authorization: `Bearer ${appAccessToken}`, "content-type": "application/json; charset=utf-8", accept: "application/json" },
      body: JSON.stringify({
        grant_type: input.grantType,
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.refreshToken === undefined ? {} : { refresh_token: input.refreshToken }),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(body) || body.code !== 0 || !isRecord(body.data)) throw new Error("feishu_oauth_token_exchange_failed");
    return tokenFrom(body.data);
  }

  private async fetchAppAccessToken(configuration: FeishuOAuthProviderConfiguration): Promise<string> {
    const response = await fetch(configuration.appAccessTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
      body: JSON.stringify({ app_id: configuration.appId, app_secret: configuration.appSecret }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(body) || (typeof body.code === "number" && body.code !== 0)) throw new Error("feishu_app_access_token_failed");
    // Feishu has both legacy app_access_token responses and newer unified
    // access_token responses; accept either without weakening the code check.
    const token = string(body.app_access_token)
      ?? string(body.access_token)
      ?? (isRecord(body.data) ? string(body.data.app_access_token) ?? string(body.data.access_token) : undefined);
    if (token === undefined) throw new Error("feishu_app_access_token_invalid");
    return token;
  }

  private configuration(): FeishuOAuthProviderConfiguration | undefined {
    const appId = string(this.environment.FEISHU_OAUTH_APP_ID);
    const appSecret = string(this.environment.FEISHU_OAUTH_APP_SECRET);
    const redirectUri = validRedirectUri(this.environment.FEISHU_OAUTH_REDIRECT_URI);
    if (appId === undefined || appSecret === undefined || redirectUri === undefined) return undefined;
    const scopes = (this.environment.FEISHU_OAUTH_SCOPES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    // Store/ISV apps use the public endpoint. Self-built apps can override this
    // with .../auth/v3/app_access_token/internal in their private environment.
    const appAccessTokenUrl = validUrl(this.environment.FEISHU_OAUTH_APP_ACCESS_TOKEN_URL)
      ?? "https://open.feishu.cn/open-apis/auth/v3/app_access_token";
    return { appId, appSecret, redirectUri, scopes, appAccessTokenUrl };
  }

  private requiredConfiguration(): FeishuOAuthProviderConfiguration {
    const configuration = this.configuration();
    if (configuration === undefined) throw Object.assign(new Error("feishu_oauth_not_configured"), { status: 409 });
    return configuration;
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [state, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(state);
  }
}

function tokenFrom(value: Record<string, unknown>): FeishuOAuthToken {
  const accessToken = string(value.access_token);
  const refreshToken = string(value.refresh_token);
  const expiresIn = number(value.expires_in);
  if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined) throw new Error("feishu_oauth_token_response_invalid");
  const refreshExpiresIn = number(value.refresh_expires_in);
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    ...(refreshExpiresIn === undefined ? {} : { refreshExpiresAt: new Date(Date.now() + refreshExpiresIn * 1000).toISOString() }),
  };
}

function randomState(): string { return randomBytes(32).toString("base64url"); }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim().length > 0 ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validUrl(value: unknown): string | undefined {
  const source = string(value); if (source === undefined) return undefined;
  try { const url = new URL(source); if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) return undefined; return url.toString(); } catch { return undefined; }
}
function validRedirectUri(value: unknown): string | undefined { return validUrl(value); }
