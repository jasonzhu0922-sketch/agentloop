import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseAdminAuthorization } from "../src/authorization/database-authorization.ts";
import { hashAdminPassword } from "../src/authorization/password-authorization.ts";
import type { AdminUserCredentialPort } from "../src/authorization/ports.ts";

test("database Admin authentication reads only active Admin users and records login projection", async () => {
  let observedLogin: { userId: string; observedAt: number } | undefined;
  const users: AdminUserCredentialPort = {
    findAdminUserCredential: async (username) => username === "ops" ? { userId: "admin-1", username, displayName: "Ops", role: "platform_admin", scopeId: "platform", status: "active", passwordHash: hashAdminPassword("a-secure-admin-password") } : undefined,
    recordAdminUserLogin: async (userId, observedAt) => { observedLogin = { userId, observedAt }; },
  };
  const authorization = new DatabaseAdminAuthorization({ users, sessionTtlMs: 60_000 });
  assert.equal(await authorization.login("ops", "wrong-password"), undefined);
  const session = await authorization.login("ops", "a-secure-admin-password");
  assert.ok(session?.accessToken.startsWith("adm_"));
  assert.deepEqual(await authorization.adminPrincipal(`Bearer ${session!.accessToken}`), { actorId: "admin-1", role: "platform_admin", scopeId: "platform" });
  assert.equal(observedLogin?.userId, "admin-1");
  assert.equal(typeof observedLogin?.observedAt, "number");
});

test("database Admin authentication rejects suspended users even with a valid password", async () => {
  const users: AdminUserCredentialPort = { findAdminUserCredential: async () => ({ userId: "admin-1", username: "ops", displayName: "Ops", role: "platform_admin", status: "suspended", passwordHash: hashAdminPassword("a-secure-admin-password") }) };
  const authorization = new DatabaseAdminAuthorization({ users });
  assert.equal(await authorization.login("ops", "a-secure-admin-password"), undefined);
});
