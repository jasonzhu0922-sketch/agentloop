import type { ApplyReceipt, RuntimeConfigurationSnapshot } from "../../../../control-plane/contracts/index.ts";

/** The Admin Web can only speak to the independently deployed Admin API. */
export class AdminApiClient {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;

  public constructor(baseUrl: string, request: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.request = request;
  }

  public async health(): Promise<{ readonly status: string }> {
    const response = await this.request(new URL("/healthz", this.baseUrl));
    if (!response.ok) throw new Error("Admin API health request failed");
    return await response.json() as { readonly status: string };
  }
}

/** Type-only placeholders establish the future API boundary without invoking delivery APIs from the browser. */
export type AdminReadModels = Readonly<{
  snapshot: RuntimeConfigurationSnapshot;
  receipt: ApplyReceipt;
}>;
