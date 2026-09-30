import type { ConfigurationScope, RuntimeTarget, TargetAssignment } from "../contracts/index.ts";
import { ControlPlaneError } from "./errors.ts";

const rolloutEligible = new Set(["observe", "canary", "active"]);

export function assertValidScope(scope: ConfigurationScope): void {
  if (scope.target.kind === "device_id" && scope.plane !== "local") {
    throw new ControlPlaneError("invalid_scope", "device_id scope must be local-only");
  }
  if (scope.target.kind !== "platform" && scope.target.tenantId.trim().length === 0) {
    throw new ControlPlaneError("invalid_scope", "non-platform scope requires a tenantId");
  }
  if (scope.target.kind === "runtime_class" && scope.target.runtimeClass.trim().length === 0) {
    throw new ControlPlaneError("invalid_scope", "runtime_class scope requires runtimeClass");
  }
  if (scope.target.kind === "runtime_id" && scope.target.runtimeId.trim().length === 0) {
    throw new ControlPlaneError("invalid_scope", "runtime_id scope requires runtimeId");
  }
  if (scope.target.kind === "device_id" && scope.target.deviceId.trim().length === 0) {
    throw new ControlPlaneError("invalid_scope", "device_id scope requires deviceId");
  }
}

export function assertAssignmentShape(assignment: TargetAssignment): void {
  assertValidScope(assignment.scope);
  if (!assignment.assignmentId.trim() || !assignment.resourceId.trim() || !assignment.releaseId.trim()) {
    throw new ControlPlaneError("invalid_contract", "Assignment identifiers must be non-empty");
  }
  if (!Number.isSafeInteger(assignment.priority) || !Number.isSafeInteger(assignment.revision) || assignment.revision < 0) {
    throw new ControlPlaneError("invalid_contract", "Assignment priority and revision must be safe integers");
  }
}

export function scopeMatches(scope: ConfigurationScope, target: RuntimeTarget): boolean {
  assertValidScope(scope);
  if (scope.plane !== "both" && scope.plane !== target.plane) return false;
  switch (scope.target.kind) {
    case "platform": return true;
    case "tenant": return scope.target.tenantId === target.tenantId;
    case "runtime_class": return scope.target.tenantId === target.tenantId && scope.target.runtimeClass === target.runtimeClass;
    case "runtime_id": return scope.target.tenantId === target.tenantId && scope.target.runtimeId === target.runtimeId;
    case "device_id": return target.plane === "local" && scope.target.tenantId === target.tenantId && scope.target.deviceId === target.deviceId;
  }
}

/** Fixed precedence: platform < plane baseline < tenant < runtime class < runtime/device. */
export function scopePrecedence(scope: ConfigurationScope): number {
  assertValidScope(scope);
  if (scope.target.kind === "platform") return scope.plane === "both" ? 0 : 1;
  if (scope.target.kind === "tenant") return 2;
  if (scope.target.kind === "runtime_class") return 3;
  return 4;
}

export function resolveEffectiveAssignment(assignments: readonly TargetAssignment[], target: RuntimeTarget): TargetAssignment | undefined {
  const eligible = assignments.filter((assignment) => {
    assertValidScope(assignment.scope);
    return rolloutEligible.has(assignment.rolloutState) && scopeMatches(assignment.scope, target);
  });
  if (eligible.length === 0) return undefined;

  const ranked = eligible.map((assignment) => ({ assignment, precedence: scopePrecedence(assignment.scope) }));
  const highestPrecedence = Math.max(...ranked.map((candidate) => candidate.precedence));
  const atPrecedence = ranked.filter((candidate) => candidate.precedence === highestPrecedence);
  const highestPriority = Math.max(...atPrecedence.map((candidate) => candidate.assignment.priority));
  const winners = atPrecedence.filter((candidate) => candidate.assignment.priority === highestPriority);
  if (winners.length !== 1) {
    throw new ControlPlaneError("scope_conflict", `Conflicting assignments apply to ${target.plane}/${target.tenantId}/${target.runtimeId}`);
  }
  return winners[0]?.assignment;
}

/**
 * Rejects equal-rank overlaps before persistence. A runtime/device pair is
 * conservatively treated as overlapping: the control plane has no device to
 * runtime ownership fact with which to prove that they are disjoint.
 */
export function assignmentsConflict(existing: TargetAssignment, proposed: TargetAssignment): boolean {
  assertAssignmentShape(existing);
  assertAssignmentShape(proposed);
  if (existing.resourceId !== proposed.resourceId) return false;
  if (existing.priority !== proposed.priority) return false;
  if (!rolloutEligible.has(existing.rolloutState) || !rolloutEligible.has(proposed.rolloutState)) return false;
  if (scopePrecedence(existing.scope) !== scopePrecedence(proposed.scope)) return false;
  if (!planesOverlap(existing.scope.plane, proposed.scope.plane)) return false;
  return targetsOverlap(existing.scope, proposed.scope);
}

export function assertNoAssignmentConflict(existing: readonly TargetAssignment[], proposed: TargetAssignment): void {
  if (existing.some((assignment) => assignmentsConflict(assignment, proposed))) {
    throw new ControlPlaneError("assignment_conflict", `Assignment ${proposed.assignmentId} overlaps an existing equal-priority assignment`);
  }
}

function planesOverlap(left: ConfigurationScope["plane"], right: ConfigurationScope["plane"]): boolean {
  return left === "both" || right === "both" || left === right;
}

function targetsOverlap(left: ConfigurationScope, right: ConfigurationScope): boolean {
  if (left.target.kind === "platform" || right.target.kind === "platform") return true;
  if (left.target.tenantId !== right.target.tenantId) return false;
  if (left.target.kind === "tenant" || right.target.kind === "tenant") return true;
  if (left.target.kind === right.target.kind) {
    if (left.target.kind === "runtime_class" && right.target.kind === "runtime_class") return left.target.runtimeClass === right.target.runtimeClass;
    if (left.target.kind === "runtime_id" && right.target.kind === "runtime_id") return left.target.runtimeId === right.target.runtimeId;
    if (left.target.kind === "device_id" && right.target.kind === "device_id") return left.target.deviceId === right.target.deviceId;
  }
  return true;
}
