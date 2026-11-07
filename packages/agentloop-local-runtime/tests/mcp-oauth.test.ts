import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { McpOAuth, type McpOAuthGrant } from "../src/mcp/mcp-oauth.ts";
import { loadMcpToolsFromConfig } from "../../agentloop/src/mcp/mcp-loader.ts";

const resource = "https://archive.example/mcp", redirect = "http://127.0.0.1:19174/oauth/callback";
function fixture() {
  let now = 1000;
  const calls: { url: string; init: RequestInit }[] = [];
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    assert.equal(init.redirect, "error");
    if (url === "https://archive.example/.well-known/oauth-protected-resource/mcp") return Response.json({
      resource, authorization_servers: ["https://identity.example/mcp"], scopes_supported: ["read", "offline_access"],
    });
    if (url === "https://identity.example/.well-known/oauth-authorization-server/mcp") return Response.json({
      issuer: "https://identity.example/mcp", authorization_endpoint: "https://identity.example/authorize",
      token_endpoint: "https://identity.example/token", registration_endpoint: "https://registration.example/register",
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    });
    if (url === "https://registration.example/register") {
      const body = JSON.parse(init.body as string);
      assert.equal(body.token_endpoint_auth_method, "none");
      assert.deepEqual(body.redirect_uris, [redirect]);
      assert.equal(body.client_secret, undefined);
      return Response.json({ client_id: "public-client", token_endpoint_auth_method: "none", redirect_uris: [redirect] }, { status: 201 });
    }
    if (url === "https://identity.example/token") return Response.json({
      access_token: "access-private", refresh_token: "refresh-private", expires_in: 3600, token_type: "Bearer", scope: "read offline_access",
    });
    throw new Error(`Unexpected test endpoint ${url}`);
  };
  return { oauth: new McpOAuth(resource, request, () => now), request, calls, advance: () => { now += 600_001; } };
}
function callback(state: string, extra = "code=one-use-code") { return new URL(`${redirect}?state=${state}&${extra}`); }

test("remote MCP OAuth uses metadata discovery, public registration, resource binding and PKCE; callback is single-use", async () => {
  const { oauth, calls } = fixture();
  const started = await oauth.start("alice", redirect, ["read", "offline_access"]);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, "https://identity.example");
  assert.equal(authorization.searchParams.get("resource"), resource);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.has("code_verifier"), false);
  const grant = await oauth.complete("alice", callback(started.state));
  const body = new URLSearchParams(calls.at(-1)!.init.body as string);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("resource"), resource);
  assert.equal(body.get("redirect_uri"), redirect);
  assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
  assert.equal(grant.accessToken, "access-private");
  assert.equal(grant.expiresAt, 3_601_000);
  await assert.rejects(oauth.complete("alice", callback(started.state)), /state_invalid/);
});

test("another account cannot redeem or consume a pending authorization", async () => {
  const { oauth, calls } = fixture();
  const { state } = await oauth.start("alice", redirect, ["read"]);
  await assert.rejects(oauth.complete("bob", callback(state)), /state_invalid/);
  assert.equal(calls.some(call => call.url.endsWith("/token")), false);
  assert.equal((await oauth.complete("alice", callback(state))).accessToken, "access-private");
});

test("expired, denied, mismatched and duplicated callbacks never exchange a code", async () => {
  for (const kind of ["expired", "denied", "redirect", "duplicates"] as const) {
    const { oauth, calls, advance } = fixture();
    const { state } = await oauth.start("alice", redirect, ["read"]);
    const url = callback(state, kind === "denied" ? "error=access_denied" : "code=one-use-code");
    if (kind === "expired") advance();
    if (kind === "redirect") url.pathname = "/unrelated";
    if (kind === "duplicates") url.searchParams.append("state", state);
    await assert.rejects(oauth.complete("alice", url), /mcp_oauth_/);
    assert.equal(calls.some(call => call.url.endsWith("/token")), false);
  }
});

test("refresh preserves credentials when no rotation is returned and never echoes upstream token errors", async () => {
  const { oauth, calls } = fixture();
  const { state } = await oauth.start("alice", redirect, ["read", "offline_access"]);
  const grant = await oauth.complete("alice", callback(state));
  const noRotation = new McpOAuth(resource, async () => Response.json({ access_token: "next-access", expires_in: 3600, token_type: "Bearer" }));
  const preserved = await noRotation.refresh(grant);
  assert.equal(preserved.refreshToken, "refresh-private");
  assert.equal(preserved.accessToken, "next-access");
  const refreshed = await oauth.refresh(grant);
  assert.equal(refreshed.refreshToken, "refresh-private");
  const body = new URLSearchParams(calls.at(-1)!.init.body as string);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "refresh-private");
  const failure = new McpOAuth(resource, async () => new Response("secret-token-must-not-leak", { status: 401 }));
  await assert.rejects(failure.refresh(grant), error => error instanceof Error && error.message === "mcp_oauth_http_401");
  const malformed = new McpOAuth(resource, async () => new Response("secret-token-must-not-leak"));
  await assert.rejects(malformed.refresh(grant), error => error instanceof Error && error.message === "mcp_oauth_response_invalid");
  await assert.rejects(oauth.refresh({ ...grant, resource: "https://other.example/mcp" }), /resource_invalid/);
});

test("unsafe callback URLs, unsupported scopes and insecure discovery are rejected", async () => {
  const { oauth } = fixture();
  await assert.rejects(oauth.start("alice", "http://external.example/callback", ["read"]), /redirect_invalid/);
  await assert.rejects(oauth.start("alice", `${redirect}?unexpected=1`, ["read"]), /redirect_invalid/);
  await assert.rejects(oauth.start("alice", redirect, ["write"]), /scope_unsupported/);
  const insecure = new McpOAuth(resource, async () => Response.json({ resource, authorization_servers: ["http://identity.example"] }));
  await assert.rejects(insecure.start("alice", redirect, ["read"]), /endpoint_invalid/);
});

test("an OAuth grant feeds the ordinary MCP initialize/list/call path with server-discovered schemas", async t => {
  const { oauth } = fixture();
  const { state } = await oauth.start("alice", redirect, ["read"]);
  const grant: McpOAuthGrant = await oauth.complete("alice", callback(state));
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer access-private");
    const body = JSON.parse(init.body as string); methods.push(body.method);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "arbitrary-archive", version: "1" } }
      : body.method === "tools/list" ? { tools: [{ name: "inspect-archive", description: "Inspect an authorized archive",
        inputSchema: { type: "object", required: ["archive"], properties: { archive: { type: "string" } } } }] }
      : { content: [{ type: "text", text: "verified fixture result" }] };
    if (body.method === "tools/call") assert.deepEqual(body.params, { name: "inspect-archive", arguments: { archive: "chosen" } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  const loaded = await loadMcpToolsFromConfig({ servers: [{ key: "authorized-archive", transport: "http", url: grant.resource,
    headers: { authorization: `Bearer ${grant.accessToken}` } }] });
  assert.deepEqual(loaded.failedServers, []);
  assert.equal(loaded.tools.length, 1);
  assert.equal(loaded.tools[0]!.source?.transport, "mcp");
  assert.deepEqual(loaded.tools[0]!.inputSchema.required, ["archive"]);
  const result = await loaded.tools[0]!.execute({} as never, { archive: "chosen" }) as { text: string };
  assert.equal(result.text, "verified fixture result");
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
});
