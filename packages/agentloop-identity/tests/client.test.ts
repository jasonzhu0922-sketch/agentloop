import assert from "node:assert/strict";
import test from "node:test";
import { SqliteConnection } from "@zhujun/agentloop";
import { AccountServiceClient, authBaseUrl, IdentityError, IdentityService, localAccountId, migrateIdentityRows, clearLegacyIdentityRows } from "@zhujun/agentloop-identity";

test("account egress is HTTPS or loopback and account scopes include issuer, tenant and user", () => {
  assert.equal(authBaseUrl("https://accounts.example.test/"), "https://accounts.example.test");
  assert.equal(authBaseUrl("http://127.0.0.1:8795"), "http://127.0.0.1:8795");
  for (const url of ["http://accounts.example.test", "https://user:pass@example.test", "https://example.test?token=secret", "https://example.test/#secret", "file:///etc/passwd"]) assert.throws(() => authBaseUrl(url));
  const user = { userId: "user-a", tenantId: "tenant-a", email: "a@example.test" };
  const id = localAccountId("https://accounts.example.test", user);
  assert.equal(localAccountId("https://accounts.example.test", { ...user, email: "changed@example.test" }), id);
  assert.notEqual(localAccountId("https://other.example.test", user), id);
  assert.notEqual(localAccountId("https://accounts.example.test", { ...user, tenantId: "tenant-b" }), id);
  assert.notEqual(localAccountId("https://accounts.example.test", { ...user, userId: "user-b" }), id);
});

test("identity client never follows redirects or reflects untrusted upstream messages", async t => {
  const client = new AccountServiceClient("https://accounts.example.test");
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    assert.equal(init?.redirect, "error");
    return Response.json({ error: "secret=do-not-reflect" }, { status: 500 });
  });
  await assert.rejects(client.current("synthetic-token"), error => error instanceof IdentityError && error.code === "cloud_auth_unavailable" && !error.message.includes("secret"));
});

test("invalid, expired or oversized cloud session envelopes are rejected", async t => {
  const client = new AccountServiceClient("https://accounts.example.test");
  for (const body of [{ token: "short", expiresAt: Date.now() + 1000 }, { token: "x".repeat(43), expiresAt: 1 }, { token: "x".repeat(43), expiresAt: Date.now() + 10000, user: { id: "x", email: "a@example.test" }, tenant: { id: "bad\nheader" } }]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(client.authenticate("login", "a@example.test", "fixture-password"), /cloud_auth_response_invalid/); mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(20000)));
  await assert.rejects(client.current("synthetic-token"), /cloud_auth_response_invalid/);
});

test("legacy Router identity rows migrate into the single Account Service authority", async t => {
  const source = new SqliteConnection(":memory:"), destination = new SqliteConnection(":memory:");
  t.after(async () => { await source.close(); await destination.close(); });
  const legacy = new IdentityService(source); await legacy.ready();
  const session = await legacy.register("migrate@example.test", "fixture-migration-password", "迁移昵称");
  const result = await migrateIdentityRows(source, destination);
  assert.equal(result.users, 1); assert.equal(result.tenants, 1); assert.equal(result.memberships, 1); assert.equal(result.sessions, 1);
  const repeated = await migrateIdentityRows(source, destination);
  assert.deepEqual(repeated.userIdMap, result.userIdMap);
  assert.deepEqual(repeated.tenantIdMap, result.tenantIdMap);
  const unified = new IdentityService(destination); assert.deepEqual(await unified.authenticate(`Bearer ${session.token}`), session.principal);
  const sourceTables = await source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mr_identity_%'").all();
  assert.equal(sourceTables.length, 5, "migration never deletes the legacy source");
});

test("legacy email conflicts reuse the Account Service user and rewrite session ownership", async t => {
  const source = new SqliteConnection(":memory:"), destination = new SqliteConnection(":memory:");
  t.after(async () => { await source.close(); await destination.close(); });
  const sourceIdentity = new IdentityService(source); await sourceIdentity.ready();
  const destinationIdentity = new IdentityService(destination); await destinationIdentity.ready();
  const sourceSession = await sourceIdentity.register("conflict@example.test", "source-fixture-password");
  const destinationSession = await destinationIdentity.register("conflict@example.test", "destination-fixture-password");
  const result = await migrateIdentityRows(source, destination);
  assert.equal(result.userIdMap[sourceSession.principal.userId], destinationSession.principal.userId);
  assert.equal(result.tenantIdMap[sourceSession.principal.tenantId], destinationSession.principal.tenantId);
  assert.equal((await destination.prepare("SELECT COUNT(*) AS count FROM mr_identity_users").get<{ count: number }>())?.count, 1);
  assert.deepEqual(await destinationIdentity.authenticate(`Bearer ${sourceSession.token}`), destinationSession.principal);
});

test("existing accounts without profiles upgrade without changing identity or invalidating sessions", async t => {
  const database = new SqliteConnection(":memory:");
  t.after(() => database.close());
  const identity = new IdentityService(database);
  const session = await identity.register("existing@example.test", "fixture-existing-password");
  // Reproduce the previous account schema with a live account and session.
  await database.exec("DROP TABLE mr_identity_profiles");
  await identity.ready();
  assert.deepEqual(await identity.authenticate(`Bearer ${session.token}`), session.principal);
  assert.deepEqual((await identity.login("existing@example.test", "fixture-existing-password")).principal, session.principal);
});

test("pre-profile Router accounts migrate and retire without modifying the source schema", async t => {
  const source = new SqliteConnection(":memory:"), destination = new SqliteConnection(":memory:");
  t.after(async () => { await source.close(); await destination.close(); });
  const session = await new IdentityService(source).register("old-router@example.test", "fixture-legacy-password");
  await source.exec("DROP TABLE mr_identity_profiles");
  await migrateIdentityRows(source, destination);
  assert.deepEqual(await new IdentityService(destination).authenticate(`Bearer ${session.token}`), session.principal);
  assert.equal(await source.prepare("SELECT name FROM sqlite_master WHERE name = 'mr_identity_profiles'").get(), undefined);
  await clearLegacyIdentityRows(source);
  assert.deepEqual(await source.prepare("SELECT * FROM mr_identity_users").all(), []);
});
