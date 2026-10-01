import type { AdminMember, AdminMemberRole, AdminMemberStatus, ApplyReceipt, AuditEvent, ControlPlaneResource, CreateTargetAssignmentCommand, PublishReleaseCommand, ResourceKind, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeOperationResult, RuntimeTarget, RuntimeTrace, TransitionReleaseCommand } from "../../../../control-plane/contracts/index.ts";
export type AdminPermission = "member.read" | "member.write" | "release.read" | "release.write" | "skill.read" | "skill.write" | "runtime.operate" | "trace.read" | "audit.read";

export interface AdminSession {
  readonly actorId: string;
  readonly role: AdminMemberRole;
  readonly permissions: readonly AdminPermission[];
  readonly scopeId?: string;
}
export interface AdminLoginSession { readonly accessToken: string; readonly expiresAt: number; }

export class AdminApiError extends Error {
  public readonly status: number;
  public readonly code?: string;

  public constructor(status: number, code?: string) {
    super(code === undefined ? `Admin API request failed: HTTP ${status}` : `Admin API request failed: ${code}`);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
  }
}

/** The Admin Web can only speak to the independently deployed Admin API. */
export class AdminApiClient {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;
  private readonly authorization?: string;

  public constructor(baseUrl: string, request: typeof fetch = fetch, authorization?: string) {
    this.baseUrl = baseUrl;
    this.request = request;
    this.authorization = authorization;
  }

  public async health(): Promise<{ readonly status: string }> {
    const response = await this.call("/healthz");
    return await response.json() as { readonly status: string };
  }

  public async session(): Promise<AdminSession> {
    const response = await this.call("/admin/v1/session");
    return await response.json() as AdminSession;
  }

  public async login(username: string, password: string): Promise<AdminLoginSession> {
    const response = await this.call("/admin/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    return await response.json() as AdminLoginSession;
  }

  public async resources(): Promise<readonly ControlPlaneResource[]> {
    const response = await this.call("/admin/v1/resources");
    return (await response.json() as { resources: readonly ControlPlaneResource[] }).resources;
  }

  public async members(scopeId: string): Promise<readonly AdminMember[]> {
    const response = await this.call(`/admin/v1/members?scopeId=${encodeURIComponent(scopeId)}`);
    return (await response.json() as { members: readonly AdminMember[] }).members;
  }

  public async releases(kind?: ResourceKind): Promise<readonly ResourceRelease[]> {
    const response = await this.call(`/admin/v1/releases${kind === undefined ? "" : `?kind=${encodeURIComponent(kind)}`}`);
    return (await response.json() as { releases: readonly ResourceRelease[] }).releases;
  }

  public async auditEvents(limit = 50): Promise<readonly AuditEvent[]> {
    const response = await this.call(`/admin/v1/audit-events?limit=${limit}`);
    return (await response.json() as { events: readonly AuditEvent[] }).events;
  }

  public async trace(runId: string): Promise<RuntimeTrace> {
    const response = await this.call(`/admin/v1/runs/${encodeURIComponent(runId)}/trace`);
    return await response.json() as RuntimeTrace;
  }

  public async transitionMember(memberId: string, status: AdminMemberStatus, expectedRevision: number, requestId: string): Promise<AdminMember> {
    const response = await this.call(`/admin/v1/members/${encodeURIComponent(memberId)}/transitions`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ status, expectedRevision }) });
    return await response.json() as AdminMember;
  }

  public async runtimeOperation(runtimeId: string, operation: "drain" | "recover", target: RuntimeTarget, expectedRevision: number, requestId: string): Promise<RuntimeOperationResult> {
    const response = await this.call(`/admin/v1/runtimes/${encodeURIComponent(runtimeId)}/${operation}`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ target, expectedRevision }) });
    return await response.json() as RuntimeOperationResult;
  }

  public async createMember(member: AdminMember, expectedRevision: number, requestId: string): Promise<AdminMember> {
    const response = await this.call("/admin/v1/members", { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ member, expectedRevision }) });
    return await response.json() as AdminMember;
  }

  public async publishRelease(command: Omit<PublishReleaseCommand, "actorId" | "auditEventId">, requestId: string): Promise<ResourceRelease> {
    const response = await this.call("/admin/v1/releases", { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify(command) });
    return await response.json() as ResourceRelease;
  }

  public async transitionRelease(releaseId: string, command: Omit<TransitionReleaseCommand, "releaseId" | "actorId" | "auditEventId">, requestId: string): Promise<ResourceRelease> {
    const response = await this.call(`/admin/v1/releases/${encodeURIComponent(releaseId)}/transitions`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify(command) });
    return await response.json() as ResourceRelease;
  }

  public async createTargetAssignment(command: Omit<CreateTargetAssignmentCommand, "actorId" | "auditEventId">, requestId: string): Promise<void> {
    await this.call("/admin/v1/target-assignments", { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify(command) });
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.authorization !== undefined) headers.set("authorization", this.authorization);
    const response = await this.request(new URL(path, this.baseUrl), { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { code?: string } | undefined;
      throw new AdminApiError(response.status, body?.code);
    }
    return response;
  }
}

/** Type-only placeholders establish the future API boundary without invoking delivery APIs from the browser. */
export type AdminReadModels = Readonly<{
  snapshot: RuntimeConfigurationSnapshot;
  receipt: ApplyReceipt;
}>;
