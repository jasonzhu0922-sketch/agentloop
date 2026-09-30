/**
 * Versioned, transport-neutral public contracts for control-plane delivery.
 * They intentionally contain no credential material or platform adapters.
 */
export const CONTROL_PLANE_CONTRACT_VERSION = "control-plane/v1" as const;

export type RuntimePlane = "cloud" | "local";
export type AssignmentPlane = RuntimePlane | "both";
export type ResourceKind = "integration" | "model_route" | "skill" | "policy";
export type ReleaseState = "draft" | "validated" | "observe" | "canary" | "active" | "superseded" | "rolled_back" | "retired";
export type RolloutState = "planned" | "observe" | "canary" | "active" | "suspended" | "revoked";
/** validated does not mean effective: only a loaded receipt permits a later admission cutover. */
export type ApplyStatus = "validated" | "loaded" | "failed" | "rejected";

export type ScopeTarget =
  | { readonly kind: "platform" }
  | { readonly kind: "tenant"; readonly tenantId: string }
  | { readonly kind: "runtime_class"; readonly tenantId: string; readonly runtimeClass: string }
  | { readonly kind: "runtime_id"; readonly tenantId: string; readonly runtimeId: string }
  | { readonly kind: "device_id"; readonly tenantId: string; readonly deviceId: string };

export interface ConfigurationScope {
  readonly plane: AssignmentPlane;
  readonly target: ScopeTarget;
}

export interface RuntimeTarget {
  readonly plane: RuntimePlane;
  readonly tenantId: string;
  readonly runtimeClass?: string;
  readonly runtimeId: string;
  readonly deviceId?: string;
}

/** A release has immutable content; the payload is intentionally public metadata only. */
export interface ResourceRelease {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly resourceId: string;
  readonly releaseId: string;
  readonly version: number;
  readonly kind: ResourceKind;
  readonly schemaVersion: string;
  readonly contentHash: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly state: ReleaseState;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface TargetAssignment {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly assignmentId: string;
  readonly resourceId: string;
  readonly releaseId: string;
  readonly scope: ConfigurationScope;
  readonly priority: number;
  readonly rolloutState: RolloutState;
  readonly revision: number;
}

export interface PublishReleaseCommand {
  readonly release: ResourceRelease;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly auditEventId: string;
}

export interface CreateTargetAssignmentCommand {
  readonly assignment: TargetAssignment;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly auditEventId: string;
}

export interface TransitionReleaseCommand {
  readonly releaseId: string;
  readonly state: ReleaseState;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly auditEventId: string;
}

export interface RecordApplyReceiptCommand {
  readonly receipt: ApplyReceipt;
  readonly actorId: string;
  readonly auditEventId: string;
}

export interface RuntimeConfigurationSnapshot {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly snapshotId: string;
  readonly configurationRevision: number;
  readonly target: RuntimeTarget;
  readonly resolvedAt: number;
  readonly validUntil: number;
  readonly modelRoute?: ReleaseReference;
  readonly integrations: readonly IntegrationBindingReference[];
  readonly skills: readonly SkillReleaseReference[];
  readonly policies: readonly ReleaseReference[];
}

/** Public resource metadata used only for control-plane resolution; it carries no secret reference/value. */
export interface ControlPlaneResource {
  readonly resourceId: string;
  readonly kind: ResourceKind;
  readonly revision: number;
}

export interface ReleaseReference {
  readonly releaseId: string;
  readonly contentHash: string;
}

export interface IntegrationBindingReference extends ReleaseReference {
  readonly bindingId: string;
}

export interface SkillReleaseReference {
  readonly releaseId: string;
  readonly packageHash: string;
  /** Release content hash remains the receipt/audit integrity key; packageHash verifies the artifact. */
  readonly contentHash: string;
}

export interface ApplyReceipt {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly receiptId: string;
  readonly target: RuntimeTarget;
  readonly releaseId: string;
  readonly contentHash: string;
  readonly status: ApplyStatus;
  readonly observedAt: number;
  /** Stable, non-sensitive reason code. Never place exception text or secret references here. */
  readonly reasonCode?: ControlPlaneErrorCode;
}

export const CONTROL_PLANE_ERROR_CODES = [
  "configuration_unavailable",
  "invalid_contract",
  "invalid_scope",
  "scope_conflict",
  "invalid_release_transition",
  "immutable_release",
  "release_not_active",
  "target_not_authorized",
  "receipt_hash_mismatch",
  "migration_not_ready",
  "revision_conflict",
  "release_hash_mismatch",
  "duplicate_release",
  "assignment_conflict",
] as const;

export type ControlPlaneErrorCode = (typeof CONTROL_PLANE_ERROR_CODES)[number];
