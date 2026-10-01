import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import type { ResourceKind, ResourceRelease, TargetAssignment } from "../../control-plane/contracts/index.ts";
import { ControlPlaneError } from "../../control-plane/domain/index.ts";
import { contentHashForRelease, ReleaseApplicationService } from "../src/application/release-service.ts";
import { RuntimeConfigurationSnapshotService } from "../src/application/runtime-configuration-snapshot-service.ts";
import { migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";

function release(resourceId: string, releaseId: string, kind: ResourceKind): ResourceRelease {
  const content = {
    kind,
    schemaVersion: kind === "model_route" ? "model-route/v1" : `${kind}/v1`,
    payload: kind === "model_route" ? { providerConfiguration: { defaultProvider: "example", defaultModelKey: "example-model", providers: {}, models: {} } }
      : kind === "integration" ? { name: resourceId, integration: "enterprise_info", allowedActions: ["search", "detail"] }
        : { name: resourceId },
  };
  return {
    contractVersion: "control-plane/v1", resourceId, releaseId, version: 1, ...content,
    contentHash: contentHashForRelease(content), authorId: "admin-1", createdAt: 10, state: "draft",
  };
}

function assignment(resourceId: string, releaseId: string, scope: TargetAssignment["scope"]): TargetAssignment {
  return {
    contractVersion: "control-plane/v1", assignmentId: `${resourceId}-assignment`, resourceId, releaseId,
    scope, priority: 0, rolloutState: "active", revision: 1,
  };
}

async function activate(service: ReleaseApplicationService, item: ResourceRelease, scope: TargetAssignment["scope"], auditPrefix: string): Promise<void> {
  await service.publish({ release: item, expectedRevision: 0, actorId: "admin-1", auditEventId: `${auditPrefix}-publish` });
  await service.transition({ releaseId: item.releaseId, state: "validated", expectedRevision: 1, actorId: "admin-1", auditEventId: `${auditPrefix}-validated` });
  await service.transition({ releaseId: item.releaseId, state: "observe", expectedRevision: 2, actorId: "admin-1", auditEventId: `${auditPrefix}-observe` });
  await service.transition({ releaseId: item.releaseId, state: "active", expectedRevision: 3, actorId: "admin-1", auditEventId: `${auditPrefix}-active` });
  await service.assign({ assignment: assignment(item.resourceId, item.releaseId, scope), expectedRevision: 4, actorId: "admin-1", auditEventId: `${auditPrefix}-assignment` });
}

test("snapshot resolver selects only active releases at the target scope and emits a deterministic revisioned snapshot", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await migrateControlPlane(database);
    const store = new SqlControlPlaneStore(database);
    const releases = new ReleaseApplicationService(store);
    const model = release("model-route", "model-route-r1", "model_route");
    const integration = release("search", "search-r1", "integration");
    const policy = release("policy", "policy-r1", "policy");
    await activate(releases, model, { plane: "both", target: { kind: "platform" } }, "model");
    await activate(releases, integration, { plane: "cloud", target: { kind: "tenant", scopeId: "tenant-a" } }, "integration");
    await activate(releases, policy, { plane: "cloud", target: { kind: "runtime_id", scopeId: "tenant-a", runtimeId: "runtime-a" } }, "policy");
    const resolver = new RuntimeConfigurationSnapshotService({ repository: store, now: () => 1_000, ttlMs: 500 });
    const snapshot = await resolver.desiredSnapshot({ plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" });
    assert.equal(snapshot.modelRoute?.releaseId, model.releaseId);
    assert.deepEqual(snapshot.modelRoute?.providerConfiguration, { defaultProvider: "example", defaultModelKey: "example-model", providers: {}, models: {} });
    assert.deepEqual(snapshot.integrations, [{ bindingId: "search-assignment", releaseId: integration.releaseId, contentHash: integration.contentHash, integration: "enterprise_info", allowedActions: ["search", "detail"] }]);
    assert.deepEqual(snapshot.policies, [{ releaseId: policy.releaseId, contentHash: policy.contentHash }]);
    assert.equal(snapshot.skills.length, 0);
    assert.equal(snapshot.resolvedAt, 1_000);
    assert.equal(snapshot.validUntil, 1_500);
    assert.match(snapshot.snapshotId, /^[a-f0-9]{64}$/);
    assert.ok(snapshot.configurationRevision > 0);
    const otherTenant = await resolver.desiredSnapshot({ plane: "cloud", scopeId: "tenant-b", runtimeId: "runtime-a" });
    assert.equal(otherTenant.modelRoute?.releaseId, model.releaseId);
    assert.deepEqual(otherTenant.integrations, []);
    assert.deepEqual(otherTenant.policies, []);
  } finally {
    await database.close();
  }
});

test("snapshot resolver refuses a selected skill release without a verified package hash", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await migrateControlPlane(database);
    const store = new SqlControlPlaneStore(database);
    const releases = new ReleaseApplicationService(store);
    const skill = release("skill", "skill-r1", "skill");
    await activate(releases, skill, { plane: "cloud", target: { kind: "platform" } }, "skill");
    const resolver = new RuntimeConfigurationSnapshotService({ repository: store, now: () => 1_000, ttlMs: 500 });
    await assert.rejects(
      () => resolver.desiredSnapshot({ plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "configuration_unavailable",
    );
  } finally {
    await database.close();
  }
});

test("snapshot resolver includes only signed Skill artifact metadata", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await migrateControlPlane(database);
    const store = new SqlControlPlaneStore(database);
    const releases = new ReleaseApplicationService(store);
    const packageHash = "b".repeat(64);
    const content = { kind: "skill" as const, schemaVersion: "skill/v1", payload: { name: "signed-skill", packageHash } };
    const skill: ResourceRelease = { contractVersion: "control-plane/v1", resourceId: "skill", releaseId: "skill-signed-r1", version: 1, ...content, contentHash: contentHashForRelease(content), authorId: "admin-1", createdAt: 10, state: "draft" };
    await activate(releases, skill, { plane: "cloud", target: { kind: "platform" } }, "signed-skill");
    await database.prepare("INSERT INTO cp_skill_artifacts(release_id, package_uri, package_hash, signer, compatibility_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(skill.releaseId, "https://artifacts.example.test/signed-skill.tgz", packageHash, "platform-signer", JSON.stringify({ signatureAlgorithm: "ed25519", signature: "signature-bytes" }), 10);
    const snapshot = await new RuntimeConfigurationSnapshotService({ repository: store, now: () => 1_000, ttlMs: 500 }).desiredSnapshot({ plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" });
    assert.deepEqual(snapshot.skills[0]?.artifact, {
      packageUri: "https://artifacts.example.test/signed-skill.tgz", packageHash, signer: "platform-signer", signatureAlgorithm: "ed25519", signature: "signature-bytes",
    });
  } finally {
    await database.close();
  }
});
