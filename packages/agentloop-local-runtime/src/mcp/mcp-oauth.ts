import { createHash, randomBytes } from "node:crypto";

export interface McpOAuthGrant {
  readonly resource: string;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly scope: string;
}
interface Pending {
  owner: string; redirectUri: string; verifier: string; expiresAt: number;
  issuer: string; tokenEndpoint: string; clientId: string; scope: string;
}
interface ResourceMetadata { resource: string; authorization_servers: string[]; scopes_supported?: string[] }
interface AuthorizationMetadata {
  issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string;
  code_challenge_methods_supported: string[]; token_endpoint_auth_methods_supported: string[];
}

/** Host-side OAuth for remote MCP. No provider-specific API or tool schemas. */
export class McpOAuth {
  private readonly pending = new Map<string, Pending>();
  readonly resource: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  constructor(resource: string, request: typeof fetch = fetch, now = Date.now) {
    secureUrl(resource);
    this.resource = resource; this.request = request; this.now = now;
  }

  async start(owner: string, redirectUri: string, scopes: readonly string[]) {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(redirect.hostname)
      || redirect.username || redirect.password || redirect.hash || redirect.search) throw new Error("mcp_oauth_redirect_invalid");
    const resource = new URL(this.resource);
    const discovery = new URL(`/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`, resource.origin);
    const metadata = await this.json(discovery.toString()) as unknown as ResourceMetadata;
    if (metadata.resource !== this.resource || !Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.length) throw new Error("mcp_oauth_resource_invalid");
    const issuer = secureUrl(metadata.authorization_servers[0]!);
    const discoveryUrl = new URL(`/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`, issuer.origin);
    const auth = await this.json(discoveryUrl.toString()) as unknown as AuthorizationMetadata;
    if (auth.issuer !== issuer.toString().replace(/\/$/, "") || !auth.code_challenge_methods_supported?.includes("S256")
      || !auth.token_endpoint_auth_methods_supported?.includes("none")) throw new Error("mcp_oauth_server_unsupported");
    for (const endpoint of [auth.authorization_endpoint, auth.token_endpoint, auth.registration_endpoint]) secureUrl(endpoint);
    if (scopes.some(scope => !metadata.scopes_supported?.includes(scope))) throw new Error("mcp_oauth_scope_unsupported");
    const scope = scopes.join(" ");
    const registration = await this.json(auth.registration_endpoint, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        client_name: "AgentLoop", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope,
      }),
    });
    if (typeof registration.client_id !== "string" || !registration.client_id
      || registration.token_endpoint_auth_method !== "none"
      || !Array.isArray(registration.redirect_uris) || !registration.redirect_uris.includes(redirectUri)) throw new Error("mcp_oauth_registration_invalid");
    for (const [key, value] of this.pending) if (value.expiresAt <= this.now()) this.pending.delete(key);
    if (this.pending.size >= 32) throw new Error("mcp_oauth_too_many_attempts");
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, { owner, redirectUri, verifier, expiresAt: this.now() + 600_000,
      issuer: auth.issuer, tokenEndpoint: auth.token_endpoint, clientId: registration.client_id, scope });
    const authorization = new URL(auth.authorization_endpoint);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: registration.client_id,
      redirect_uri: redirectUri, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", scope, resource: this.resource })) authorization.searchParams.set(key, value);
    return { authorizationUrl: authorization.toString(), state };
  }

  async complete(owner: string, callback: URL): Promise<McpOAuthGrant> {
    const state = callback.searchParams.get("state") ?? "";
    const pending = this.pending.get(state);
    // A callback for another local account must not consume this account's attempt.
    if (!pending || pending.owner !== owner) throw new Error("mcp_oauth_state_invalid");
    this.pending.delete(state);
    if (pending.expiresAt <= this.now()) throw new Error("mcp_oauth_expired");
    if (`${callback.origin}${callback.pathname}` !== pending.redirectUri) throw new Error("mcp_oauth_redirect_invalid");
    if (callback.searchParams.has("error")) throw new Error("mcp_oauth_denied");
    const code = callback.searchParams.get("code");
    if (!code || callback.searchParams.getAll("code").length !== 1 || callback.searchParams.getAll("state").length !== 1) throw new Error("mcp_oauth_code_missing");
    const token = await this.token(pending.tokenEndpoint, { grant_type: "authorization_code", code,
      redirect_uri: pending.redirectUri, client_id: pending.clientId, code_verifier: pending.verifier, resource: this.resource });
    return this.grant(token, { resource: this.resource, issuer: pending.issuer, tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.clientId, scope: pending.scope });
  }

  async refresh(grant: McpOAuthGrant): Promise<McpOAuthGrant> {
    if (grant.resource !== this.resource) throw new Error("mcp_oauth_resource_invalid");
    if (!grant.refreshToken) throw new Error("mcp_oauth_reauthorization_required");
    const result = await this.token(grant.tokenEndpoint, { grant_type: "refresh_token", refresh_token: grant.refreshToken,
      client_id: grant.clientId, resource: grant.resource });
    return this.grant(result, grant);
  }

  private grant(token: Record<string, unknown>, previous: Omit<McpOAuthGrant, "accessToken" | "expiresAt">): McpOAuthGrant {
    if (typeof token.access_token !== "string" || !token.access_token || /[\r\n]/.test(token.access_token)
      || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer"
      || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0
      || (token.refresh_token !== undefined && (typeof token.refresh_token !== "string" || !token.refresh_token))
      || (token.scope !== undefined && typeof token.scope !== "string")) throw new Error("mcp_oauth_token_invalid");
    return { ...previous, accessToken: token.access_token, expiresAt: this.now() + token.expires_in * 1000,
      ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
      scope: typeof token.scope === "string" ? token.scope : previous.scope };
  }

  private token(endpoint: string, parameters: Record<string, string>) {
    secureUrl(endpoint);
    return this.json(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(parameters).toString() });
  }
  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) }); }
    catch { throw new Error("mcp_oauth_transport_failed"); }
    // Provider responses may contain tokens/codes; never include them in errors.
    if (!response.ok) throw new Error(`mcp_oauth_http_${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("mcp_oauth_response_invalid"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("mcp_oauth_response_invalid");
    return body as Record<string, unknown>;
  }
}

function secureUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("mcp_oauth_endpoint_invalid");
  return url;
}
