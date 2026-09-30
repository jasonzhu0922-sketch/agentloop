import type { AdminMember, AdminMemberStatus, ApplyReceipt, AuditEvent, ResourceKind, ResourceRelease, RuntimeConfigurationSnapshot, RuntimeOperationResult, RuntimeTarget, RuntimeTrace } from "../../../../control-plane/contracts/index.ts";

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

  public async members(tenantId: string): Promise<readonly AdminMember[]> {
    const response = await this.call(`/admin/v1/members?tenantId=${encodeURIComponent(tenantId)}`);
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

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.authorization !== undefined) headers.set("authorization", this.authorization);
    const response = await this.request(new URL(path, this.baseUrl), { ...init, headers });
    if (!response.ok) throw new Error(`Admin API request failed: HTTP ${response.status}`);
    return response;
  }
}

/** Type-only placeholders establish the future API boundary without invoking delivery APIs from the browser. */
export type AdminReadModels = Readonly<{
  snapshot: RuntimeConfigurationSnapshot;
  receipt: ApplyReceipt;
}>;
