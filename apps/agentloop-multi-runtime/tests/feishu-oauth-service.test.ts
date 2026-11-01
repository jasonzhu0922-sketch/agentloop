import assert from "node:assert/strict";
import test from "node:test";
import { FeishuOAuthService } from "../local-agent-runtime/src/service/feishu-oauth-service.ts";

const environment = {
  FEISHU_OAUTH_APP_ID: "cli-feishu-app",
  FEISHU_OAUTH_APP_SECRET: "feishu-secret",
  FEISHU_OAUTH_REDIRECT_URI: "http://127.0.0.1:18790/v1/local-connectors/feishu/callback",
  FEISHU_OAUTH_SCOPES: "docx:document:readonly,drive:drive.search:readonly",
};

test("Feishu OAuth binds authorization to state and exchanges a user code", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("app_access_token")) return Response.json({ app_access_token: "app-token", expires_in: 7200 });
    return Response.json({ code: 0, data: { access_token: "u-access", refresh_token: "ur-refresh", expires_in: 7100, refresh_expires_in: 2_500_000 } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const oauth = new FeishuOAuthService(environment);
  const authorization = oauth.start({ runtimeId: "runtime-1", origin: "https://web.agentloop.test" });
  const url = new URL(authorization.authorizationUrl);
  assert.equal(url.origin, "https://open.feishu.cn");
  assert.equal(url.pathname, "/open-apis/authen/v1/index");
  assert.equal(url.searchParams.get("app_id"), "cli-feishu-app");
  assert.equal(url.searchParams.get("redirect_uri"), environment.FEISHU_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get("scope"), "docx:document:readonly drive:drive.search:readonly");

  const complete = await oauth.complete({ state: url.searchParams.get("state")!, code: "one-time-code" });
  assert.equal(complete.pending?.runtimeId, "runtime-1");
  assert.equal(complete.token?.accessToken, "u-access");
  assert.equal(complete.token?.refreshToken, "ur-refresh");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://open.feishu.cn/open-apis/auth/v3/app_access_token");
  assert.equal(requests[1]?.url, "https://open.feishu.cn/open-apis/authen/v1/access_token");
  assert.equal(requests[1]?.init?.headers && new Headers(requests[1].init.headers).get("authorization"), "Bearer app-token");
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { grant_type: "authorization_code", code: "one-time-code" });

  const replay = await oauth.complete({ state: url.searchParams.get("state")!, code: "one-time-code" });
  assert.match(replay.error ?? "", /过期/);
});

test("Feishu OAuth refreshes only Feishu credentials and rotates refresh token", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("app_access_token")) return Response.json({ app_access_token: "app-token" });
    return Response.json({ code: 0, data: { access_token: "u-next", refresh_token: "ur-next", expires_in: 7000 } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const oauth = new FeishuOAuthService(environment);
  const credentials = await oauth.refreshCredentials({ provider: "feishu", accessToken: "u-old", refreshToken: "ur-old", expiresAt: new Date(Date.now() - 1_000).toISOString() });
  assert.equal(credentials.accessToken, "u-next");
  assert.equal(credentials.refreshToken, "ur-next");
  assert.equal(requests[1], "https://open.feishu.cn/open-apis/authen/v1/refresh_access_token");
  assert.deepEqual(await oauth.refreshCredentials({ provider: "other", accessToken: "x", refreshToken: "y", expiresAt: new Date(0).toISOString() }), { provider: "other", accessToken: "x", refreshToken: "y", expiresAt: new Date(0).toISOString() });
});
