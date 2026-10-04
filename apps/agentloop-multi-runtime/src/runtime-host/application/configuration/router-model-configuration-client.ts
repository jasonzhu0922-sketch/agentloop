import type { RuntimeTarget } from "../../../../control-plane/contracts/index.ts";

export interface RouterModelConfiguration {
  readonly revision: number;
  readonly contentHash: string;
  readonly providerConfiguration: Readonly<Record<string, unknown>>;
}

/** Workload-only model configuration client. Router is the authority for provider/model runtime state. */
export class RouterModelConfigurationClient {
  private readonly routerUrl: string;
  private readonly token: string;
  private readonly request: typeof fetch;

  public constructor(input: { readonly routerUrl: string; readonly workloadToken: string; readonly request?: typeof fetch }) {
    this.routerUrl = input.routerUrl.replace(/\/$/, "");
    this.token = input.workloadToken;
    this.request = input.request ?? fetch;
  }

  public async current(_target?: RuntimeTarget): Promise<RouterModelConfiguration> {
    const response = await this.request(new URL("/v1/internal/model-configuration", `${this.routerUrl}/`), { headers: { authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`Router model configuration returned HTTP ${response.status}`);
    const value = await response.json() as Partial<RouterModelConfiguration>;
    if (!Number.isSafeInteger(value.revision) || typeof value.contentHash !== "string" || value.providerConfiguration === null || typeof value.providerConfiguration !== "object" || Array.isArray(value.providerConfiguration)) {
      throw new Error("Router returned an invalid model configuration");
    }
    return value as RouterModelConfiguration;
  }
}
