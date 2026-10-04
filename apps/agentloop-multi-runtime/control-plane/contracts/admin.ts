import type { RuntimeTarget } from "./v1.ts";

export type AdminMemberStatus = "invited" | "active" | "suspended" | "removed";
/** Platform roles; RuntimeTarget.scopeId is an execution scope key, not an Admin tenant role. */
export type AdminMemberRole = "platform_admin" | "operator" | "skill_operator" | "auditor" | "member";

export interface AdminMember {
  readonly contractVersion: "control-plane/v1";
  readonly memberId: string;
  readonly scopeId: string;
  readonly subject: string;
  readonly displayName: string;
  readonly role: AdminMemberRole;
  readonly status: AdminMemberStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Admin audience account. It is independent from Router/Runtime end users. */
export type AdminUserStatus = "active" | "suspended" | "removed";

export interface AdminUser {
  readonly contractVersion: "control-plane/v1";
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly scopeId?: string;
  readonly role: AdminMemberRole;
  readonly status: AdminUserStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastLoginAt?: number;
}

/** Admin read-model shape for Skill package metadata; kept in the control-plane contract so Web does not depend on the Runtime kernel package. */
export interface AdminSkillAgentLoopMetadata {
  readonly roles: readonly string[];
  readonly artifactKinds: readonly string[];
  readonly sourceKinds: readonly string[];
  readonly qaKinds: readonly string[];
  readonly executionProfiles?: readonly string[];
  readonly semanticTags?: readonly string[];
  readonly intentExamples?: readonly string[];
  readonly producesEvidenceKinds?: readonly string[];
  readonly requiredSkillNames?: readonly string[];
}

export interface CreateAdminUserCommand {
  readonly user: AdminUser;
  readonly password: string;
  readonly expectedRevision: number;
  readonly auditEventId: string;
}

export interface UpdateAdminUserCommand {
  readonly userId: string;
  readonly displayName: string;
  readonly scopeId?: string;
  readonly role: AdminMemberRole;
  readonly expectedRevision: number;
  readonly auditEventId: string;
}

export interface TransitionAdminUserCommand {
  readonly userId: string;
  readonly status: AdminUserStatus;
  readonly expectedRevision: number;
  readonly auditEventId: string;
}

export interface SetAdminUserPasswordCommand {
  readonly userId: string;
  readonly password: string;
  readonly expectedRevision: number;
  readonly auditEventId: string;
}

export interface CreateMemberCommand {
  readonly member: AdminMember;
  readonly expectedRevision: number;
  readonly auditEventId: string;
}

export interface TransitionMemberCommand {
  readonly memberId: string;
  readonly status: AdminMemberStatus;
  readonly expectedRevision: number;
  readonly auditEventId: string;
}

export interface AuditEvent {
  readonly eventId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceId: string;
  readonly releaseId?: string;
  readonly beforeRef?: string;
  readonly afterRef?: string;
  readonly createdAt: number;
}

export interface RuntimeTrace {
  readonly contractVersion: "control-plane/v1";
  readonly runId: string;
  readonly target?: RuntimeTarget;
  readonly facts: readonly RuntimeTraceFact[];
  readonly missingBoundaries: readonly RuntimeTraceBoundary[];
}

export interface RuntimeTraceFact {
  readonly source: "router" | "runtime" | "control_plane";
  readonly kind: string;
  readonly ref: string;
  readonly observedAt?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeTraceBoundary {
  readonly source: "router" | "runtime" | "control_plane";
  readonly reason: "not_available" | "not_authorized" | "not_recorded";
}

export interface RuntimeOperationResult {
  readonly contractVersion: "control-plane/v1";
  readonly runtimeId: string;
  readonly target: RuntimeTarget;
  readonly operation: "drain" | "recover" | "restart";
  readonly state: "draining" | "ready" | "recovery_required" | "restarting";
  readonly revision: number;
  readonly observedAt: number;
}

/** Router-owned Runtime inventory exposed to Admin; liveness is a snapshot, not a guessed process list. */
export interface RuntimeInventoryEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly plane: "cloud" | "local";
  readonly profile: "general" | "artifact";
  readonly deviceId?: string;
  readonly scopeId?: string;
  readonly status: "ready" | "draining" | "offline";
  readonly capabilities: readonly string[];
  readonly maxConcurrentRuns: number;
  readonly activeRunCount: number;
  readonly queuedRunCount: number;
  readonly catalogVersion?: string;
  readonly startedAt: number;
  readonly lastHeartbeatAt?: number;
  readonly leaseExpiresAt?: number;
}

export interface RuntimeInventoryPage {
  readonly items: readonly RuntimeInventoryEntry[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pageCount: number;
}
