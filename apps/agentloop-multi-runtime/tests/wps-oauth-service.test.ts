import assert from "node:assert/strict";
import test from "node:test";
import { WpsOAuthService } from "../local-agent-runtime/src/service/wps-oauth-service.ts";

test("WPS OAuth uses the registered callback and exchanges only a state-bound code", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ access_token: "local-access", refresh_token: "local-refresh", expires_in: 7200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const oauth = new WpsOAuthService({
    WPS_OAUTH_CLIENT_ID: "wps-app-id",
    WPS_OAUTH_CLIENT_SECRET: "wps-app-secret",
    WPS_OAUTH_REDIRECT_URI: "http://127.0.0.1:18790/v1/local-connectors/kingsoft-wps/callback",
  });
  const authorization = oauth.start({ runtimeId: "runtime-1", origin: "https://web.agentloop.test" });
  const url = new URL(authorization.authorizationUrl);
  assert.equal(url.origin, "https://openapi.wps.cn");
  assert.equal(url.pathname, "/oauth2/auth");
  assert.equal(url.searchParams.get("client_id"), "wps-app-id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:18790/v1/local-connectors/kingsoft-wps/callback");
  assert.equal(url.searchParams.get("scope"), "kso.file.read,kso.file_search.readwrite");

  const unknown = await oauth.complete({ state: "not-created", code: "ignored" });
  assert.match(unknown.error ?? "", /过期/);
  assert.equal(requests.length, 0);

  const complete = await oauth.complete({ state: url.searchParams.get("state")!, code: "single-use-code" });
  assert.equal(complete.pending?.runtimeId, "runtime-1");
  assert.equal(complete.pending?.origin, "https://web.agentloop.test");
  assert.equal(complete.token?.accessToken, "local-access");
  assert.equal(complete.token?.refreshToken, "local-refresh");
  assert.equal(requests.length, 1);
  assert.equal(new URLSearchParams(String(requests[0]?.init?.body)).get("client_secret"), "wps-app-secret");

  const replay = await oauth.complete({ state: url.searchParams.get("state")!, code: "single-use-code" });
  assert.match(replay.error ?? "", /过期/);
  assert.equal(requests.length, 1);
});

test("WPS OAuth cannot start without the deployment-owned application credentials", () => {
  const oauth = new WpsOAuthService({ WPS_OAUTH_CLIENT_ID: "only-id" });
  assert.throws(() => oauth.start({ runtimeId: "runtime-1", origin: "https://web.agentloop.test" }), { message: "wps_oauth_not_configured" });
});

test("WPS OAuth refreshes an expired local credential and rotates the refresh token", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ access_token: "next-access", refresh_token: "next-refresh", expires_in: 7200 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const oauth = new WpsOAuthService({
    WPS_OAUTH_CLIENT_ID: "wps-app-id",
    WPS_OAUTH_CLIENT_SECRET: "wps-app-secret",
    WPS_OAUTH_REDIRECT_URI: "http://127.0.0.1:18790/v1/local-connectors/kingsoft-wps/callback",
  });
  const credentials = await oauth.refreshCredentials({
    accessToken: "expired-access", refreshToken: "old-refresh", expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  assert.equal(credentials.accessToken, "next-access");
  assert.equal(credentials.refreshToken, "next-refresh");
  assert.ok(Date.parse(credentials.expiresAt!) > Date.now());
});
