import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceRelease, RuntimeTarget, TargetAssignment } from "../contracts/index.ts";
import { assertNoAssignmentConflict, ControlPlaneError, freezeRelease, resolveEffectiveAssignment, transitionRelease } from "../domain/index.ts";

const target: RuntimeTarget = {
  plane: "local",
  scopeId: "tenant-a",
  runtimeClass: "analysis",
  runtimeId: "runtime-a",
  deviceId: "device-a",
};

function assignment(id: string, scope: TargetAssignment["scope"], priority = 0): TargetAssignment {
  return {
    contractVersion: "control-plane/v1",
    assignmentId: id,
    resourceId: "resource-a",
    releaseId: `${id}-release`,
    scope,
    priority,
    rolloutState: "active",
    revision: 1,
  };
}

function release(state: ResourceRelease["state"] = "draft"): ResourceRelease {
  return {
    contractVersion: "control-plane/v1",
    resourceId: "resource-a",
    releaseId: "release-a",
    version: 1,
    kind: "policy",
    schemaVersion: "policy/v1",
    contentHash: "a".repeat(64),
    authorId: "admin-a",
    createdAt: 1,
    state,
    payload: { policy: { enabled: true } },
  };
}

test("scope resolver honors plane, tenant, runtime and device precedence", () => {
  const assignments = [
    assignment("platform", { plane: "both", target: { kind: "platform" } }),
    assignment("plane", { plane: "local", target: { kind: "platform" } }),
    assignment("tenant", { plane: "local", target: { kind: "tenant", scopeId: "tenant-a" } }),
    assignment("class", { plane: "local", target: { kind: "runtime_class", scopeId: "tenant-a", runtimeClass: "analysis" } }),
    assignment("runtime", { plane: "local", target: { kind: "runtime_id", scopeId: "tenant-a", runtimeId: "runtime-a" } }),
    // runtime and device are the same terminal scope layer; priority selects an intentional device override.
    assignment("device", { plane: "local", target: { kind: "device_id", scopeId: "tenant-a", deviceId: "device-a" } }, 1),
  ];
  assert.equal(resolveEffectiveAssignment(assignments, target)?.assignmentId, "device");
  assert.equal(resolveEffectiveAssignment(assignments.slice(0, -1), target)?.assignmentId, "runtime");
  assert.equal(resolveEffectiveAssignment(assignments.slice(0, -2), target)?.assignmentId, "class");
  assert.equal(resolveEffectiveAssignment(assignments.slice(0, -3), target)?.assignmentId, "tenant");
  assert.equal(resolveEffectiveAssignment(assignments.slice(0, -4), target)?.assignmentId, "plane");
  assert.equal(resolveEffectiveAssignment(assignments.slice(0, 1), target)?.assignmentId, "platform");
});

test("scope resolution blocks cross-tenant and cloud/device matches", () => {
  const tenantAssignment = assignment("tenant-a", { plane: "both", target: { kind: "tenant", scopeId: "tenant-a" } });
  assert.equal(resolveEffectiveAssignment([tenantAssignment], { ...target, scopeId: "tenant-b" }), undefined);
  const deviceAssignment = assignment("device", { plane: "local", target: { kind: "device_id", scopeId: "tenant-a", deviceId: "device-a" } });
  assert.equal(resolveEffectiveAssignment([deviceAssignment], { ...target, plane: "cloud", deviceId: undefined }), undefined);
});

test("same precedence and priority is a publish-time conflict", () => {
  const assignments = [
    assignment("one", { plane: "local", target: { kind: "tenant", scopeId: "tenant-a" } }, 10),
    assignment("two", { plane: "both", target: { kind: "tenant", scopeId: "tenant-a" } }, 10),
  ];
  assert.throws(
    () => resolveEffectiveAssignment(assignments, target),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "scope_conflict",
  );
  assert.equal(resolveEffectiveAssignment([assignments[0]!, { ...assignments[1]!, priority: 11 }], target)?.assignmentId, "two");
  assert.throws(
    () => assertNoAssignmentConflict([assignments[0]!], assignments[1]!),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "assignment_conflict",
  );
});

test("invalid device scopes and release transitions fail with stable errors", () => {
  assert.throws(
    () => resolveEffectiveAssignment([assignment("bad", { plane: "both", target: { kind: "device_id", scopeId: "tenant-a", deviceId: "device-a" } })], target),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "invalid_scope",
  );
  assert.throws(
    () => transitionRelease(release("draft"), "active"),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "invalid_release_transition",
  );
  let lifecycle = release();
  for (const next of ["validated", "observe", "canary", "active", "superseded", "rolled_back", "retired"] as const) {
    lifecycle = transitionRelease(lifecycle, next);
  }
  assert.equal(lifecycle.state, "retired");
});

test("release payload is defensively copied and deeply immutable", () => {
  const mutable = release();
  const frozen = freezeRelease(mutable);
  (mutable.payload.policy as { enabled: boolean }).enabled = false;
  assert.equal((frozen.payload.policy as { enabled: boolean }).enabled, true);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.payload), true);
  assert.equal(Object.isFrozen(frozen.payload.policy as object), true);
});
