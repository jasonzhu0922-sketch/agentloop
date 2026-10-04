import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AdminMember, RuntimeInventoryEntry, RuntimeInventoryPage, RuntimeOperationResult, RuntimeTarget } from "../../control-plane/contracts/index.ts";
import type { AdminAuditPort, AdminCatalogPort, AdminIdentityPort, AdminTracePort, RuntimeInventoryPort, RuntimeOperationPort } from "../src/application/admin-ports.ts";
import type { AdminAuthorizationPort, AdminPrincipal, WorkloadPrincipal } from "../src/authorization/ports.ts";
import { createAdminApiServer } from "../src/bootstrap/server.ts";

const target: RuntimeTarget = { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" };

class Authorization implements AdminAuthorizationPort {
  public async adminPrincipal(value: string | undefined): Promise<AdminPrincipal | undefined> { return value === "Bearer admin" ? { actorId: "admin-a", role: "platform_admin", scopeId: "platform" } : undefined; }
  public async workloadPrincipal(_value: string | undefined): Promise<WorkloadPrincipal | undefined> { return undefined; }
}

test("Admin management routes keep ordinary user tokens out and retain expected revision/audit operation facts", async () => {
  const member: AdminMember = { contractVersion: "control-plane/v1", memberId: "member-a", scopeId: "tenant-a", subject: "subject-a", displayName: "Member A", role: "operator", status: "active", revision: 1, createdAt: 1, updatedAt: 1 };
  const identity: AdminIdentityPort = {
    listMembers: async (scopeId) => { assert.equal(scopeId, "tenant-a"); return [member]; },
    createMember: async (value, revision, actorId, auditEventId) => { assert.equal(revision, 0); assert.equal(actorId, "admin-a"); assert.equal(auditEventId, "member-create"); return value; },
    transitionMember: async (memberId, status, revision, actorId, auditEventId) => { assert.equal(memberId, "member-a"); assert.equal(status, "suspended"); assert.equal(revision, 1); assert.equal(actorId, "admin-a"); assert.equal(auditEventId, "member-transition"); return { ...member, status, revision: 2, updatedAt: 2 }; },
  };
  const trace: AdminTracePort = { trace: async (runId) => ({ contractVersion: "control-plane/v1", runId, facts: [{ source: "router", kind: "run", ref: runId }], missingBoundaries: [{ source: "runtime", reason: "not_recorded" }] }) };
  const audit: AdminAuditPort = { listAuditEvents: async (limit) => [{ eventId: "audit-a", actorId: "admin-a", action: "runtime.drain", resourceId: `limit:${limit}`, createdAt: 1 }] };
  const catalog: AdminCatalogPort = {
    listResources: async () => [{ resourceId: "resource-a", kind: "skill", revision: 3 }],
    listReleases: async (kind) => { assert.equal(kind, "skill"); return []; },
  };
  const operations: RuntimeOperationPort = {
    drain: async (input) => result(input.target, "drain", input.expectedRevision),
    recover: async (input) => result(input.target, "recover", input.expectedRevision),
    restart: async (input) => result(input.target, "restart", input.expectedRevision),
  };
  const runtimeInventory: RuntimeInventoryPort = { list: async (input) => { assert.equal(input.scopeId, undefined); return runtimePage; } };
  const server = createAdminApiServer({ authorization: new Authorization(), identity, trace, audit, catalog, runtimeInventory, runtimeOperations: operations, releases: {} as never });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${baseUrl}/admin/v1/members?scopeId=tenant-a`, { headers: { authorization: "Bearer user" } })).status, 403);
    const members = await fetch(`${baseUrl}/admin/v1/members?scopeId=tenant-a`, { headers: { authorization: "Bearer admin" } });
    assert.deepEqual((await members.json() as { members: readonly AdminMember[] }).members, [member]);
    assert.deepEqual(await (await fetch(`${baseUrl}/admin/v1/session`, { headers: { authorization: "Bearer admin" } })).json(), {
      actorId: "admin-a", role: "platform_admin", permissions: ["audit.read", "member.read", "member.write", "release.read", "release.write", "runtime.operate", "skill.read", "skill.write", "trace.read", "user.read", "user.write"],
    });
    assert.deepEqual(await (await fetch(`${baseUrl}/admin/v1/resources`, { headers: { authorization: "Bearer admin" } })).json(), {
      resources: [{ resourceId: "resource-a", kind: "skill", revision: 3 }],
    });
    assert.deepEqual(await (await fetch(`${baseUrl}/admin/v1/runtimes`, { headers: { authorization: "Bearer admin" } })).json(), runtimePage);
    assert.equal((await fetch(`${baseUrl}/admin/v1/runtimes`, { headers: { authorization: "Bearer user" } })).status, 403);
    assert.deepEqual((await (await fetch(`${baseUrl}/admin/v1/releases?kind=skill`, { headers: { authorization: "Bearer admin" } })).json() as { releases: unknown[] }).releases, []);
    const traceResponse = await fetch(`${baseUrl}/admin/v1/runs/run-a/trace`, { headers: { authorization: "Bearer admin" } });
    assert.deepEqual((await traceResponse.json() as { missingBoundaries: unknown }).missingBoundaries, [{ source: "runtime", reason: "not_recorded" }]);
    const operation = await fetch(`${baseUrl}/admin/v1/runtimes/runtime-a/drain`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "runtime-drain" }, body: JSON.stringify({ target, expectedRevision: 7 }) });
    assert.deepEqual(await operation.json(), result(target, "drain", 7));
    const localOperation = await fetch(`${baseUrl}/admin/v1/runtimes/runtime-a/restart`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "runtime-local-restart" }, body: JSON.stringify({ target: { ...target, plane: "local", runtimeId: "runtime-a" }, expectedRevision: 7 }) });
    assert.equal(localOperation.status, 403);
    assert.equal((await fetch(`${baseUrl}/admin/v1/runtimes/runtime-other/drain`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "runtime-bad" }, body: JSON.stringify({ target, expectedRevision: 7 }) })).status, 400);
    const transition = await fetch(`${baseUrl}/admin/v1/members/member-a/transitions`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "member-transition" }, body: JSON.stringify({ status: "suspended", expectedRevision: 1 }) });
    assert.equal((await transition.json() as AdminMember).revision, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

function result(value: RuntimeTarget, operation: "drain" | "recover" | "restart", revision: number): RuntimeOperationResult {
  return { contractVersion: "control-plane/v1", runtimeId: value.runtimeId, target: value, operation, state: operation === "drain" ? "draining" : operation === "restart" ? "restarting" : "ready", revision: revision + 1, observedAt: 100 };
}

const runtimeEntry: RuntimeInventoryEntry = {
  id: "runtime-a", displayName: "Cloud Runtime A", plane: "cloud", profile: "general", status: "ready",
  capabilities: ["shell"], maxConcurrentRuns: 4, activeRunCount: 1, queuedRunCount: 0, startedAt: 100, lastHeartbeatAt: 100,
};
const runtimePage: RuntimeInventoryPage = { items: [runtimeEntry], page: 1, pageSize: 20, total: 1, pageCount: 1 };
