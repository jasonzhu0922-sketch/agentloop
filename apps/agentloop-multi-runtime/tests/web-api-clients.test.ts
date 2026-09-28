import assert from "node:assert/strict";
import test from "node:test";
import { createRouterClient, routerProxyPath } from "../web/router-client.js";
import { createLocalAgentClient } from "../web/local-agent-client.js";

test("Router client adds the current bearer token without replacing caller headers", async () => {
  let captured: RequestInit | undefined;
  const client = createRouterClient({ baseUrl: "https://router.example/", tokenProvider: () => "token-1", fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => { captured = init; return new Response("{}", { status: 200 }); } });
  await client.request("/v1/models", { headers: { "x-request-id": "request-1" } });
  assert.equal(new Headers(captured?.headers).get("authorization"), "Bearer token-1");
  assert.equal(new Headers(captured?.headers).get("x-request-id"), "request-1");
});

test("same-origin Router proxy resolves relative /api without constructing an invalid base URL", () => {
  assert.equal(routerProxyPath("/api/v1/conversations?limit=30", "/api", "http://localhost:5174/"), "/v1/conversations?limit=30");
  assert.equal(routerProxyPath("http://router.example/v1/models", "/api", "http://localhost:5174/"), undefined);
  assert.equal(routerProxyPath("/v1/models", "http://router.example/", "http://router.example/"), "/v1/models");
});

test("Local Agent client refreshes only an expired session rejection and retries once", async () => {
  let refreshes = 0;
  let calls = 0;
  let token = "first";
  const client = createLocalAgentClient({
    baseUrl: "http://127.0.0.1:8790/",
    session: { ensureValid: async () => undefined, token: () => token, refresh: async () => { refreshes += 1; token = "second"; } },
    fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) { assert.equal(new Headers(init?.headers).get("x-local-session"), "first"); return new Response(JSON.stringify({ error: "local_session_invalid" }), { status: 401 }); }
      assert.equal(new Headers(init?.headers).get("x-local-session"), "second");
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal((await client.request("/v1/directory-scopes")).status, 200);
  assert.equal(refreshes, 1);
  assert.equal(calls, 2);
});
