import assert from "node:assert/strict";
import test from "node:test";
import { hashAdminPassword, PasswordAuthorization } from "../src/authorization/password-authorization.ts";

test("password Admin login issues an expiring opaque session and never accepts the password as a token", async () => {
  const authorization = new PasswordAuthorization({ username: "admin", passwordHash: hashAdminPassword("correct horse battery staple"), actorId: "admin-1", role: "platform_admin", sessionTtlMs: 60_000 });
  assert.equal(await authorization.login("admin", "wrong password"), undefined);
  const session = await authorization.login("admin", "correct horse battery staple");
  assert.ok(session?.accessToken.startsWith("adm_"));
  assert.deepEqual(await authorization.adminPrincipal(`Bearer ${session!.accessToken}`), { actorId: "admin-1", role: "platform_admin" });
  assert.equal(await authorization.adminPrincipal("Bearer correct horse battery staple"), undefined);
});
