import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { SqliteConnection } from "@zhujun/agentloop";
import { IdentityService, type CloudSession } from "@zhujun/agentloop-identity";
import { createAccountServer } from "../../agentloop-account-service/src/server.ts";
import { CloudAccountAuth } from "../src/auth/cloud-auth.ts";
import { AccountSessions, HttpError } from "../src/security/loopback.ts";
import { startDesktop, type DesktopApplication } from "../src/application.ts";
import { modelPort } from "../../../packages/agentloop-local-runtime/tests/fixtures/models.ts";
import { fixtureAuth, fixturePrincipal } from "./fixtures/auth.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

test("Desktop uses the standalone cloud service for registration, login, revocation, account isolation and restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-cloud-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cloudDb = new SqliteConnection(join(root, "accounts.db")); const identity = new IdentityService(cloudDb); await identity.ready();
  const cloud = createAccountServer(identity); cloud.listen(0, "127.0.0.1"); await once(cloud, "listening");
  const address = cloud.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { await new Promise<void>(resolve => { cloud.close(() => resolve()); cloud.closeAllConnections(); }); await cloudDb.close(); });
  const issued: CloudSession[] = [];
  class ObservedAuth extends CloudAccountAuth {
    override async authenticate(mode: "login" | "register", email: string, password: string) {
      const session = await super.authenticate(mode, email, password); issued.push(session); return session;
    }
  }
  const skills = join(root, "skills"); await mkdir(skills);
  const dataDirectory = join(root, "desktop-data");
  const options = { mode: "development" as const, dataDirectory, models: modelPort(), bundledSkillDirectories: [skills],
    openBrowser: false, cloudAuth: new ObservedAuth(`http://127.0.0.1:${address.port}`) };
  let app: DesktopApplication = await startDesktop(options);
  t.after(async () => { if (!app.existing) await app.close(); });
  let origin = app.origin;
  const call = (path: string, auth?: { cookie: string; csrf: string }, body?: unknown, csrf = true) => fetch(origin + path, {
    method: body === undefined ? "GET" : "POST", headers: { ...(auth ? { Cookie: auth.cookie } : {}),
      ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", ...(csrf && auth ? { "X-Desktop-CSRF": auth.csrf } : {}) }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const credentials = { email: "alice@example.test", password: "synthetic-alice-password-123" };
  async function login(mode: "login" | "register", input = credentials) {
    const response = await call(`/api/auth/${mode}`, undefined, input); const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.mode, "cloud"); assert.equal(body.user.email, input.email);
    assert.equal("token" in body, false); assert.equal("cloudToken" in body, false);
    const setCookie = response.headers.get("set-cookie")!; assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    return { cookie: setCookie.split(";")[0]!, csrf: body.csrfToken as string, accountId: body.accountId as string };
  }
  assert.equal((await call("/api/models")).status, 401);
  assert.equal((await call("/api/dev/session", undefined, {})).status, 404);
  for (const page of ["/login", "/register", "/login.js", "/login.css"]) assert.equal((await call(page)).status, 200);
  const alice = await login("register");
  assert.equal((await call("/api/auth/login", alice, credentials)).status, 409, "an active session cannot be silently switched");
  assert.equal((await call("/api/auth/logout", alice, {}, false)).status, 403);
  const forged = await call("/api/runs", alice, { requestId: "forged", input: "你好", modelKey: "local:test", ownerUserId: "someone-else" });
  assert.equal(forged.status, 400);
  const created = await call("/api/runs", alice, { requestId: "alice-run", input: "你好", modelKey: "local:test" });
  assert.equal(created.status, 200); const { run } = await created.json();
  let completed = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await call(`/api/runs/${run.id}`, alice); const current = (await response.json()).run;
    if (current.status !== "running") { assert.equal(current.status, "completed"); completed = true; break; } await setTimeout(10);
  }
  assert.equal(completed, true);
  const logout = await call("/api/auth/logout", alice, {}); assert.deepEqual(await logout.json(), { loggedOut: true, cloudRevoked: true });
  assert.equal((await call("/api/conversations", alice)).status, 401);
  await assert.rejects(options.cloudAuth.current(issued[0]!.token), /session_invalid/);
  const bob = await login("register", { email: "bob@example.test", password: "synthetic-bob-password-123" });
  assert.notEqual(bob.accountId, alice.accountId);
  assert.deepEqual((await (await call("/api/conversations", bob)).json()).conversations, []);
  assert.equal((await call(`/api/runs/${run.id}`, bob)).status, 404);
  assert.equal((await call(`/api/runs/${run.id}/events`, bob)).status, 404);
  assert.equal((await call(`/api/runs/${run.id}/artifacts`, bob)).status, 404);
  assert.equal((await call(`/api/conversations/${run.conversationId}`, bob)).status, 404);
  assert.equal((await call("/api/auth/logout", bob, {})).status, 200);
  const wrong = await call("/api/auth/login", undefined, { ...credentials, password: "wrong-password" });
  assert.equal(wrong.status, 401); assert.deepEqual(await wrong.json(), { error: "invalid_credentials" });
  const duplicate = await call("/api/auth/register", undefined, credentials); assert.equal(duplicate.status, 409);
  const again = await login("login"); assert.equal(again.accountId, alice.accountId);
  assert.equal((await (await call("/api/conversations", again)).json()).conversations[0].id, run.conversationId);
  // Cloud-side logout/expiry invalidates a local capability on explicit session
  // refresh, and at most 60 seconds later on regular business requests.
  await identity.revoke(`Bearer ${issued.at(-1)!.token}`);
  assert.equal((await call("/api/session", again)).status, 401);
  assert.equal((await call("/api/models", again)).status, 401);
  assert.equal(app.existing, false); if (!app.existing) await app.close();
  app = await startDesktop(options); origin = app.origin;
  assert.equal((await call("/api/conversations", alice)).status, 401);
  const afterRestart = await login("login"); assert.equal(afterRestart.accountId, alice.accountId);
  assert.equal((await (await call("/api/conversations", afterRestart)).json()).conversations[0].id, run.conversationId);
  assert.equal(app.existing, false); if (!app.existing) await app.close();
  const secrets = [...issued.map(session => session.token), credentials.password, "synthetic-bob-password-123"];
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); if (entry.isDirectory()) await scan(path);
      else { const bytes = await readFile(path); for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `auth secret persisted in ${entry.name}`); }
    }
  }
  await scan(dataDirectory);
});

test("missing or unavailable cloud authentication never falls back to a development identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-no-auth-")); const skills = join(root, "skills"); await mkdir(skills);
  const app = await startDesktop({ mode: "development", dataDirectory: join(root, "data"), models: modelPort(), openBrowser: false, bundledSkillDirectories: [skills] });
  t.after(async () => { if (!app.existing) await app.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await (await fetch(app.origin + "/api/auth/config")).json(), { configured: false });
  const response = await fetch(app.origin + "/api/auth/login", { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "test@example.test", password: "fixture-password" }) });
  assert.equal(response.status, 503); assert.equal(response.headers.has("set-cookie"), false);
  assert.equal((await fetch(app.origin + "/api/conversations")).status, 401);
});

test("cloud revocation, identity mutation and outages respect the local session boundary", async () => {
  let now = 0; const sessions = new AccountSessions(() => now), cloud = fixtureAuth();
  const response = { setHeader() {} } as unknown as ServerResponse;
  const granted = sessions.issue(response, cloud.issuer, { token: "synthetic", principal: fixturePrincipal, expiresAt: 100_000_000 });
  const request = { headers: { cookie: `${sessions.cookieName}=${granted.token}` } } as IncomingMessage;
  let checks = 0;
  cloud.current = async () => { checks++; throw new HttpError(503, "cloud_auth_unavailable"); };
  await sessions.verify(granted, cloud); assert.equal(checks, 0);
  now = 60_001; await assert.rejects(sessions.verify(granted, cloud), /cloud_auth_unavailable/);
  assert.equal(sessions.require(request, false), granted, "outage blocks operations without inventing success or deleting the local grant");
  cloud.current = async () => ({ ...fixturePrincipal, userId: "other-account" });
  await assert.rejects(sessions.verify(granted, cloud), /session_invalid/);
  assert.throws(() => sessions.require(request, false), /session_required/);
});
