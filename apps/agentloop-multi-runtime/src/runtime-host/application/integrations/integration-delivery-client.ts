import type { CredentialGrant, CredentialGrantRequest, IntegrationInvocationResponse } from "../../../../control-plane/contracts/index.ts";
import { IntegrationBrokerError, type IntegrationDeliveryPort } from "./integration-secret-broker.ts";

/** Workload-authenticated delivery adapter. It transports no secret material. */
export class RuntimeIntegrationDeliveryClient implements IntegrationDeliveryPort {
  private readonly input: { readonly deliveryUrl: string; readonly workloadToken: string; readonly request?: typeof fetch };

  public constructor(input: { readonly deliveryUrl: string; readonly workloadToken: string; readonly request?: typeof fetch }) {
    this.input = input;
  }

  public async requestGrant(request: CredentialGrantRequest): Promise<CredentialGrant> {
    return await this.post<CredentialGrant>("/delivery/v1/credential-grants", { request });
  }

  public async invoke(grant: CredentialGrant, invocation: CredentialGrantRequest, args: Readonly<Record<string, unknown>>): Promise<IntegrationInvocationResponse> {
    return await this.post<IntegrationInvocationResponse>("/delivery/v1/integration-invocations", {
      request: { contractVersion: "control-plane/v1", grantId: grant.grantId, invocation, args },
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await (this.input.request ?? fetch)(new URL(path, `${this.input.deliveryUrl.replace(/\/$/, "")}/`), {
        method: "POST", headers: { authorization: `Bearer ${this.input.workloadToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } catch { throw new IntegrationBrokerError("integration_upstream_failed"); }
    const parsed = await response.json().catch(() => undefined) as { code?: unknown } | undefined;
    if (!response.ok) {
      const code = parsed?.code;
      if (code === "integration_not_authorized" || code === "credential_grant_expired" || code === "integration_response_invalid") throw new IntegrationBrokerError(code);
      throw new IntegrationBrokerError("integration_upstream_failed");
    }
    return parsed as T;
  }
}
