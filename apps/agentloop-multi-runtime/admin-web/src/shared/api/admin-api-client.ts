import type { AdminMember, AdminMemberRole, AdminMemberStatus, AdminSkillAgentLoopMetadata, AdminUser, AdminUserStatus, ApplyReceipt, AuditEvent, ControlPlaneResource, CreateTargetAssignmentCommand, PublishReleaseCommand, ResourceKind, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeInventoryPage, RuntimeOperationResult, RuntimeTarget, RuntimeTrace, TransitionReleaseCommand } from "../../../../control-plane/contracts/index.ts";
import type { RouterRunDetail, RouterRunPage } from "../../../../src/shared/contracts.ts";
export interface BusinessUserSummary { readonly id: string; readonly email: string; readonly tenantId: string; readonly status: "active" | "suspended"; readonly createdAt: number; readonly lastActiveAt?: number; readonly usageAvailable: false; }
export interface BusinessUserPage { readonly items: readonly BusinessUserSummary[]; readonly page: number; readonly pageSize: number; readonly total: number; readonly pageCount: number; }
export interface AdminModelSummary {
  readonly key: string;
  readonly displayName: string;
  readonly providerKey: string;
  readonly providerModel: string;
  readonly protocol: "chat-completions" | "responses";
  readonly releaseId: string;
  readonly releaseState: string;
  readonly version: number;
  readonly defaultModel: boolean;
  readonly baseUrl: string;
  readonly apiKeyConfigured: boolean;
  readonly apiKeyEnv?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly parameters: Readonly<Record<string, unknown>>;
}
export interface AdminProviderSummary {
  readonly key: string;
  readonly kind: "openai-compatible";
  readonly baseUrl: string;
  readonly protocol: "chat-completions" | "responses";
  readonly apiKeyConfigured: boolean;
  readonly defaultProvider: boolean;
  readonly releaseId: string;
  readonly releaseState: string;
  readonly version: number;
  readonly models: readonly AdminModelSummary[];
}
export interface RegisterModelInput {
  readonly modelKey: string;
  readonly displayName: string;
  readonly providerKey: string;
  readonly providerModel: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly protocol: "chat-completions" | "responses";
  readonly defaultModel?: boolean;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
}
export interface RegisterProviderInput {
  readonly providerKey: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly protocol: "chat-completions" | "responses";
  readonly defaultProvider?: boolean;
}
export interface AdminSkillSummary { readonly name: string; readonly description: string; readonly version?: string; readonly packageHash: string; readonly fileCount: number; readonly totalBytes: number; readonly agentLoop?: AdminSkillAgentLoopMetadata; }
export interface AdminSkillDetail extends AdminSkillSummary { readonly skillMd: string; readonly files: readonly string[]; }
export interface AdminSkillPage { readonly items: readonly AdminSkillSummary[]; readonly page: number; readonly pageSize: number; readonly total: number; readonly pageCount: number; }
export type AdminPermission = "user.read" | "user.write" | "member.read" | "member.write" | "release.read" | "release.write" | "skill.read" | "skill.write" | "runtime.operate" | "trace.read" | "audit.read";

export interface AdminSession {
  readonly actorId: string;
  readonly role: AdminMemberRole;
  readonly permissions: readonly AdminPermission[];
  readonly scopeId?: string;
}
export interface AdminLoginSession { readonly accessToken: string; readonly expiresAt: number; }
export interface AdminApiHealth {
  readonly status: "ok";
  readonly service: "agentloop-admin-api";
  readonly phase: string;
}

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

  public async health(): Promise<AdminApiHealth> {
    const response = await this.call("/healthz");
    const health = await response.json() as Partial<AdminApiHealth>;
    if (health.status !== "ok" || health.service !== "agentloop-admin-api" || typeof health.phase !== "string") {
      throw new Error("Unexpected Admin API health response");
    }
    return health as AdminApiHealth;
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

  public async users(): Promise<readonly AdminUser[]> {
    const response = await this.call("/admin/v1/users");
    return (await response.json() as { users: readonly AdminUser[] }).users;
  }

  public async businessUsers(page = 1, pageSize = 20): Promise<BusinessUserPage> {
    const response = await this.call(`/admin/v1/business-users?page=${page}&pageSize=${pageSize}`);
    return await response.json() as BusinessUserPage;
  }
  public async suspendBusinessUser(id: string): Promise<BusinessUserSummary> {
    const response = await this.call(`/admin/v1/business-users/${encodeURIComponent(id)}/suspend`, { method: "POST" });
    return await response.json() as BusinessUserSummary;
  }
  public async resetBusinessUserPassword(id: string, password: string): Promise<BusinessUserSummary> {
    const response = await this.call(`/admin/v1/business-users/${encodeURIComponent(id)}/password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    return await response.json() as BusinessUserSummary;
  }

  public async createUser(user: AdminUser, password: string, requestId: string): Promise<AdminUser> {
    const response = await this.call("/admin/v1/users", { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ user, password, expectedRevision: 0 }) });
    return await response.json() as AdminUser;
  }

  public async updateUser(userId: string, input: { readonly displayName: string; readonly scopeId?: string; readonly role: AdminMemberRole; readonly expectedRevision: number }, requestId: string): Promise<AdminUser> {
    const response = await this.call(`/admin/v1/users/${encodeURIComponent(userId)}`, { method: "PUT", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify(input) });
    return await response.json() as AdminUser;
  }

  public async transitionUser(userId: string, status: AdminUserStatus, expectedRevision: number, requestId: string): Promise<AdminUser> {
    const response = await this.call(`/admin/v1/users/${encodeURIComponent(userId)}/transitions`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ status, expectedRevision }) });
    return await response.json() as AdminUser;
  }

  public async resetUserPassword(userId: string, password: string, expectedRevision: number, requestId: string): Promise<AdminUser> {
    const response = await this.call(`/admin/v1/users/${encodeURIComponent(userId)}/password`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ password, expectedRevision }) });
    return await response.json() as AdminUser;
  }

  public async releases(kind?: ResourceKind): Promise<readonly ResourceRelease[]> {
    const response = await this.call(`/admin/v1/releases${kind === undefined ? "" : `?kind=${encodeURIComponent(kind)}`}`);
    return (await response.json() as { releases: readonly ResourceRelease[] }).releases;
  }

  public async models(): Promise<readonly AdminModelSummary[]> {
    const response = await this.call("/admin/v1/models");
    return (await response.json() as { models: readonly AdminModelSummary[] }).models;
  }

  public async providers(): Promise<readonly AdminProviderSummary[]> {
    const response = await this.call("/admin/v1/providers");
    return (await response.json() as { providers: readonly AdminProviderSummary[] }).providers;
  }

  public async registerProvider(provider: RegisterProviderInput, requestId: string, expectedRevision?: number): Promise<ResourceRelease> {
    const response = await this.call("/admin/v1/providers", { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ provider, ...(expectedRevision === undefined ? {} : { expectedRevision }) }) });
    return await response.json() as ResourceRelease;
  }

  public async setDefaultProvider(providerKey: string, requestId: string, expectedRevision?: number): Promise<ResourceRelease> {
    const response = await this.call(`/admin/v1/providers/${encodeURIComponent(providerKey)}/default`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify(expectedRevision === undefined ? {} : { expectedRevision }) });
    return await response.json() as ResourceRelease;
  }

  public async skills(page = 1, pageSize = 12): Promise<AdminSkillPage> {
    const response = await this.call(`/admin/v1/skills?page=${page}&pageSize=${pageSize}`);
    return await response.json() as AdminSkillPage;
  }

  public async skill(name: string): Promise<AdminSkillDetail> {
    const response = await this.call(`/admin/v1/skills/${encodeURIComponent(name)}`);
    return await response.json() as AdminSkillDetail;
  }

  public async auditEvents(limit = 50): Promise<readonly AuditEvent[]> {
    const response = await this.call(`/admin/v1/audit-events?limit=${limit}`);
    return (await response.json() as { events: readonly AuditEvent[] }).events;
  }

  public async trace(runId: string): Promise<RuntimeTrace> {
    const response = await this.call(`/admin/v1/runs/${encodeURIComponent(runId)}/trace`);
    return await response.json() as RuntimeTrace;
  }

  public async runs(page = 1, pageSize = 20): Promise<RouterRunPage> {
    const response = await this.call(`/admin/v1/runs?page=${page}&pageSize=${pageSize}`);
    return await response.json() as RouterRunPage;
  }

  public async run(id: string): Promise<RouterRunDetail> {
    const response = await this.call(`/admin/v1/runs/${encodeURIComponent(id)}`);
    return await response.json() as RouterRunDetail;
  }

  public async runtimes(page = 1, pageSize = 20): Promise<RuntimeInventoryPage> {
    const response = await this.call(`/admin/v1/runtimes?page=${page}&pageSize=${pageSize}`);
    return await response.json() as RuntimeInventoryPage;
  }

  public async transitionMember(memberId: string, status: AdminMemberStatus, expectedRevision: number, requestId: string): Promise<AdminMember> {
    const response = await this.call(`/admin/v1/members/${encodeURIComponent(memberId)}/transitions`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ status, expectedRevision }) });
    return await response.json() as AdminMember;
  }

  public async runtimeOperation(runtimeId: string, operation: "drain" | "recover" | "restart", target: RuntimeTarget, expectedRevision: number, requestId: string): Promise<RuntimeOperationResult> {
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

  public async registerModel(model: RegisterModelInput, requestId: string, expectedRevision?: number): Promise<ResourceRelease> {
    const response = await this.call("/admin/v1/models", { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ model, ...(expectedRevision === undefined ? {} : { expectedRevision }) }) });
    return await response.json() as ResourceRelease;
  }

  public async updateModel(modelKey: string, model: RegisterModelInput, requestId: string, expectedRevision?: number): Promise<ResourceRelease> {
    const response = await this.call(`/admin/v1/models/${encodeURIComponent(modelKey)}`, { method: "PUT", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ model, ...(expectedRevision === undefined ? {} : { expectedRevision }) }) });
    return await response.json() as ResourceRelease;
  }

  public async deleteModel(modelKey: string, requestId: string, expectedRevision?: number): Promise<ResourceRelease> {
    const response = await this.call(`/admin/v1/models/${encodeURIComponent(modelKey)}`, {
      method: "DELETE",
      headers: { "x-request-id": requestId, ...(expectedRevision === undefined ? {} : { "x-expected-revision": String(expectedRevision) }) },
    });
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
