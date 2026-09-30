import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AdminMember, RuntimeOperationResult, RuntimeTarget } from "../../control-plane/contracts/index.ts";
import type { AdminAuditPort, AdminCatalogPort, AdminIdentityPort, AdminTracePort, RuntimeOperationPort } from "../src/application/admin-ports.ts";
import type { AdminAuthorizationPort, AdminPrincipal, WorkloadPrincipal } from "../src/authorization/ports.ts";
import { createAdminApiServer } from "../src/bootstrap/server.ts";

const target: RuntimeTarget = { plane: "cloud", tenantId: "tenant-a", runtimeId: "runtime-a" };

class Authorization implements AdminAuthorizationPort {
  public async adminPrincipal(value: string | undefined): Promise<AdminPrincipal | undefined> { return value === "Bearer admin" ? { actorId: "admin-a" } : undefined; }
  public async workloadPrincipal(_value: string | undefined): Promise<WorkloadPrincipal | undefined> { return undefined; }
}

test("Admin management routes keep ordinary user tokens out and retain expected revision/audit operation facts", async () => {
  const member: AdminMember = { contractVersion: "control-plane/v1", memberId: "member-a", tenantId: "tenant-a", subject: "subject-a", displayName: "Member A", role: "operator", status: "active", revision: 1, createdAt: 1, updatedAt: 1 };
  const identity: AdminIdentityPort = {
    listMembers: async (tenantId) => { assert.equal(tenantId, "tenant-a"); return [member]; },
    createMember: async (value, revision, actorId, auditEventId) => { assert.equal(revision, 0); assert.equal(actorId, "admin-a"); assert.equal(auditEventId, "member-create"); return value; },
    transitionMember: async (memberId, status, revision, actorId, auditEventId) => { assert.equal(memberId, "member-a"); assert.equal(status, "suspended"); assert.equal(revision, 1); assert.equal(actorId, "admin-a"); assert.equal(auditEventId, "member-transition"); return { ...member, status, revision: 2, updatedAt: 2 }; },
  };
  const trace: AdminTracePort = { trace: async (runId) => ({ contractVersion: "control-plane/v1", runId, facts: [{ source: "router", kind: "run", ref: runId }], missingBoundaries: [{ source: "runtime", reason: "not_recorded" }] }) };
  const audit: AdminAuditPort = { listAuditEvents: async (limit) => [{ eventId: "audit-a", actorId: "admin-a", action: "runtime.drain", resourceId: `limit:${limit}`, createdAt: 1 }] };
  const catalog: AdminCatalogPort = { listReleases: async (kind) => { assert.equal(kind, "skill"); return []; } };
  const operations: RuntimeOperationPort = {
    drain: async (input) => result(input.target, "drain", input.expectedRevision),
    recover: async (input) => result(input.target, "recover", input.expectedRevision),
  };
  const server = createAdminApiServer({ authorization: new Authorization(), identity, trace, audit, catalog, runtimeOperations: operations, releases: {} as never });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${baseUrl}/admin/v1/members?tenantId=tenant-a`, { headers: { authorization: "Bearer user" } })).status, 403);
    const members = await fetch(`${baseUrl}/admin/v1/members?tenantId=tenant-a`, { headers: { authorization: "Bearer admin" } });
    assert.deepEqual((await members.json() as { members: readonly AdminMember[] }).members, [member]);
    assert.deepEqual((await (await fetch(`${baseUrl}/admin/v1/releases?kind=skill`, { headers: { authorization: "Bearer admin" } })).json() as { releases: unknown[] }).releases, []);
    const traceResponse = await fetch(`${baseUrl}/admin/v1/runs/run-a/trace`, { headers: { authorization: "Bearer admin" } });
    assert.deepEqual((await traceResponse.json() as { missingBoundaries: unknown }).missingBoundaries, [{ source: "runtime", reason: "not_recorded" }]);
    const operation = await fetch(`${baseUrl}/admin/v1/runtimes/runtime-a/drain`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "runtime-drain" }, body: JSON.stringify({ target, expectedRevision: 7 }) });
    assert.deepEqual(await operation.json(), result(target, "drain", 7));
    assert.equal((await fetch(`${baseUrl}/admin/v1/runtimes/runtime-other/drain`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "runtime-bad" }, body: JSON.stringify({ target, expectedRevision: 7 }) })).status, 400);
    const transition = await fetch(`${baseUrl}/admin/v1/members/member-a/transitions`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "member-transition" }, body: JSON.stringify({ status: "suspended", expectedRevision: 1 }) });
    assert.equal((await transition.json() as AdminMember).revision, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

function result(value: RuntimeTarget, operation: "drain" | "recover", revision: number): RuntimeOperationResult {
  return { contractVersion: "control-plane/v1", runtimeId: value.runtimeId, target: value, operation, state: operation === "drain" ? "draining" : "ready", revision: revision + 1, observedAt: 100 };
}
