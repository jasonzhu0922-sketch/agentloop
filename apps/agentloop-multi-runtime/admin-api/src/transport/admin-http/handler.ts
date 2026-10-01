import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminMember, CredentialGrant, CredentialGrantRequest, CreateMemberCommand, CreateTargetAssignmentCommand, IntegrationInvocationRequest, IntegrationInvocationResponse, PublishReleaseCommand, RecordApplyReceiptCommand, RecordSkillInstallReceiptCommand, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeTarget, TransitionMemberCommand, TransitionReleaseCommand } from "../../../../control-plane/contracts/index.ts";
import { ControlPlaneError } from "../../../../control-plane/domain/index.ts";
import { hasAdminPermission, permissionsForRole } from "../../authorization/rbac.ts";
import type { AdminAuthorizationPort, AdminPermission, AdminPrincipal } from "../../authorization/ports.ts";
import type { ReleaseApplicationService } from "../../application/release-service.ts";
import type { AdminAuditPort, AdminCatalogPort, AdminIdentityPort, AdminTracePort, RuntimeOperationPort } from "../../application/admin-ports.ts";
import { adminApiHealth } from "./health.ts";

export interface AdminHttpDependencies {
  readonly authorization: AdminAuthorizationPort;
  /** Undefined means the process has no configured, migration-ready control-plane database. */
  readonly releases?: ReleaseApplicationService;
  readonly snapshots?: RuntimeConfigurationSnapshotPort;
  readonly integrations?: IntegrationDeliveryPort;
  readonly skillArtifacts?: SkillArtifactDeliveryPort;
  readonly identity?: AdminIdentityPort;
  readonly audit?: AdminAuditPort;
  readonly catalog?: AdminCatalogPort;
  readonly trace?: AdminTracePort;
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
          ...(principal.scopeId === undefined ? {} : { scopeId: principal.scopeId }),
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
        if (principal.scopeId !== undefined && principal.scopeId !== scopeId) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, { members: await dependencies.identity.listMembers(scopeId) });
      }
      if (request.method === "GET" && url.pathname === "/admin/v1/releases") {
        const kind = url.searchParams.get("kind");
        if (kind !== null && !["integration", "model_route", "skill", "policy"].includes(kind)) throw new ControlPlaneError("invalid_contract", "Unknown release kind");
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, kind === "skill" ? "skill.read" : "release.read");
        if (principal === undefined || dependencies.catalog === undefined) return respond(response, 403, { code: "target_not_authorized" });
        return respond(response, 200, { releases: await dependencies.catalog.listReleases(kind as ResourceRelease["kind"] | undefined) });
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
      if (dependencies.releases === undefined) return respond(response, 503, { code: "migration_not_ready" });
      const auditEventId = request.headers["x-request-id"];
      if (typeof auditEventId !== "string" || auditEventId.trim() === "") return respond(response, 400, { code: "invalid_contract", message: "x-request-id is required" });
      if (request.method === "POST" && url.pathname === "/admin/v1/releases") {
        const body = await jsonBody(request) as { release?: Pick<ResourceRelease, "kind"> };
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, body.release?.kind === "skill" ? "skill.write" : "release.write");
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const command = body as Omit<PublishReleaseCommand, "actorId" | "auditEventId">;
        const release = await dependencies.releases.publish({ ...command, actorId: principal.actorId, auditEventId });
        return respond(response, 201, release);
      }
      if (request.method === "POST" && url.pathname === "/admin/v1/target-assignments") {
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
        const currentRelease = await dependencies.releases.getRelease(decodeURIComponent(transition[1]!));
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, currentRelease?.kind === "skill" ? "skill.write" : "release.write");
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<TransitionReleaseCommand, "releaseId" | "actorId" | "auditEventId">;
        const transitionedRelease = await dependencies.releases.transition({ ...body, releaseId: decodeURIComponent(transition[1]!), actorId: principal.actorId, auditEventId });
        return respond(response, 200, transitionedRelease);
      }
      if (request.method === "POST" && url.pathname === "/delivery/v1/apply-receipts") {
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<RecordApplyReceiptCommand, "actorId" | "auditEventId">;
        if (!sameTarget(body.receipt.target, principal.target)) return respond(response, 403, { code: "target_not_authorized" });
        await dependencies.releases.recordReceipt({ ...body, receipt: { ...body.receipt, target: principal.target }, actorId: principal.actorId, auditEventId });
        return respond(response, 201, { status: "recorded" });
      }
      if (request.method === "POST" && url.pathname === "/delivery/v1/skill-install-receipts") {
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<RecordSkillInstallReceiptCommand, "actorId" | "auditEventId">;
        if (body.receipt === undefined || !sameTarget(body.receipt.target, principal.target)) return respond(response, 403, { code: "target_not_authorized" });
        await dependencies.releases.recordSkillInstallReceipt({ ...body, receipt: { ...body.receipt, target: principal.target }, actorId: principal.actorId, auditEventId });
        return respond(response, 201, { status: "recorded" });
      }
      const operation = /^\/admin\/v1\/runtimes\/([^/]+)\/(drain|recover)$/.exec(url.pathname);
      if (request.method === "POST" && operation !== null) {
        const principal = await authorizedAdmin(dependencies.authorization, request.headers.authorization, "runtime.operate");
        if (principal === undefined || dependencies.runtimeOperations === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as { target?: RuntimeTarget; expectedRevision?: number };
        const expectedRevision = body.expectedRevision;
        if (body.target === undefined || body.target.runtimeId !== decodeURIComponent(operation[1]!) || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ControlPlaneError("invalid_contract", "Runtime operation target and expectedRevision are required");
        const input = { target: body.target, expectedRevision, actorId: principal.actorId, auditEventId };
        return respond(response, 200, operation[2] === "drain" ? await dependencies.runtimeOperations.drain(input) : await dependencies.runtimeOperations.recover(input));
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

function statusFor(code: ControlPlaneError["code"]): number {
  return code === "revision_conflict" || code === "scope_conflict" || code === "assignment_conflict" || code === "duplicate_release" ? 409
    : code === "target_not_authorized" ? 403
      : code === "migration_not_ready" ? 503 : 400;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function respondBytes(response: ServerResponse, status: number, body: Uint8Array, contentType: string): void {
  response.writeHead(status, { "content-type": contentType, "content-length": body.byteLength.toString() });
  response.end(Buffer.from(body));
}
