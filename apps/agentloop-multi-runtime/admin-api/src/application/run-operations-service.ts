import { ControlPlaneError } from "../../../control-plane/domain/index.ts";
import type { RouterRunDetail, RouterRunPage } from "../../../src/shared/contracts.ts";
import type { RunOperationsPort } from "./admin-ports.ts";

/** Admin API adapter for the Router's internal, token-protected operations projection. */
export class RouterRunOperationsService implements RunOperationsPort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly request: typeof fetch;

  constructor(input: { readonly baseUrl: string; readonly token: string; readonly request?: typeof fetch }) {
    this.baseUrl = input.baseUrl.replace(/\/$/, "");
    this.token = input.token;
    this.request = input.request ?? fetch;
  }

  async list(page: number, pageSize: number): Promise<RouterRunPage> {
    return await this.call(`/v1/internal/admin/runs?page=${page}&pageSize=${pageSize}`) as RouterRunPage;
  }

  async detail(id: string): Promise<RouterRunDetail> {
    // Router returns artifact metadata only. Content and download/preview
    // endpoints are deliberately not exposed through the Admin proxy.
    return await this.call(`/v1/internal/admin/runs/${encodeURIComponent(id)}`) as RouterRunDetail;
  }

  private async call(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(new URL(path, `${this.baseUrl}/`), { headers: { authorization: `Bearer ${this.token}` } });
    } catch {
      throw new ControlPlaneError("configuration_unavailable", "Router run operations are unavailable");
    }
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    if (!response.ok) {
      if (response.status === 404) throw new ControlPlaneError("configuration_unavailable", body?.error ?? "Run not found");
      throw new ControlPlaneError("configuration_unavailable", body?.error ?? `Router returned HTTP ${response.status}`);
    }
    return body;
  }
}
