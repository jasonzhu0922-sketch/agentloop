import type { AdminMember, AdminMemberRole, AdminUser, AdminUserStatus, AuditEvent, ControlPlaneResource, ResourceKind, ResourceRelease, RuntimeInventoryPage, RuntimeOperationResult, RuntimeTarget, RuntimeTrace } from "../../../control-plane/contracts/index.ts";
import type { AdminUserCredential, AdminUserCredentialPort } from "../authorization/ports.ts";
import type { RouterRunDetail, RouterRunPage } from "../../../src/shared/contracts.ts";
import type { BusinessUserPage, BusinessUserSummary } from "../../../src/router/identity/service.ts";

/** Independent identity boundary; neither Router sessions nor user tokens implement it directly. */
export interface AdminIdentityPort {
  listMembers(scopeId: string): Promise<readonly AdminMember[]>;
  createMember(member: AdminMember, expectedRevision: number, actorId: string, auditEventId: string): Promise<AdminMember>;
  transitionMember(memberId: string, status: AdminMember["status"], expectedRevision: number, actorId: string, auditEventId: string): Promise<AdminMember>;
}

export interface AdminUserDirectoryPort {
  listAdminUsers(): Promise<readonly AdminUser[]>;
  createAdminUser(input: { readonly user: AdminUser; readonly passwordHash: string; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<AdminUser>;
  updateAdminUser(input: { readonly userId: string; readonly displayName: string; readonly scopeId?: string; readonly role: AdminMemberRole; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<AdminUser>;
  transitionAdminUser(input: { readonly userId: string; readonly status: AdminUserStatus; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<AdminUser>;
  setAdminUserPassword(input: { readonly userId: string; readonly passwordHash: string; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<AdminUser>;
}

export type AdminUserStorePort = AdminUserDirectoryPort & AdminUserCredentialPort;

/** Read-only projection boundary. A missing source is returned as an explicit trace boundary, never fabricated. */
export interface AdminTracePort {
  trace(runId: string): Promise<RuntimeTrace>;
}

/** Read-only Router aggregation used by the Admin task operations page. */
export interface RunOperationsPort {
  list(page: number, pageSize: number): Promise<RouterRunPage>;
  detail(id: string): Promise<RouterRunDetail>;
}

export interface BusinessUserOperationsPort {
  list(page: number, pageSize: number): Promise<BusinessUserPage>;
  suspend(id: string): Promise<BusinessUserSummary>;
  resetPassword(id: string, password: string): Promise<BusinessUserSummary>;
}

export interface AdminAuditPort {
  listAuditEvents(limit: number): Promise<readonly AuditEvent[]>;
}

export interface AdminCatalogPort {
  listResources(): Promise<readonly ControlPlaneResource[]>;
  listReleases(kind?: ResourceKind): Promise<readonly ResourceRelease[]>;
}

/** Router/Runtime operation boundary. The Admin API never imports their implementations. */
export interface RuntimeOperationPort {
  drain(input: { readonly target: RuntimeTarget; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<RuntimeOperationResult>;
  recover(input: { readonly target: RuntimeTarget; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<RuntimeOperationResult>;
  restart(input: { readonly target: RuntimeTarget; readonly expectedRevision: number; readonly actorId: string; readonly auditEventId: string }): Promise<RuntimeOperationResult>;
}

export interface RuntimeInventoryPort {
  list(input: { readonly scopeId?: string; readonly page: number; readonly pageSize: number }): Promise<RuntimeInventoryPage>;
}
