import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import type { ApplyReceipt, ResourceRelease, TargetAssignment } from "../../control-plane/contracts/index.ts";
import { ControlPlaneError } from "../../control-plane/domain/index.ts";
import { contentHashForRelease, ReleaseApplicationService } from "../src/application/release-service.ts";
import { migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";

function release(state: ResourceRelease["state"] = "draft"): ResourceRelease {
  const content = { kind: "policy" as const, schemaVersion: "policy/v1", payload: { guidance: { strict: true } } };
  return {
    contractVersion: "control-plane/v1", resourceId: "resource-policy", releaseId: "release-policy-1", version: 1,
    ...content, contentHash: contentHashForRelease(content), authorId: "admin-1", createdAt: 100, state,
  };
}

function assignment(): TargetAssignment {
  return {
    contractVersion: "control-plane/v1", assignmentId: "assignment-tenant-a", resourceId: "resource-policy", releaseId: "release-policy-1",
    scope: { plane: "local", target: { kind: "tenant", scopeId: "tenant-a" } }, priority: 10, rolloutState: "active", revision: 1,
  };
}

test("release application preserves content hash, optimistic revisions, scope conflicts, and audit facts", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await migrateControlPlane(database);
    const store = new SqlControlPlaneStore(database);
    const service = new ReleaseApplicationService(store);
    const draft = release();
    await service.publish({ release: draft, expectedRevision: 0, actorId: "admin-1", auditEventId: "audit-release" });
    await assert.rejects(
      () => service.publish({ release: { ...draft, releaseId: "release-policy-2", version: 2 }, expectedRevision: 0, actorId: "admin-1", auditEventId: "audit-stale" }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "revision_conflict",
    );
    const persistedBefore = await database.prepare("SELECT content_hash, payload_json FROM cp_releases WHERE id = ?").get<{ content_hash: string; payload_json: string }>(draft.releaseId);
    await service.transition({ releaseId: draft.releaseId, state: "validated", expectedRevision: 1, actorId: "admin-1", auditEventId: "audit-validated" });
    const persistedAfter = await database.prepare("SELECT content_hash, payload_json, state FROM cp_releases WHERE id = ?").get<{ content_hash: string; payload_json: string; state: string }>(draft.releaseId);
    assert.equal(persistedAfter?.content_hash, persistedBefore?.content_hash);
    assert.equal(persistedAfter?.payload_json, persistedBefore?.payload_json);
    assert.equal(persistedAfter?.state, "validated");

    await service.assign({ assignment: assignment(), expectedRevision: 2, actorId: "admin-1", auditEventId: "audit-assignment" });
    await assert.rejects(
      () => service.assign({ assignment: { ...assignment(), assignmentId: "assignment-tenant-a-conflict" }, expectedRevision: 3, actorId: "admin-1", auditEventId: "audit-conflict" }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "assignment_conflict",
    );

    const receipt: ApplyReceipt = {
      contractVersion: "control-plane/v1", receiptId: "receipt-1", target: { plane: "local", scopeId: "tenant-a", runtimeId: "runtime-a", deviceId: "device-a" },
      releaseId: draft.releaseId, contentHash: draft.contentHash, status: "loaded", observedAt: 200,
    };
    await service.recordReceipt({ receipt, actorId: "device:device-a", auditEventId: "audit-receipt" });
    const audit = await database.prepare("SELECT action FROM cp_audit_events").all<{ action: string }>();
    assert.deepEqual(audit.map((event) => event.action).sort(), ["apply-receipt.recorded", "release.published", "release.transitioned", "target-assignment.created"]);
  } finally {
    await database.close();
  }
});

test("release publication rejects a mismatched content hash before it can reach persistence", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await migrateControlPlane(database);
    const service = new ReleaseApplicationService(new SqlControlPlaneStore(database));
    await assert.rejects(
      () => service.publish({ release: { ...release(), contentHash: "0".repeat(64) }, expectedRevision: 0, actorId: "admin-1", auditEventId: "audit-bad-hash" }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "release_hash_mismatch",
    );
    assert.equal(await database.prepare("SELECT id FROM cp_releases").get(), undefined);
  } finally {
    await database.close();
  }
});

test("new releases must enter through draft and receipts cannot acknowledge draft content", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await migrateControlPlane(database);
    const service = new ReleaseApplicationService(new SqlControlPlaneStore(database));
    await assert.rejects(
      () => service.publish({ release: { ...release("active"), releaseId: "release-active", version: 2 }, expectedRevision: 0, actorId: "admin-1", auditEventId: "audit-active" }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "invalid_release_transition",
    );
    const draft = release();
    await service.publish({ release: draft, expectedRevision: 0, actorId: "admin-1", auditEventId: "audit-draft" });
    await assert.rejects(
      () => service.recordReceipt({
        receipt: { contractVersion: "control-plane/v1", receiptId: "draft-receipt", target: { plane: "cloud", scopeId: "tenant-a", runtimeId: "runtime-a" }, releaseId: draft.releaseId, contentHash: draft.contentHash, status: "loaded", observedAt: 1 },
        actorId: "workload", auditEventId: "audit-draft-receipt",
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "release_not_active",
    );
  } finally {
    await database.close();
  }
});

test("release content hashing is order-stable and rejects non-JSON values", () => {
  assert.equal(
    contentHashForRelease({ kind: "policy", schemaVersion: "policy/v1", payload: { alpha: 1, beta: 2 } }),
    contentHashForRelease({ kind: "policy", schemaVersion: "policy/v1", payload: { beta: 2, alpha: 1 } }),
  );
  assert.throws(
    () => contentHashForRelease({ kind: "policy", schemaVersion: "policy/v1", payload: { invalid: Number.NaN } }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "invalid_contract",
  );
});
