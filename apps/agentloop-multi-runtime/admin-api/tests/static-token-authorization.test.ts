import assert from "node:assert/strict";
import test from "node:test";
import { StaticTokenAuthorization } from "../src/authorization/static-token-authorization.ts";

test("static Admin bootstrap authorization is explicit and never authorizes workload delivery", async () => {
  const authorization = new StaticTokenAuthorization({ token: "local-bootstrap-token-123", actorId: "admin-local", scopeId: "platform" });
  assert.deepEqual(await authorization.adminPrincipal("Bearer local-bootstrap-token-123"), { actorId: "admin-local", role: "platform_admin", scopeId: "platform" });
  assert.equal(await authorization.adminPrincipal("Bearer ordinary-user"), undefined);
  assert.equal(await authorization.workloadPrincipal("Bearer local-bootstrap-token-123"), undefined);
  const skillOperator = new StaticTokenAuthorization({ token: "skill-operator-token-123", actorId: "skill-operator", role: "skill_operator" });
  assert.equal((await skillOperator.adminPrincipal("Bearer skill-operator-token-123"))?.role, "skill_operator");
  assert.throws(() => new StaticTokenAuthorization({ token: "short", actorId: "admin-local" }), /at least 16/);
});
