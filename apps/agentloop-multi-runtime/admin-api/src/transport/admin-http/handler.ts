import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminMember, AdminMemberRole, AdminUser, AdminUserStatus, CredentialGrant, CredentialGrantRequest, CreateMemberCommand, CreateTargetAssignmentCommand, IntegrationInvocationRequest, IntegrationInvocationResponse, PublishReleaseCommand, RecordApplyReceiptCommand, RecordSkillInstallReceiptCommand, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeTarget, TransitionMemberCommand, TransitionReleaseCommand } from "../../../../control-plane/contracts/index.ts";
import { ControlPlaneError } from "../../../../control-plane/domain/index.ts";
import { hasAdminPermission, permissionsForRole } from "../../authorization/rbac.ts";
import type { AdminAuthorizationPort, AdminPermission, AdminPrincipal } from "../../authorization/ports.ts";
import type { ReleaseApplicationService } from "../../application/release-service.ts";
import type { ModelCatalogPort, RegisterModelInput, RegisterProviderInput } from "../../application/model-catalog-service.ts";
import type { CustomSkillCatalogApplicationService } from "../../application/custom-skill-catalog-service.ts";
import type { AdminAuditPort, AdminCatalogPort, AdminIdentityPort, AdminTracePort, AdminUserDirectoryPort, BusinessUserOperationsPort, RunOperationsPort, RuntimeInventoryPort, RuntimeOperationPort } from "../../application/admin-ports.ts";
import { hashAdminPassword } from "../../authorization/password-authorization.ts";
import { adminApiHealth } from "./health.ts";

export interface AdminHttpDependencies {
  readonly authorization: AdminAuthorizationPort;
  /** Undefined means the process has no configured, migration-ready control-plane database. */
  readonly releases?: ReleaseApplicationService;
  readonly models?: ModelCatalogPort;
  readonly skills?: CustomSkillCatalogApplicationService;
  readonly snapshots?: RuntimeConfigurationSnapshotPort;
  readonly integrations?: IntegrationDeliveryPort;
  readonly skillArtifacts?: SkillArtifactDeliveryPort;
  readonly identity?: AdminIdentityPort;
  readonly users?: AdminUserDirectoryPort;
  readonly businessUsers?: BusinessUserOperationsPort;
  readonly audit?: AdminAuditPort;
  readonly catalog?: AdminCatalogPort;
  readonly trace?: AdminTracePort;
  readonly runOperations?: RunOperationsPort;
  readonly runtimeInventory?: RuntimeInventoryPort;
  readonly runtimeOperations?: RuntimeOperationPort;
}

/** Delivery transport depends on the snapshot capability, not its application-service implementation. */
export interface RuntimeConfigurationSnapshotPort {
  desiredSnapshot(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot>;
}

/** Secret-provider implementation stays behind this Admin delivery port. */
export interface IntegrationDeliveryPort {
  requestGrant(target: RuntimeTarget, request: CredentialGrantRequest): Promise<CredentialGrant>;
  invoke(target: RuntimeTarget, request: IntegrationInvocationRequest): Promise<IntegrationInvocationResponse>;
}

/** Artifact bytes are supplied by an adapter; the HTTP layer only authorizes the target and package digest. */
export interface SkillArtifactDeliveryPort {
  download(target: RuntimeTarget, packageHash: string): Promise<{ readonly bytes: Uint8Array; readonly contentType?: string }>;
}

/** HTTP does only decoding, principal derivation, and response encoding. Release rules stay in application/domain. */
export function createAdminHttpHandler(dependencies: AdminHttpDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://admin-api.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") return respond(response, 200, adminApiHealth());
      if (request.method === "POST" && url.pathname === "/admin/v1/auth/login") {
        const body = await jsonBody(request) as { username?: string; password?: string };
        if (body.username === undefined || body.password === undefined) throw new ControlPlaneError("invalid_contract", "username and password are required");
        if (dependencies.authorization.login === undefined) return respond(response, 503, { code: "admin_login_not_configured" });
        const session = await dependencies.authorization.login(body.username, body.password);
        if (session === undefined) return respond(response, 401, { code: "admin_credentials_invalid" });
        return respond(response, 200, session);
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/session") {
        const principal = await dependencies.authorization.adminPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, {
          actorId: principal.actorId,
          role: principal.role,
          permissions: [...new Set([...permissionsForRole(principal.role), ...(principal.permissions ?? [])])].sort(),
          ...(principal.scopeId === undefined || (principal.role === "platform_admin" && principal.scopeId === "platform") ? {} : { scopeId: principal.scopeId }),
        });
      }
      if (request.method === "GET" && url.pathname === "/delivery/v1/desired-configuration") {
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined || dependencies.snapshots === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, await dependencies.snapshots.desiredSnapshot(principal.target));
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/members") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "member.read");
        if (principal === undefined || dependencies.identity === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const scopeId = url.searchParams.get("scopeId");
        if (scopeId === null || scopeId.trim() === "") throw new ControlPlaneError("invalid_contract", "scopeId is required");
        if (principal.role !== "platform_admin" && principal.scopeId !== undefined && principal.scopeId !== scopeId) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, { members: await dependencies.identity.listMembers(scopeId) });
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/users") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "user.read");
        if (principal === undefined || dependencies.users === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, { users: await dependencies.users.listAdminUsers() });
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/business-users") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "user.read");
        if (principal === undefined || dependencies.businessUsers === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, await dependencies.businessUsers.list(positiveQueryInteger(url.searchParams.get("page"), 1, 1, 100_000), positiveQueryInteger(url.searchParams.get("pageSize"), 20, 1, 100)));
      }
      const businessSuspend = /^\/admin\/v1\/business-users\/([^/]+)\/suspend$/.exec(url.pathname);
      if (request.method === "POST" && businessSuspend !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "user.write");
        if (principal === undefined || dependencies.businessUsers === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, await dependencies.businessUsers.suspend(decodeURIComponent(businessSuspend[1]!)));
      }
      const businessPassword = /^\/admin\/v1\/business-users\/([^/]+)\/password$/.exec(url.pathname);
      if (request.method === "POST" && businessPassword !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "user.write");
        if (principal === undefined || dependencies.businessUsers === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { password?: string };
        if (typeof body.password !== "string") throw new ControlPlaneError("invalid_contract", "password is required");
        return respond(response, 200, await dependencies.businessUsers.resetPassword(decodeURIComponent(businessPassword[1]!), body.password));
      }
      if (request.method === "POST" && url.pathname === "/admin/v1/users") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "user.write");
        if (principal === undefined || dependencies.users === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { user?: AdminUser; password?: string; expectedRevision?: number };
        if (body.user === undefined || typeof body.password !== "string" || typeof body.expectedRevision !== "number") throw new ControlPlaneError("invalid_contract", "user, password, and expectedRevision are required");
        return respond(response, 201, await dependencies.users.createAdminUser({ user: body.user, passwordHash: hashAdminPassword(body.password), expectedRevision: body.expectedRevision, actorId: principal.actorId, auditEventId: requiredRequestId(request) }));
      }
      const userMutation = /^\/admin\/v1\/users\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PUT" && userMutation !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "user.write");
        if (principal === undefined || dependencies.users === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { displayName?: string; scopeId?: string; role?: AdminMemberRole; expectedRevision?: number };
        if (typeof body.displayName !== "string" || typeof body.role !== "string" || typeof body.expectedRevision !== "number") throw new ControlPlaneError("invalid_contract", "displayName, role, and expectedRevision are required");
        return respond(response, 200, await dependencies.users.updateAdminUser({ userId: decodeURIComponent(userMutation[1]!), displayName: body.displayName, ...(body.scopeId === undefined ? {} : { scopeId: body.scopeId }), role: body.role, expectedRevision: body.expectedRevision, actorId: principal.actorId, auditEventId: requiredRequestId(request) }));
      }
      const userTransition = /^\/admin\/v1\/users\/([^/]+)\/transitions$/.exec(url.pathname);
      if (request.method === "POST" && userTransition !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "user.write");
        if (principal === undefined || dependencies.users === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { status?: AdminUserStatus; expectedRevision?: number };
        if (typeof body.status !== "string" || typeof body.expectedRevision !== "number") throw new ControlPlaneError("invalid_contract", "status and expectedRevision are required");
        return respond(response, 200, await dependencies.users.transitionAdminUser({ userId: decodeURIComponent(userTransition[1]!), status: body.status, expectedRevision: body.expectedRevision, actorId: principal.actorId, auditEventId: requiredRequestId(request) }));
      }
      const userPassword = /^\/admin\/v1\/users\/([^/]+)\/password$/.exec(url.pathname);
      if (request.method === "POST" && userPassword !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "user.write");
        if (principal === undefined || dependencies.users === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { password?: string; expectedRevision?: number };
        if (typeof body.password !== "string" || typeof body.expectedRevision !== "number") throw new ControlPlaneError("invalid_contract", "password and expectedRevision are required");
        return respond(response, 200, await dependencies.users.setAdminUserPassword({ userId: decodeURIComponent(userPassword[1]!), passwordHash: hashAdminPassword(body.password), expectedRevision: body.expectedRevision, actorId: principal.actorId, auditEventId: requiredRequestId(request) }));
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/releases") {
        const kind = url.searchParams.get("kind");
        if (kind !== null && !["integration", "model_route", "skill", "policy"].includes(kind)) throw new ControlPlaneError("invalid_contract", "Unknown release kind");
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, kind === "skill" ? "skill.read" : "release.read");
        if (principal === undefined || dependencies.catalog === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, { releases: await dependencies.catalog.listReleases(kind as ResourceRelease["kind"] | undefined) });
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/models") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "release.read");
        if (principal === undefined || dependencies.models === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, { models: await dependencies.models.list() });
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/providers") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "release.read");
        if (principal === undefined || dependencies.models === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, { providers: await dependencies.models.listProviders() });
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/skills") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "skill.read");
        if (principal === undefined || dependencies.skills === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1, 100_000);
        const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 12, 1, 50);
        return respond(response, 200, await dependencies.skills.list(page, pageSize));
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/runs") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "trace.read");
        if (principal === undefined || dependencies.runOperations === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1, 100_000);
        const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 20, 1, 100);
        return respond(response, 200, await dependencies.runOperations.list(page, pageSize));
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/runtimes") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "runtime.operate");
        if (principal === undefined || dependencies.runtimeInventory === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const page = positiveQueryInteger(url.searchParams.get("page"), 1, 1, 100_000);
        const pageSize = positiveQueryInteger(url.searchParams.get("pageSize"), 20, 1, 100);
        // Platform administrators have a global view. Their bootstrap/session
        // scope (often the sentinel "platform") is not a Runtime tenant and
        // must not hide Local Runtime advertisements from other device scopes.
        const scopeId = principal.role === "platform_admin" ? undefined : principal.scopeId;
        return respond(response, 200, await dependencies.runtimeInventory.list({ ...(scopeId === undefined ? {} : { scopeId }), page, pageSize }));
      }
      const runDetail = /^\/admin\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runDetail !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "trace.read");
        if (principal === undefined || dependencies.runOperations === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, await dependencies.runOperations.detail(decodeURIComponent(runDetail[1]!)));
      }
      const skillDetail = /^\/admin\/v1\/skills\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && skillDetail !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "skill.read");
        if (principal === undefined || dependencies.skills === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const skill = await dependencies.skills.detail(decodeURIComponent(skillDetail[1]!));
        return skill === undefined ? respond(response, 404, { code: "skill_not_found" }) : respond(response, 200, skill);
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/resources") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "release.read");
        if (principal === undefined || dependencies.catalog === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, { resources: await dependencies.catalog.listResources() });
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/audit-events") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "audit.read");
        if (principal === undefined || dependencies.audit === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ControlPlaneError("invalid_contract", "limit must be between 1 and 200");
        return respond(response, 200, { events: await dependencies.audit.listAuditEvents(limit) });
      }
      const trace = /^\/admin\/v1\/runs\/([^/]+)\/trace$/.exec(url.pathname);
      if (request.method === "GET" && trace !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "trace.read");
        if (principal === undefined || dependencies.trace === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, await dependencies.trace.trace(decodeURIComponent(trace[1]!)));
      }
      if (request.method === "POST" && url.pathname === "/delivery/v1/credential-grants") {
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined || dependencies.integrations === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { request?: CredentialGrantRequest };
        if (body.request === undefined) throw new ControlPlaneError("invalid_contract", "credential grant request is required");
        return respond(response, 201, await dependencies.integrations.requestGrant(principal.target, body.request));
      }
      if (request.method === "POST" && url.pathname === "/delivery/v1/integration-invocations") {
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined || dependencies.integrations === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { request?: IntegrationInvocationRequest };
        if (body.request === undefined) throw new ControlPlaneError("invalid_contract", "integration invocation request is required");
        return respond(response, 200, await dependencies.integrations.invoke(principal.target, body.request));
      }
      const artifact = /^\/delivery\/v1\/skill-artifacts\/([a-f0-9]{64})$/.exec(url.pathname);
      if (request.method === "GET" && artifact !== null) {
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined || dependencies.skillArtifacts === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const downloaded = await dependencies.skillArtifacts.download(principal.target, artifact[1]!);
        return respondBytes(response, 200, downloaded.bytes, downloaded.contentType ?? "application/octet-stream");
      }
      const auditEventId = request.headers["x-request-id"];
      if (typeof auditEventId !== "string" || auditEventId.trim() === "") return respond(response, 400, { code: "invalid_contract", message: "x-request-id is required" });
      if (request.method === "POST" && url.pathname === "/admin/v1/releases") {
        if (dependencies.releases === undefined) return respond(response, 503, { code: "migration_not_ready" });
        const body = await jsonBody(request) as { release?: Pick<ResourceRelease, "kind"> };
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, body.release?.kind === "skill" ? "skill.write" : "release.write");
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const command = body as Omit<PublishReleaseCommand, "actorId" | "auditEventId">;
        const release = await dependencies.releases.publish({ ...command, actorId: principal.actorId, auditEventId });
        return respond(response, 201, release);
      }
      if (request.method === "POST" && url.pathname === "/admin/v1/models") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "release.write");
        if (principal === undefined || dependencies.models === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { model?: RegisterModelInput; expectedRevision?: number };
        if (body.model === undefined) throw new ControlPlaneError("invalid_contract", "model is required");
        return respond(response, 201, await dependencies.models.register(body.model, principal.actorId, auditEventId, body.expectedRevision));
      }
      if (request.method === "POST" && url.pathname === "/admin/v1/providers") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "release.write");
        if (principal === undefined || dependencies.models === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { provider?: RegisterProviderInput; expectedRevision?: number };
        if (body.provider === undefined) throw new ControlPlaneError("invalid_contract", "provider is required");
        return respond(response, 201, await dependencies.models.registerProvider(body.provider, principal.actorId, auditEventId, body.expectedRevision));
      }
      const providerDefault = /^\/admin\/v1\/providers\/([^/]+)\/default$/.exec(url.pathname);
      if (request.method === "POST" && providerDefault !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "release.write");
        if (principal === undefined || dependencies.models === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { expectedRevision?: number };
        return respond(response, 200, await dependencies.models.setDefaultProvider(decodeURIComponent(providerDefault[1]!), principal.actorId, auditEventId, body.expectedRevision));
      }
      const modelMutation = /^\/admin\/v1\/models\/([^/]+)$/.exec(url.pathname);
      if ((request.method === "PUT" || request.method === "DELETE") && modelMutation !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "release.write");
        if (principal === undefined || dependencies.models === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = request.method === "DELETE" ? {} : await jsonBody(request) as { model?: RegisterModelInput; expectedRevision?: number };
        const expectedRevision = "expectedRevision" in body && typeof body.expectedRevision === "number" ? body.expectedRevision : request.headers["x-expected-revision"] === undefined ? undefined : Number(request.headers["x-expected-revision"]);
        if (request.method === "DELETE") return respond(response, 200, await dependencies.models.remove(decodeURIComponent(modelMutation[1]!), principal.actorId, auditEventId, expectedRevision));
        if (body.model === undefined) throw new ControlPlaneError("invalid_contract", "model is required");
        return respond(response, 200, await dependencies.models.update(decodeURIComponent(modelMutation[1]!), body.model, principal.actorId, auditEventId, expectedRevision));
      }
      if (request.method === "POST" && url.pathname === "/admin/v1/target-assignments") {
        if (dependencies.releases === undefined) return respond(response, 503, { code: "migration_not_ready" });
        const body = await jsonBody(request) as Omit<CreateTargetAssignmentCommand, "actorId" | "auditEventId">;
        const release = await dependencies.releases.getRelease(body.assignment?.releaseId ?? "");
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, release?.kind === "skill" ? "skill.write" : "release.write");
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        await dependencies.releases.assign({ ...body, actorId: principal.actorId, auditEventId });
        return respond(response, 201, { status: "created" });
      }
      if (request.method === "POST" && url.pathname === "/admin/v1/members") {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "member.write");
        if (principal === undefined || dependencies.identity === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<CreateMemberCommand, "auditEventId">;
        return respond(response, 201, await dependencies.identity.createMember(body.member, body.expectedRevision, principal.actorId, auditEventId));
      }
      const memberTransition = /^\/admin\/v1\/members\/([^/]+)\/transitions$/.exec(url.pathname);
      if (request.method === "POST" && memberTransition !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "member.write");
        if (principal === undefined || dependencies.identity === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<TransitionMemberCommand, "memberId" | "auditEventId">;
        return respond(response, 200, await dependencies.identity.transitionMember(decodeURIComponent(memberTransition[1]!), body.status, body.expectedRevision, principal.actorId, auditEventId));
      }
      const transition = /^\/admin\/v1\/releases\/([^/]+)\/transitions$/.exec(url.pathname);
      if (request.method === "POST" && transition !== null) {
        if (dependencies.releases === undefined) return respond(response, 503, { code: "migration_not_ready" });
        const currentRelease = await dependencies.releases.getRelease(decodeURIComponent(transition[1]!));
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, currentRelease?.kind === "skill" ? "skill.write" : "release.write");
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<TransitionReleaseCommand, "releaseId" | "actorId" | "auditEventId">;
        const transitionedRelease = await dependencies.releases.transition({ ...body, releaseId: decodeURIComponent(transition[1]!), actorId: principal.actorId, auditEventId });
        return respond(response, 200, transitionedRelease);
      }
      if (request.method === "POST" && url.pathname === "/delivery/v1/apply-receipts") {
        if (dependencies.releases === undefined) return respond(response, 503, { code: "migration_not_ready" });
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<RecordApplyReceiptCommand, "actorId" | "auditEventId">;
        if (!sameTarget(body.receipt.target, principal.target)) return respond(response, 403, { code: "target_not_authorized" });
        await dependencies.releases.recordReceipt({ ...body, receipt: { ...body.receipt, target: principal.target }, actorId: principal.actorId, auditEventId });
        return respond(response, 201, { status: "recorded" });
      }
      if (request.method === "POST" && url.pathname === "/delivery/v1/skill-install-receipts") {
        if (dependencies.releases === undefined) return respond(response, 503, { code: "migration_not_ready" });
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<RecordSkillInstallReceiptCommand, "actorId" | "auditEventId">;
        if (body.receipt === undefined || !sameTarget(body.receipt.target, principal.target)) return respond(response, 403, { code: "target_not_authorized" });
        await dependencies.releases.recordSkillInstallReceipt({ ...body, receipt: { ...body.receipt, target: principal.target }, actorId: principal.actorId, auditEventId });
        return respond(response, 201, { status: "recorded" });
      }
      const operation = /^\/admin\/v1\/runtimes\/([^/]+)\/(drain|recover|restart)$/.exec(url.pathname);
      if (request.method === "POST" && operation !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "runtime.operate");
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        if (dependencies.runtimeOperations === undefined) return respond(response, 503, { code: "runtime_operation_not_configured" });
        const body = await jsonBody(request) as { target?: RuntimeTarget; expectedRevision?: number };
        const expectedRevision = body.expectedRevision;
        if (body.target === undefined || body.target.runtimeId !== decodeURIComponent(operation[1]!) || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ControlPlaneError("invalid_contract", "Runtime operation target and expectedRevision are required");
        if (body.target.plane === "local") return respond(response, 403, { code: "target_not_authorized" });
        const input = { target: body.target, expectedRevision, actorId: principal.actorId, auditEventId };
        return respond(response, 200, operation[2] === "drain" ? await dependencies.runtimeOperations.drain(input) : operation[2] === "recover" ? await dependencies.runtimeOperations.recover(input) : await dependencies.runtimeOperations.restart(input));
      }
      return respond(response, 404, { code: "not_found" });
    } catch (error) {
      if (error instanceof ControlPlaneError) return respond(response, statusFor(error.code), { code: error.code });
      return respond(response, 400, { code: "invalid_contract" });
    }
  };
}

async function authorizedAdmin(authorization: AdminAuthorizationPort, header: string | undefined, permission: AdminPermission): Promise<AdminPrincipal | undefined> {
  const principal = await authorization.adminPrincipal(header);
  return principal !== undefined && hasAdminPermission(principal, permission) ? principal : undefined;
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > 256 * 1024) throw new ControlPlaneError("invalid_contract", "Request body exceeds 256 KiB");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ControlPlaneError("invalid_contract", "Request body must be an object");
  return parsed;
}

function sameTarget(left: { plane: string; scopeId: string; runtimeId: string; runtimeClass?: string; deviceId?: string }, right: { plane: string; scopeId: string; runtimeId: string; runtimeClass?: string; deviceId?: string }): boolean {
  return left.plane === right.plane && left.scopeId === right.scopeId && left.runtimeId === right.runtimeId && left.runtimeClass === right.runtimeClass && left.deviceId === right.deviceId;
}

function requiredRequestId(request: IncomingMessage): string {
  const value = request.headers["x-request-id"];
  if (typeof value !== "string" || value.trim() === "") throw new ControlPlaneError("invalid_contract", "x-request-id is required");
  return value;
}

function statusFor(code: ControlPlaneError["code"]): number {
  return code === "revision_conflict" || code === "scope_conflict" || code === "assignment_conflict" || code === "duplicate_release" ? 409
    : code === "target_not_authorized" ? 403
      : code === "migration_not_ready" || code === "configuration_unavailable" || code === "runtime_operation_not_configured" ? 503 : 400;
}

function positiveQueryInteger(raw: string | null, fallback: number, minimum: number, maximum: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ControlPlaneError("invalid_contract", `query parameter must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function respondBytes(response: ServerResponse, status: number, body: Uint8Array, contentType: string): void {
  response.writeHead(status, { "content-type": contentType, "content-length": body.byteLength.toString() });
  response.end(Buffer.from(body));
}
