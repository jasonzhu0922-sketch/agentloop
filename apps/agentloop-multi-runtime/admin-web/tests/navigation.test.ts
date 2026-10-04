import assert from "node:assert/strict";
import test from "node:test";
import { visibleNavigation, hasPermission } from "../src/app/navigation.ts";
import type { AdminPermission, AdminSession } from "../src/shared/api/admin-api-client.ts";

const session = (permissions: readonly AdminPermission[]): AdminSession => ({ actorId: "admin", role: "auditor", permissions });

test("Admin Web renders only modules granted by the Admin session", () => {
  assert.deepEqual(visibleNavigation(session(["release.read", "audit.read"])).map((item) => item.id), ["overview", "models", "audit", "settings"]);
  assert.deepEqual(visibleNavigation(session(["skill.read"])).map((item) => item.id), ["overview", "skills", "settings"]);
});

test("UI permission checks distinguish read and write operations", () => {
  const readOnly = session(["release.read"]);
  assert.equal(hasPermission(readOnly, "release.read"), true);
  assert.equal(hasPermission(readOnly, "release.write"), false);
  assert.equal(hasPermission(undefined, "audit.read"), false);
});

test("Admin user navigation is gated by user.read, not member.read", () => {
  assert.deepEqual(visibleNavigation(session(["user.read"])).map((item) => item.id), ["overview", "business-users", "settings"]);
  assert.deepEqual(visibleNavigation(session(["member.read"])).map((item) => item.id), ["overview", "settings"]);
});
