import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import type { AdminAuthorizationPort, AdminPrincipal, WorkloadPrincipal } from "../src/authorization/ports.ts";
import { createAdminApiServer } from "../src/bootstrap/server.ts";
import { contentHashForRelease, ReleaseApplicationService } from "../src/application/release-service.ts";
import type { AdminTracePort, RuntimeOperationPort } from "../src/application/admin-ports.ts";
import { migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";
import { RuntimeConfigurationSnapshotService } from "../src/application/runtime-configuration-snapshot-service.ts";
import type { ResourceKind, ResourceRelease, RuntimeTarget, TargetAssignment, RuntimeTrace, RuntimeOperationResult } from "../../control-plane/contracts/index.ts";
import { RuntimeConfigurationClient } from "../../src/runtime-host/application/configuration/runtime-configuration-client.ts";
import { LocalDeliveryClient } from "../../local-agent-runtime/src/control-plane/local-delivery-client.ts";

const cloud: RuntimeTarget = { plane: "cloud", tenantId: "tenant-a", runtimeId: "runtime-cloud", runtimeClass: "standard" };
const local: RuntimeTarget = { plane: "local", tenantId: "tenant-a", runtimeId: "runtime-local", runtimeClass: "standard", deviceId: "device-a" };
const packageHash = "d".repeat(64);
let nextCreatedAt = 100;

class AcceptanceAuthorization implements AdminAuthorizationPort {
  public async adminPrincipal(value: string | undefined): Promise<AdminPrincipal | undefined> {
    return value === "Bearer admin" ? { actorId: "admin-acceptance", tenantId: "tenant-a" } : undefined;
  }

  public async workloadPrincipal(value: string | undefined): Promise<WorkloadPrincipal | undefined> {
    if (value === "Bearer cloud") return { actorId: "workload:cloud", target: cloud };
    if (value === "Bearer local") return { actorId: "workload:local", target: local };
    return undefined;
  }
}

test("admin closure: releases resolve to Cloud/Local snapshots, receipts, Skill load, trace, operations, and audit", async () => {
  const database = new AppDatabase(":memory:");
  await migrateControlPlane(database);
  const store = new SqlControlPlaneStore(database);
  const releases = new ReleaseApplicationService(store);
  await publishActive(releases, "model-resource", "model-old", "model_route", {
    schemaVersion: "model-route/v1", providerConfiguration: providerConfiguration("old-model"),
  });
  await publishActive(releases, "integration-resource", "integration-release", "integration", {
    schemaVersion: "integration/v1", integration: "enterprise_info", allowedActions: ["search", "detail"],
  });
  await publishActive(releases, "skill-resource", "skill-release", "skill", { schemaVersion: "skill/v1", packageHash });
  await publishActive(releases, "policy-resource", "policy-release", "policy", {
    schemaVersion: "policy/v1", policy: { stepExecutionStrategy: { schema: "agentloop.stepExecutionStrategyConfig/v1", profile: "action-aware" }, planTemplates: [{ id: "template-a" }] },
  });
  await database.prepare("INSERT INTO cp_skill_artifacts(release_id, package_uri, package_hash, signer, compatibility_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("skill-release", "https://artifacts.example.test/skill.tgz", packageHash, "platform-signer", JSON.stringify({ signature: "signature-bytes", signatureAlgorithm: "ed25519" }), 1);

  for (const [resourceId, releaseId] of [["model-resource", "model-old"], ["integration-resource", "integration-release"], ["skill-resource", "skill-release"], ["policy-resource", "policy-release"]] as const) {
    await releases.assign({
      expectedRevision: 4, actorId: "admin-acceptance", auditEventId: `assign-${releaseId}`,
      assignment: platformAssignment(resourceId, releaseId),
    });
  }

  const snapshots = new RuntimeConfigurationSnapshotService({ repository: store, now: () => 1_000, ttlMs: 60_000 });
  const trace: AdminTracePort = {
    trace: async (runId): Promise<RuntimeTrace> => ({ contractVersion: "control-plane/v1", runId, target: cloud,
      facts: [{ source: "router", kind: "run", ref: runId }, { source: "control_plane", kind: "admission_snapshot", ref: "snapshot-old" }],
      missingBoundaries: [{ source: "runtime", reason: "not_recorded" }] }),
  };
  const runtimeOperations: RuntimeOperationPort = {
    drain: async (input): Promise<RuntimeOperationResult> => operation(input.target, "drain", input.expectedRevision),
    recover: async (input): Promise<RuntimeOperationResult> => operation(input.target, "recover", input.expectedRevision),
  };
  const server = createAdminApiServer({ authorization: new AcceptanceAuthorization(), releases,
    snapshots, skillArtifacts: { download: async (target, requestedHash) => {
      assert.equal(target.tenantId, "tenant-a"); assert.equal(requestedHash, packageHash);
      return { bytes: new TextEncoder().encode("signed-skill-package"), contentType: "application/gzip" };
    } }, identity: store, audit: store, catalog: store, trace, runtimeOperations });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${baseUrl}/admin/v1/releases?kind=skill`, { headers: { authorization: "Bearer ordinary-user" } })).status, 403);

    const cloudClient = new RuntimeConfigurationClient({ deliveryUrl: baseUrl, workloadToken: "cloud", target: cloud, now: () => 1_100 });
    const oldCloudSnapshot = await cloudClient.desiredSnapshot();
    assert.equal(oldCloudSnapshot.modelRoute?.releaseId, "model-old");
    assert.equal(oldCloudSnapshot.skills[0]?.artifact?.signer, "platform-signer");
    assert.deepEqual(oldCloudSnapshot.policies[0]?.policy?.planTemplates, [{ id: "template-a" }]);
    assert.equal(new TextDecoder().decode(await cloudClient.downloadSkillArtifact(oldCloudSnapshot.skills[0]!.artifact!)), "signed-skill-package");
    await cloudClient.reportSkillInstallReceipt({ contractVersion: "control-plane/v1", receiptId: "cloud-skill-loaded", target: cloud, releaseId: "skill-release", packageHash, signer: "platform-signer", status: "loaded", observedAt: 1_101 });
    await cloudClient.reportLoaded(oldCloudSnapshot, (releaseId) => `cloud-loaded-${releaseId}`);

    const localClient = new LocalDeliveryClient({ deliveryUrl: baseUrl, deviceToken: "local", target: local, now: () => 1_200 });
    const localSnapshot = await localClient.desiredSnapshot();
    assert.equal(localSnapshot.modelRoute?.releaseId, "model-old");
    await localClient.reportLoaded(localSnapshot, (releaseId) => `local-loaded-${releaseId}`);
    await localClient.reportSkillInstallReceipt({ contractVersion: "control-plane/v1", receiptId: "local-skill-loaded", target: local, releaseId: "skill-release", packageHash, signer: "platform-signer", status: "loaded", observedAt: 1_201 });

    const applyCount = await database.prepare("SELECT COUNT(*) AS count FROM cp_apply_receipts WHERE status = ?").get<{ count: number | string }>("loaded");
    const skillCount = await database.prepare("SELECT COUNT(*) AS count FROM cp_skill_install_receipts WHERE status = ?").get<{ count: number | string }>("loaded");
    assert.equal(Number(applyCount?.count), 8);
    assert.equal(Number(skillCount?.count), 2);

    const newModel = await publishActive(releases, "model-resource", "model-new", "model_route", {
      schemaVersion: "model-route/v1", providerConfiguration: providerConfiguration("new-model"),
    });
    await releases.assign({ expectedRevision: newModel.resourceRevision, actorId: "admin-acceptance", auditEventId: "assign-model-new",
      assignment: { ...platformAssignment("model-resource", "model-new"), assignmentId: "assignment-model-runtime", priority: 20, scope: { plane: "cloud", target: { kind: "runtime_id", tenantId: "tenant-a", runtimeId: "runtime-cloud" } } } });
    const newCloudSnapshot = await cloudClient.desiredSnapshot();
    assert.equal(oldCloudSnapshot.modelRoute?.releaseId, "model-old", "an admitted Run keeps its old immutable snapshot");
    assert.equal(newCloudSnapshot.modelRoute?.releaseId, "model-new", "a fresh admission resolves the higher-priority target assignment");
    assert.notEqual(newCloudSnapshot.snapshotId, oldCloudSnapshot.snapshotId);

    const traceResponse = await fetch(`${baseUrl}/admin/v1/runs/run-acceptance/trace`, { headers: { authorization: "Bearer admin" } });
    assert.equal(traceResponse.status, 200);
    assert.deepEqual((await traceResponse.json() as RuntimeTrace).missingBoundaries, [{ source: "runtime", reason: "not_recorded" }]);
    const drain = await fetch(`${baseUrl}/admin/v1/runtimes/runtime-cloud/drain`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "runtime-drain-acceptance" }, body: JSON.stringify({ target: cloud, expectedRevision: 7 }) });
    assert.deepEqual(await drain.json(), operation(cloud, "drain", 7));
    const recover = await fetch(`${baseUrl}/admin/v1/runtimes/runtime-cloud/recover`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "runtime-recover-acceptance" }, body: JSON.stringify({ target: cloud, expectedRevision: 8 }) });
    assert.deepEqual(await recover.json(), operation(cloud, "recover", 8));

    const audit = await fetch(`${baseUrl}/admin/v1/audit-events?limit=200`, { headers: { authorization: "Bearer admin" } });
    const events = (await audit.json() as { events: readonly { action: string }[] }).events;
    assert.ok(events.some((event) => event.action === "release.published"));
    assert.ok(events.some((event) => event.action === "apply-receipt.recorded"));
    assert.ok(events.some((event) => event.action === "skill-install-receipt.recorded"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await database.close();
  }
});

async function publishActive(releases: ReleaseApplicationService, resourceId: string, releaseId: string, kind: ResourceKind, payload: Readonly<Record<string, unknown>>): Promise<{ resourceRevision: number }> {
  const release: ResourceRelease = { contractVersion: "control-plane/v1", resourceId, releaseId, version: releaseId === "model-new" ? 2 : 1, kind, schemaVersion: String(payload.schemaVersion), contentHash: contentHashForRelease({ kind, schemaVersion: String(payload.schemaVersion), payload }), authorId: "admin-acceptance", createdAt: nextCreatedAt++, state: "draft", payload };
  await releases.publish({ release, expectedRevision: releaseId === "model-new" ? 5 : 0, actorId: "admin-acceptance", auditEventId: `publish-${releaseId}` });
  let expectedRevision = releaseId === "model-new" ? 6 : 1;
  for (const state of ["validated", "observe", "active"] as const) {
    await releases.transition({ releaseId, state, expectedRevision, actorId: "admin-acceptance", auditEventId: `${releaseId}-${state}` });
    expectedRevision += 1;
  }
  return { resourceRevision: expectedRevision };
}

function platformAssignment(resourceId: string, releaseId: string): TargetAssignment {
  return { contractVersion: "control-plane/v1", assignmentId: `assignment-${releaseId}`, resourceId, releaseId, scope: { plane: "both", target: { kind: "platform" } }, priority: 0, rolloutState: "active", revision: 1 };
}

function providerConfiguration(modelKey: string): Record<string, unknown> {
  return { defaultProvider: "test", defaultModelKey: modelKey, providers: { test: { kind: "openai-compatible", baseUrl: "https://models.example.test/v1", apiKeyEnv: "TEST_API_KEY", defaultModel: modelKey, protocol: "chat-completions" } }, models: { [modelKey]: { providerKey: "test", providerModel: modelKey, displayName: modelKey } } };
}

function operation(target: RuntimeTarget, operationName: "drain" | "recover", revision: number): RuntimeOperationResult {
  return { contractVersion: "control-plane/v1", runtimeId: target.runtimeId, target, operation: operationName, state: operationName === "drain" ? "draining" : "ready", revision: revision + 1, observedAt: 1_500 };
}
