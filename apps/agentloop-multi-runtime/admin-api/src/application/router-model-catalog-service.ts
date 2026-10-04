import { ControlPlaneError } from "../../../control-plane/domain/index.ts";
import type { ResourceRelease } from "../../../control-plane/contracts/index.ts";
import type { AdminModelSummary, AdminProviderSummary, ModelCatalogPort, RegisterModelInput, RegisterProviderInput } from "./model-catalog-service.ts";

interface RouterCatalogView {
  readonly revision: number;
  readonly contentHash: string;
  readonly providers: readonly {
    readonly key: string;
    readonly baseUrl: string;
    readonly protocol: "chat-completions" | "responses";
    readonly apiKeyConfigured: boolean;
    readonly defaultProvider: boolean;
    readonly models: readonly {
      readonly key: string;
      readonly displayName: string;
      readonly providerKey: string;
      readonly providerModel: string;
      readonly protocol: "chat-completions" | "responses";
      readonly defaultModel: boolean;
      readonly contextWindowTokens?: number;
      readonly maxOutputTokens?: number;
      readonly parameters: Readonly<Record<string, unknown>>;
    }[];
  }[];
}

export interface RouterModelConfiguration {
  readonly revision: number;
  readonly contentHash: string;
  readonly providerConfiguration: Readonly<Record<string, unknown>>;
}

/** Admin adapter for the Router-owned model catalog. It never persists model state in cp_releases. */
export class RouterModelCatalogService implements ModelCatalogPort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly request: typeof fetch;

  public constructor(input: { readonly baseUrl: string; readonly token: string; readonly request?: typeof fetch }) {
    this.baseUrl = input.baseUrl.replace(/\/$/, "");
    this.token = input.token;
    this.request = input.request ?? fetch;
  }

  public async list(): Promise<readonly AdminModelSummary[]> {
    const view = await this.view();
    return view.providers.flatMap((provider) => provider.models.map((model) => this.modelSummary(view, provider, model))).sort((left, right) => left.key.localeCompare(right.key));
  }

  public async listProviders(): Promise<readonly AdminProviderSummary[]> {
    const view = await this.view();
    return view.providers.map((provider) => ({
      key: provider.key, kind: "openai-compatible" as const, baseUrl: provider.baseUrl, protocol: provider.protocol,
      apiKeyConfigured: provider.apiKeyConfigured, defaultProvider: provider.defaultProvider,
      releaseId: releaseId(view), releaseState: "active", version: view.revision,
      models: provider.models.map((model) => this.modelSummary(view, provider, model)),
    }));
  }

  public async registerProvider(input: RegisterProviderInput, _actorId: string, _auditEventId: string, _expectedRevision?: number): Promise<unknown> {
    const view = await this.call("/v1/internal/model-providers", { method: "POST", body: input });
    return releaseFromView(view as RouterCatalogView);
  }

  public async setDefaultProvider(providerKey: string, _actorId: string, _auditEventId: string, _expectedRevision?: number): Promise<unknown> {
    const provider = (await this.view()).providers.find((item) => item.key === providerKey);
    if (provider === undefined) throw new ControlPlaneError("invalid_contract", "Provider not found");
    return releaseFromView(await this.call("/v1/internal/model-providers", { method: "POST", body: { providerKey: provider.key, baseUrl: provider.baseUrl, protocol: provider.protocol, defaultProvider: true } }) as RouterCatalogView);
  }

  public async register(input: RegisterModelInput, _actorId: string, _auditEventId: string, _expectedRevision?: number): Promise<unknown> {
    const body = {
      modelKey: input.modelKey, displayName: input.displayName, providerKey: input.providerKey, providerModel: input.providerModel,
      ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
      ...(input.contextWindowTokens === undefined ? {} : { contextWindowTokens: input.contextWindowTokens }),
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    };
    return releaseFromView(await this.call("/v1/internal/model-models/" + encodeURIComponent(input.modelKey), { method: "POST", body }) as RouterCatalogView);
  }

  public async update(modelKey: string, input: RegisterModelInput, actorId: string, auditEventId: string, expectedRevision?: number): Promise<unknown> {
    if (modelKey !== input.modelKey) throw new ControlPlaneError("invalid_contract", "modelKey cannot change during edit");
    return await this.register(input, actorId, auditEventId, expectedRevision);
  }

  public async remove(modelKey: string, _actorId: string, _auditEventId: string, _expectedRevision?: number): Promise<unknown> {
    return releaseFromView(await this.call("/v1/internal/model-models/" + encodeURIComponent(modelKey), { method: "DELETE" }) as RouterCatalogView);
  }

  private async view(): Promise<RouterCatalogView> { return await this.call("/v1/internal/model-catalog") as RouterCatalogView; }

  /** Full workload configuration used when building Local/Cloud snapshots. */
  public async configuration(): Promise<RouterModelConfiguration> {
    return await this.call("/v1/internal/model-configuration") as RouterModelConfiguration;
  }

  private modelSummary(view: RouterCatalogView, provider: RouterCatalogView["providers"][number], model: RouterCatalogView["providers"][number]["models"][number]): AdminModelSummary {
    return {
      key: model.key, displayName: model.displayName, providerKey: model.providerKey, providerModel: model.providerModel, protocol: model.protocol,
      releaseId: releaseId(view), releaseState: "active", version: view.revision, defaultModel: model.defaultModel,
      baseUrl: provider.baseUrl, apiKeyConfigured: provider.apiKeyConfigured,
      ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }), parameters: model.parameters,
    };
  }

  private async call(path: string, init: { readonly method?: "POST" | "DELETE"; readonly body?: unknown } = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(new URL(path, `${this.baseUrl}/`), {
        method: init.method ?? "GET", headers: { authorization: `Bearer ${this.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch { throw new ControlPlaneError("configuration_unavailable", "Router model catalog is unavailable"); }
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    if (!response.ok) throw new ControlPlaneError("configuration_unavailable", body?.error ?? `Router returned HTTP ${response.status}`);
    return body;
  }
}

function releaseId(view: RouterCatalogView): string { return `router-model-catalog:${view.revision}`; }
function releaseFromView(view: RouterCatalogView): ResourceRelease {
  return {
    contractVersion: "control-plane/v1", resourceId: "router-model-catalog", releaseId: releaseId(view), version: view.revision,
    kind: "model_route", schemaVersion: "router-model-catalog/v1", contentHash: view.contentHash, authorId: "router", createdAt: Date.now(), state: "active",
    payload: { revision: view.revision, contentHash: view.contentHash },
  };
}
