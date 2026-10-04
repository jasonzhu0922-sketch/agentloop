import { ControlPlaneError } from "../../../control-plane/domain/index.ts";
import type { BusinessUserPage, BusinessUserSummary } from "../../../src/router/identity/service.ts";
import type { BusinessUserOperationsPort } from "./admin-ports.ts";

/** Authenticated Admin proxy for Router-owned business identities. */
export class RouterBusinessUserOperationsService implements BusinessUserOperationsPort {
  private readonly baseUrl: string; private readonly token: string; private readonly request: typeof fetch;
  constructor(input: { readonly baseUrl: string; readonly token: string; readonly request?: typeof fetch }) { this.baseUrl = input.baseUrl.replace(/\/$/, ""); this.token = input.token; this.request = input.request ?? fetch; }
  list(page: number, pageSize: number): Promise<BusinessUserPage> { return this.call(`/v1/internal/admin/users?page=${page}&pageSize=${pageSize}`) as Promise<BusinessUserPage>; }
  suspend(id: string): Promise<BusinessUserSummary> { return this.call(`/v1/internal/admin/users/${encodeURIComponent(id)}/suspend`, { method: "POST" }) as Promise<BusinessUserSummary>; }
  resetPassword(id: string, password: string): Promise<BusinessUserSummary> { return this.call(`/v1/internal/admin/users/${encodeURIComponent(id)}/password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }) as Promise<BusinessUserSummary>; }
  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response; try { response = await this.request(new URL(path, `${this.baseUrl}/`), { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.token}` } }); } catch { throw new ControlPlaneError("configuration_unavailable", "Router business user operations are unavailable"); }
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    if (!response.ok) throw new ControlPlaneError(response.status === 404 ? "configuration_unavailable" : "invalid_contract", body?.error ?? `Router returned HTTP ${response.status}`);
    return body;
  }
}
