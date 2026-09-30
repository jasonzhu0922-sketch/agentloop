import type { IncomingMessage, ServerResponse } from "node:http";
import type { CreateTargetAssignmentCommand, PublishReleaseCommand, RecordApplyReceiptCommand, TransitionReleaseCommand } from "../../../../control-plane/contracts/index.ts";
import { ControlPlaneError } from "../../../../control-plane/domain/index.ts";
import type { AdminAuthorizationPort } from "../../authorization/ports.ts";
import type { ReleaseApplicationService } from "../../application/release-service.ts";
import { adminApiHealth } from "./health.ts";

export interface AdminHttpDependencies {
  readonly authorization: AdminAuthorizationPort;
  /** Undefined means the process has no configured, migration-ready control-plane database. */
  readonly releases?: ReleaseApplicationService;
}

/** HTTP does only decoding, principal derivation, and response encoding. Release rules stay in application/domain. */
export function createAdminHttpHandler(dependencies: AdminHttpDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://admin-api.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") return respond(response, 200, adminApiHealth());
      if (dependencies.releases === undefined) return respond(response, 503, { code: "migration_not_ready" });
      const auditEventId = request.headers["x-request-id"];
      if (typeof auditEventId !== "string" || auditEventId.trim() === "") return respond(response, 400, { code: "invalid_contract", message: "x-request-id is required" });
      if (request.method === "POST" && url.pathname === "/admin/v1/releases") {
        const principal = await dependencies.authorization.adminPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request);
        const command = body as Omit<PublishReleaseCommand, "actorId" | "auditEventId">;
        const release = await dependencies.releases.publish({ ...command, actorId: principal.actorId, auditEventId });
        return respond(response, 201, release);
      }
      if (request.method === "POST" && url.pathname === "/admin/v1/target-assignments") {
        const principal = await dependencies.authorization.adminPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request);
        await dependencies.releases.assign({ ...(body as Omit<CreateTargetAssignmentCommand, "actorId" | "auditEventId">), actorId: principal.actorId, auditEventId });
        return respond(response, 201, { status: "created" });
      }
      const transition = /^\/admin\/v1\/releases\/([^/]+)\/transitions$/.exec(url.pathname);
      if (request.method === "POST" && transition !== null) {
        const principal = await dependencies.authorization.adminPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<TransitionReleaseCommand, "releaseId" | "actorId" | "auditEventId">;
        const release = await dependencies.releases.transition({ ...body, releaseId: decodeURIComponent(transition[1]!), actorId: principal.actorId, auditEventId });
        return respond(response, 200, release);
      }
      if (request.method === "POST" && url.pathname === "/delivery/v1/apply-receipts") {
        const principal = await dependencies.authorization.workloadPrincipal(request.headers.authorization);
        if (principal === undefined) return respond(response, 403, { code: "target_not_authorized" });
        const body = await jsonBody(request) as Omit<RecordApplyReceiptCommand, "actorId" | "auditEventId">;
        if (!sameTarget(body.receipt.target, principal.target)) return respond(response, 403, { code: "target_not_authorized" });
        await dependencies.releases.recordReceipt({ ...body, receipt: { ...body.receipt, target: principal.target }, actorId: principal.actorId, auditEventId });
        return respond(response, 201, { status: "recorded" });
      }
      return respond(response, 404, { code: "not_found" });
    } catch (error) {
      if (error instanceof ControlPlaneError) return respond(response, statusFor(error.code), { code: error.code });
      return respond(response, 400, { code: "invalid_contract" });
    }
  };
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

function sameTarget(left: { plane: string; tenantId: string; runtimeId: string; deviceId?: string }, right: { plane: string; tenantId: string; runtimeId: string; deviceId?: string }): boolean {
  return left.plane === right.plane && left.tenantId === right.tenantId && left.runtimeId === right.runtimeId && left.deviceId === right.deviceId;
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
