import type { RuntimeTarget } from "./v1.ts";

export type AdminMemberStatus = "invited" | "active" | "suspended" | "removed";
/** Platform roles; RuntimeTarget.tenantId is an execution scope key, not an Admin tenant role. */
export type AdminMemberRole = "platform_admin" | "operator" | "skill_operator" | "auditor" | "member";

export interface AdminMember {
  readonly contractVersion: "control-plane/v1";
  readonly memberId: string;
  readonly tenantId: string;
  readonly subject: string;
  readonly displayName: string;
  readonly role: AdminMemberRole;
  readonly status: AdminMemberStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
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
  readonly operation: "drain" | "recover";
  readonly state: "draining" | "ready" | "recovery_required";
  readonly revision: number;
  readonly observedAt: number;
}
