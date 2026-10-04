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
  | { readonly kind: "tenant"; readonly scopeId: string }
  | { readonly kind: "runtime_class"; readonly scopeId: string; readonly runtimeClass: string }
  | { readonly kind: "runtime_id"; readonly scopeId: string; readonly runtimeId: string }
  | { readonly kind: "device_id"; readonly scopeId: string; readonly deviceId: string };

export interface ConfigurationScope {
  readonly plane: AssignmentPlane;
  readonly target: ScopeTarget;
}

export interface RuntimeTarget {
  readonly plane: RuntimePlane;
  readonly scopeId: string;
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

export interface RecordSkillInstallReceiptCommand {
  readonly receipt: SkillInstallReceipt;
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
  readonly modelRoute?: ModelRouteReference;
  readonly integrations: readonly IntegrationBindingReference[];
  readonly skills: readonly SkillReleaseReference[];
  readonly policies: readonly PolicyReleaseReference[];
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

/**
 * Public, versioned model-route manifest. `providerConfiguration` deliberately
 * contains no credential value: legacy `apiKeyEnv` names remain Host-local
 * references until the secret broker work package replaces them.
 */
export interface ModelRouteReference extends ReleaseReference {
  readonly providerConfiguration: Readonly<Record<string, unknown>>;
}

export interface IntegrationBindingReference extends ReleaseReference {
  readonly bindingId: string;
  /** Brokered releases declare their invocation vocabulary; legacy public references cannot authorize a call. */
  readonly integration?: string;
  readonly allowedActions?: readonly string[];
}

export interface SkillReleaseReference {
  readonly releaseId: string;
  readonly packageHash: string;
  /** Release content hash remains the receipt/audit integrity key; packageHash verifies the artifact. */
  readonly contentHash: string;
  /** Signed artifact metadata is public; package bytes remain target-local. */
  readonly artifact?: SkillArtifactManifest;
}

export interface SkillArtifactManifest {
  readonly packageUri: string;
  readonly packageHash: string;
  readonly signer: string;
  readonly signatureAlgorithm: "ed25519" | "minisign";
  readonly signature: string;
  readonly compatibility?: Readonly<Record<string, unknown>>;
}

export interface PolicyReleaseReference extends ReleaseReference {
  /** Public policy payload; it contains guidance/strategy metadata only. */
  readonly policy?: RuntimePolicyManifest;
}

export interface RuntimePolicyManifest {
  readonly practiceProfileCatalog?: Readonly<Record<string, unknown>>;
  readonly stepExecutionStrategy?: Readonly<Record<string, unknown>>;
  readonly planTemplates?: readonly Readonly<Record<string, unknown>>[];
}

export type SkillInstallStatus = "verified" | "loaded" | "failed" | "rejected";

export interface SkillInstallReceipt {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly receiptId: string;
  readonly target: RuntimeTarget;
  readonly releaseId: string;
  readonly packageHash: string;
  readonly signer: string;
  readonly status: SkillInstallStatus;
  readonly observedAt: number;
  readonly reasonCode?: ControlPlaneErrorCode;
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

/** A workload asks for one short-lived capability, never a credential value. */
export interface CredentialGrantRequest {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly invocationId: string;
  readonly runId: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly integration: string;
  readonly action: string;
  readonly bindingId: string;
  readonly releaseId: string;
  readonly contentHash: string;
  readonly skillNames: readonly string[];
  readonly requestedAt: number;
}

/** Opaque, single-operation capability metadata. It intentionally has no endpoint or secret value. */
export interface CredentialGrant {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly grantId: string;
  readonly invocationId: string;
  readonly bindingId: string;
  readonly releaseId: string;
  readonly contentHash: string;
  readonly secretReferenceVersion: string;
  readonly expiresAt: number;
}

export interface IntegrationInvocationRequest {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly grantId: string;
  readonly invocation: CredentialGrantRequest;
  /** Integration-owned, schema-validated action input. Never contains a secret. */
  readonly args: Readonly<Record<string, unknown>>;
}

/** Persistable, redacted proof of a brokered external invocation. */
export interface IntegrationInvocationReceipt {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly receiptId: string;
  readonly invocationId: string;
  readonly bindingId: string;
  readonly releaseId: string;
  readonly contentHash: string;
  readonly secretReferenceVersion: string;
  readonly status: "completed" | "failed" | "rejected";
  readonly reasonCode?: ControlPlaneErrorCode;
  readonly observedAt: number;
}

export interface IntegrationInvocationResponse {
  readonly result: Readonly<Record<string, unknown>>;
  readonly receipt: IntegrationInvocationReceipt;
}

/** Opaque device-targeted payload. Only a device secure-storage adapter may consume its ciphertext. */
export interface DeviceCredentialEnvelope {
  readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
  readonly envelopeId: string;
  readonly grantId: string;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly releaseId: string;
  readonly contentHash: string;
  readonly secretReferenceVersion: string;
  readonly encryptedPayload: string;
  readonly expiresAt: number;
}

export const CONTROL_PLANE_ERROR_CODES = [
  "configuration_unavailable",
  "runtime_operation_not_configured",
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
  "integration_not_authorized",
  "credential_grant_expired",
  "integration_upstream_failed",
  "integration_response_invalid",
  "credential_envelope_expired",
  "skill_artifact_not_found",
  "skill_artifact_hash_mismatch",
  "skill_artifact_signature_invalid",
] as const;

export type ControlPlaneErrorCode = (typeof CONTROL_PLANE_ERROR_CODES)[number];
