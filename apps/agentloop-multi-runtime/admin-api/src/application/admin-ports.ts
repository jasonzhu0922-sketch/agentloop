import type { AdminMember, AuditEvent, ResourceKind, ResourceRelease, RuntimeOperationResult, RuntimeTarget, RuntimeTrace } from "../../../control-plane/contracts/index.ts";

/** Independent identity boundary; neither Router sessions nor user tokens implement it directly. */
export interface AdminIdentityPort {
  listMembers(tenantId: string): Promise<readonly AdminMember[]>;
  createMember(member: AdminMember, expectedRevision: number, actorId: string, auditEventId: string): Promise<AdminMember>;
  transitionMember(memberId: string, status: AdminMember["status"], expectedRevision: number, actorId: string, auditEventId: string): Promise<AdminMember>;
}

/** Read-only projection boundary. A missing source is returned as an explicit trace boundary, never fabricated. */
export interface AdminTracePort {
  trace(runId: string): Promise<RuntimeTrace>;
}

export interface AdminAuditPort {
  listAuditEvents(limit: number): Promise<readonly AuditEvent[]>;
}

export interface AdminCatalogPort {
  listReleases(kind?: ResourceKind): Promise<readonly ResourceRelease[]>;
}

/** Router/Runtime operation boundary. The Admin API never imports their implementations. */
export interface RuntimeOperationPort {
  drain(input: { readonly target: RuntimeTarget; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<RuntimeOperationResult>;
  recover(input: { readonly target: RuntimeTarget; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<RuntimeOperationResult>;
}
