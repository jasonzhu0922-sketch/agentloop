import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import type { AdminAuthorizationPort, AdminPrincipal, WorkloadPrincipal } from "../src/authorization/ports.ts";
import { createAdminApiServer } from "../src/bootstrap/server.ts";
import { contentHashForRelease, ReleaseApplicationService } from "../src/application/release-service.ts";
import type { IntegrationDeliveryPort, RuntimeConfigurationSnapshotPort } from "../src/transport/admin-http/handler.ts";
import { migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";

class TestAuthorization implements AdminAuthorizationPort {
  public async adminPrincipal(value: string | undefined): Promise<AdminPrincipal | undefined> {
    return value === "Bearer admin" ? { actorId: "admin-1", role: "platform_admin" } : undefined;
  }

  public async workloadPrincipal(value: string | undefined): Promise<WorkloadPrincipal | undefined> {
    return value === "Bearer workload" ? { actorId: "workload:runtime-a", target: { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a", runtimeClass: "standard" } } : undefined;
  }
}

test("Admin HTTP requires its own principal before forwarding a versioned release command", async () => {
  const database = new AppDatabase(":memory:");
  await migrateControlPlane(database);
  const releases = new ReleaseApplicationService(new SqlControlPlaneStore(database));
  const server = createAdminApiServer({ authorization: new TestAuthorization(), releases });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    const content = { kind: "policy", schemaVersion: "policy/v1", payload: { safe: true } } as const;
    const body = {
      expectedRevision: 0,
      release: {
        contractVersion: "control-plane/v1", resourceId: "resource-http", releaseId: "release-http", version: 1,
        ...content, contentHash: contentHashForRelease(content), authorId: "ignored-client-actor", createdAt: 1, state: "draft",
      },
    };
    assert.equal((await fetch(`${baseUrl}/admin/v1/releases`, {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": "audit-denied" }, body: JSON.stringify(body),
    })).status, 403);
    const created = await fetch(`${baseUrl}/admin/v1/releases`, {
      method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "audit-created" }, body: JSON.stringify(body),
    });
    assert.equal(created.status, 201);
    const actor = await database.prepare("SELECT actor_id FROM cp_audit_events WHERE id = ?").get<{ actor_id: string }>("audit-created");
    assert.equal(actor?.actor_id, "admin-1");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await database.close();
  }
});

test("delivery target is derived solely from workload identity", async () => {
  let resolvedTarget: WorkloadPrincipal["target"] | undefined;
  const snapshots = {
    desiredSnapshot: async (target: WorkloadPrincipal["target"]) => {
      resolvedTarget = target;
      return {
        contractVersion: "control-plane/v1" as const, snapshotId: "snapshot-a", configurationRevision: 1, target,
        resolvedAt: 10, validUntil: 20, integrations: [], skills: [], policies: [],
      };
    },
  } satisfies RuntimeConfigurationSnapshotPort;
  const server = createAdminApiServer({ authorization: new TestAuthorization(), snapshots });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${baseUrl}/delivery/v1/desired-configuration?scopeId=attacker`)).status, 403);
    const response = await fetch(`${baseUrl}/delivery/v1/desired-configuration?scopeId=attacker`, { headers: { authorization: "Bearer workload" } });
    assert.equal(response.status, 200);
    assert.deepEqual(resolvedTarget, { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a", runtimeClass: "standard" });
    assert.deepEqual((await response.json() as { target: WorkloadPrincipal["target"] }).target, resolvedTarget);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("integration delivery endpoints derive workload target and never accept a caller-supplied target", async () => {
  const requests: unknown[] = [];
  const integrations: IntegrationDeliveryPort = {
    requestGrant: async (target, request) => {
      requests.push({ target, request });
      return { contractVersion: "control-plane/v1", grantId: "grant-a", invocationId: request.invocationId, bindingId: request.bindingId, releaseId: request.releaseId, contentHash: request.contentHash, secretReferenceVersion: "version-a", expiresAt: 2_000 };
    },
    invoke: async (target, request) => {
      requests.push({ target, request });
      return { result: { queries: [] }, receipt: { contractVersion: "control-plane/v1", receiptId: "receipt-a", invocationId: request.invocation.invocationId, bindingId: request.invocation.bindingId, releaseId: request.invocation.releaseId, contentHash: request.invocation.contentHash, secretReferenceVersion: "version-a", status: "completed", observedAt: 1_000 } };
    },
  };
  const server = createAdminApiServer({ authorization: new TestAuthorization(), integrations });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const invocation = {
      contractVersion: "control-plane/v1", invocationId: "invocation-a", runId: "run-a", integration: "enterprise_info", action: "search",
      bindingId: "binding-a", releaseId: "release-a", contentHash: "a".repeat(64), skillNames: ["enterprise-info"], requestedAt: 1_000,
    };
    assert.equal((await fetch(`${baseUrl}/delivery/v1/credential-grants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: invocation }) })).status, 403);
    const grant = await fetch(`${baseUrl}/delivery/v1/credential-grants`, { method: "POST", headers: { authorization: "Bearer workload", "content-type": "application/json" }, body: JSON.stringify({ request: { ...invocation, target: { scopeId: "attacker" } } }) });
    assert.equal(grant.status, 201);
    assert.equal((await fetch(`${baseUrl}/delivery/v1/integration-invocations`, { method: "POST", headers: { authorization: "Bearer workload", "content-type": "application/json" }, body: JSON.stringify({ request: { contractVersion: "control-plane/v1", grantId: "grant-a", invocation, args: {} } }) })).status, 200);
    assert.deepEqual((requests[0] as { target: WorkloadPrincipal["target"] }).target, { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a", runtimeClass: "standard" });
    assert.deepEqual((requests[1] as { target: WorkloadPrincipal["target"] }).target, { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a", runtimeClass: "standard" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("Skill artifact download and install receipt endpoints are workload-targeted and persisted", async () => {
  const database = new AppDatabase(":memory:");
  await migrateControlPlane(database);
  const releases = new ReleaseApplicationService(new SqlControlPlaneStore(database));
  const packageHash = "c".repeat(64);
  const content = { kind: "skill", schemaVersion: "skill/v1", payload: { packageHash } } as const;
  await releases.publish({
    expectedRevision: 0, actorId: "admin-1", auditEventId: "skill-publish",
    release: { contractVersion: "control-plane/v1", resourceId: "skill-resource", releaseId: "skill-release", version: 1, ...content, contentHash: contentHashForRelease(content), authorId: "admin-1", createdAt: 1, state: "draft" },
  });
  await releases.transition({ releaseId: "skill-release", state: "validated", expectedRevision: 1, actorId: "admin-1", auditEventId: "skill-validated" });
  await releases.transition({ releaseId: "skill-release", state: "observe", expectedRevision: 2, actorId: "admin-1", auditEventId: "skill-observe" });
  await releases.transition({ releaseId: "skill-release", state: "active", expectedRevision: 3, actorId: "admin-1", auditEventId: "skill-active" });
  await database.prepare("INSERT INTO cp_skill_artifacts(release_id, package_uri, package_hash, signer, compatibility_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("skill-release", "https://artifacts.example.test/skill.tgz", packageHash, "platform-signer", JSON.stringify({ signature: "sig", signatureAlgorithm: "ed25519" }), 1);
  const server = createAdminApiServer({
    authorization: new TestAuthorization(), releases,
    skillArtifacts: { download: async (target, requestedHash) => { assert.equal(target.scopeId, "tenant-a"); assert.equal(requestedHash, packageHash); return { bytes: new TextEncoder().encode("skill-package") }; } },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${baseUrl}/delivery/v1/skill-artifacts/${packageHash}`)).status, 403);
    const artifact = await fetch(`${baseUrl}/delivery/v1/skill-artifacts/${packageHash}`, { headers: { authorization: "Bearer workload" } });
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), "skill-package");
    const receipt = {
      contractVersion: "control-plane/v1", receiptId: "skill-receipt-a", target: { plane: "cloud", scopeId: "attacker", runtimeId: "runtime-a", runtimeClass: "standard" }, releaseId: "skill-release", packageHash, signer: "platform-signer", status: "loaded", observedAt: 2_000,
    } as const;
    assert.equal((await fetch(`${baseUrl}/delivery/v1/skill-install-receipts`, { method: "POST", headers: { authorization: "Bearer workload", "content-type": "application/json", "x-request-id": "skill-receipt-audit" }, body: JSON.stringify({ receipt }) })).status, 403);
    const accepted = await fetch(`${baseUrl}/delivery/v1/skill-install-receipts`, { method: "POST", headers: { authorization: "Bearer workload", "content-type": "application/json", "x-request-id": "skill-receipt-audit" }, body: JSON.stringify({ receipt: { ...receipt, target: { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a", runtimeClass: "standard" } } }) });
    assert.equal(accepted.status, 201);
    const stored = await database.prepare("SELECT package_hash, signer, status FROM cp_skill_install_receipts WHERE id = ?").get<{ package_hash: string; signer: string; status: string }>("skill-receipt-a");
    assert.deepEqual({ ...stored }, { package_hash: packageHash, signer: "platform-signer", status: "loaded" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await database.close();
  }
});
