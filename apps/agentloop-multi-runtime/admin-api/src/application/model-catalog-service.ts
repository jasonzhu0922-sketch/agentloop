import { randomUUID } from "node:crypto";
import type { ResourceRelease } from "../../../control-plane/contracts/index.ts";
import { ControlPlaneError } from "../../../control-plane/domain/index.ts";
import type { AdminCatalogPort } from "./admin-ports.ts";
import { contentHashForRelease, ReleaseApplicationService } from "./release-service.ts";

export interface AdminModelSummary {
  readonly key: string;
  readonly displayName: string;
  readonly providerKey: string;
  readonly providerModel: string;
  readonly protocol: "chat-completions" | "responses";
  readonly releaseId: string;
  readonly releaseState: ResourceRelease["state"];
  readonly version: number;
  readonly defaultModel: boolean;
  readonly baseUrl: string;
  /** True when the provider has a direct key in the control-plane config. The key is never returned. */
  readonly apiKeyConfigured: boolean;
  /** Legacy projection only; new Admin writes use apiKey on the provider. */
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
  readonly releaseState: ResourceRelease["state"];
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

export interface ModelCatalogPort {
  list(): Promise<readonly AdminModelSummary[]>;
  listProviders(): Promise<readonly AdminProviderSummary[]>;
  registerProvider(input: RegisterProviderInput, actorId: string, auditEventId: string, expectedRevision?: number): Promise<unknown>;
  setDefaultProvider(providerKey: string, actorId: string, auditEventId: string, expectedRevision?: number): Promise<unknown>;
  register(input: RegisterModelInput, actorId: string, auditEventId: string, expectedRevision?: number): Promise<unknown>;
  update(modelKey: string, input: RegisterModelInput, actorId: string, auditEventId: string, expectedRevision?: number): Promise<unknown>;
  remove(modelKey: string, actorId: string, auditEventId: string, expectedRevision?: number): Promise<unknown>;
}

/** Model registration is a Model Route Release mutation, never a direct runtime write. */
export class ModelCatalogApplicationService implements ModelCatalogPort {
  private readonly catalog: AdminCatalogPort;
  private readonly releases: ReleaseApplicationService;

  public constructor(catalog: AdminCatalogPort, releases: ReleaseApplicationService) {
    this.catalog = catalog;
    this.releases = releases;
  }

  public async list(): Promise<readonly AdminModelSummary[]> {
    const releases = await this.catalog.listReleases("model_route");
    const latest = releases.slice().sort((left, right) => right.createdAt - left.createdAt || right.version - left.version)[0];
    return latest === undefined ? [] : modelsFromRelease(latest).slice().sort((left, right) => left.key.localeCompare(right.key));
  }

  public async listProviders(): Promise<readonly AdminProviderSummary[]> {
    const releases = await this.catalog.listReleases("model_route");
    const latest = releases.slice().sort((left, right) => right.createdAt - left.createdAt || right.version - left.version)[0];
    return latest === undefined ? [] : providersFromRelease(latest);
  }

  public async registerProvider(input: RegisterProviderInput, actorId: string, auditEventId: string, expectedRevision?: number): Promise<ResourceRelease> {
    const routeReleases = await this.catalog.listReleases("model_route");
    const latest = routeReleases.slice().sort((left, right) => right.createdAt - left.createdAt || right.version - left.version)[0];
    const base = latest === undefined ? { defaultProvider: undefined, defaultModelKey: undefined, providers: {}, models: {} } : providerConfigurationFromRelease(latest);
    const existing = recordValue(base.providers[input.providerKey]);
    validateProviderInput(input, input.apiKey === undefined && Object.keys(existing).length === 0);
    const provider = { ...existing, kind: "openai-compatible", baseUrl: input.baseUrl, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey, apiKeyEnv: undefined }), protocol: input.protocol };
    return await this.publishConfiguration({ ...base, defaultProvider: input.defaultProvider === true || base.defaultProvider === undefined ? input.providerKey : base.defaultProvider, providers: { ...base.providers, [input.providerKey]: provider } }, latest, actorId, auditEventId, expectedRevision);
  }

  public async setDefaultProvider(providerKey: string, actorId: string, auditEventId: string, expectedRevision?: number): Promise<ResourceRelease> {
    const routeReleases = await this.catalog.listReleases("model_route");
    const latest = routeReleases.slice().sort((left, right) => right.createdAt - left.createdAt || right.version - left.version)[0];
    if (latest === undefined) throw new ControlPlaneError("invalid_contract", "No model route is registered");
    const base = providerConfigurationFromRelease(latest);
    if (!record(base.providers[providerKey])) throw new ControlPlaneError("invalid_contract", `Unknown Provider ${providerKey}`);
    if (base.defaultProvider === providerKey) return latest;
    return await this.publishConfiguration({ ...base, defaultProvider: providerKey }, latest, actorId, auditEventId, expectedRevision);
  }

  /**
   * Imports the deployment-owned provider document exactly once as the first
   * model-route draft. Runtime Hosts may still be running in file mode; this
   * creates the Admin catalog projection without silently activating it.
   */
  public async seedFromProviderConfiguration(configuration: unknown, actorId: string, auditEventId: string): Promise<ResourceRelease | undefined> {
    const routeReleases = await this.catalog.listReleases("model_route");
    if (routeReleases.length > 0) return undefined;
    const providerConfiguration = normalizeProviderConfiguration(configuration);
    const release = {
      contractVersion: "control-plane/v1" as const,
      resourceId: "model-route",
      releaseId: `model-route-bootstrap-${randomUUID()}`,
      version: 1,
      kind: "model_route" as const,
      schemaVersion: "model-route/v1",
      contentHash: contentHashForRelease({ kind: "model_route", schemaVersion: "model-route/v1", payload: { providerConfiguration } }),
      authorId: actorId,
      createdAt: Date.now(),
      state: "draft" as const,
      payload: { providerConfiguration },
    };
    return await this.releases.publish({ release, expectedRevision: 0, actorId, auditEventId });
  }

  public async register(input: RegisterModelInput, actorId: string, auditEventId: string, expectedRevision?: number): Promise<ResourceRelease> {
    validateModelInput(input);
    const routeReleases = await this.catalog.listReleases("model_route");
    const latest = routeReleases.slice().sort((left, right) => right.createdAt - left.createdAt || right.version - left.version)[0];
    const resources = await this.catalog.listResources();
    const resourceId = latest?.resourceId ?? "model-route";
    const resourceRevision = resources.find((resource) => resource.resourceId === resourceId)?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== resourceRevision) {
      throw new ControlPlaneError("revision_conflict", `Model route expected revision ${expectedRevision}, found ${resourceRevision}`);
    }
    const base = latest === undefined ? emptyProviderConfiguration(input) : providerConfigurationFromRelease(latest);
    const existingProvider = recordValue(base.providers[input.providerKey]);
    if (Object.keys(existingProvider).length === 0 && input.apiKey === undefined && input.apiKeyEnv === undefined) {
      throw new ControlPlaneError("invalid_contract", `Provider ${input.providerKey} must be registered before adding a model`);
    }
    const provider = {
      ...existingProvider,
      kind: "openai-compatible",
      baseUrl: input.baseUrl,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey, apiKeyEnv: undefined }),
      ...(input.apiKey === undefined && input.apiKeyEnv === undefined ? {} : input.apiKey === undefined ? { apiKeyEnv: input.apiKeyEnv } : {}),
      defaultModel: typeof existingProvider.defaultModel === "string" ? existingProvider.defaultModel : input.providerModel,
      protocol: input.protocol,
    };
    const model = {
      ...(input.parameters ?? {}),
      providerKey: input.providerKey,
      providerModel: input.providerModel,
      displayName: input.displayName,
      protocol: input.protocol,
      ...(input.contextWindowTokens === undefined ? {} : { contextWindowTokens: input.contextWindowTokens }),
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    };
    const defaultModelKey = input.defaultModel === true || base.defaultModelKey === undefined ? input.modelKey : base.defaultModelKey;
    const providerConfiguration = {
      defaultProvider: input.defaultModel === true || base.defaultProvider === undefined ? input.providerKey : base.defaultProvider,
      defaultModelKey,
      providers: { ...base.providers, [input.providerKey]: provider },
      models: { ...base.models, [input.modelKey]: model },
    };
    const version = (latest?.version ?? 0) + 1;
    const release = {
      contractVersion: "control-plane/v1" as const,
      resourceId,
      releaseId: `model-route-${randomUUID()}`,
      version,
      kind: "model_route" as const,
      schemaVersion: "model-route/v1",
      contentHash: contentHashForRelease({ kind: "model_route", schemaVersion: "model-route/v1", payload: { providerConfiguration } }),
      authorId: actorId,
      createdAt: Date.now(),
      state: "draft" as const,
      payload: { providerConfiguration },
    };
    return await this.releases.publish({ release, expectedRevision: resourceRevision, actorId, auditEventId });
  }

  public async update(modelKey: string, input: RegisterModelInput, actorId: string, auditEventId: string, expectedRevision?: number): Promise<ResourceRelease> {
    if (modelKey !== input.modelKey) throw new ControlPlaneError("invalid_contract", "modelKey cannot change during edit");
    return await this.register(input, actorId, auditEventId, expectedRevision);
  }

  public async remove(modelKey: string, actorId: string, auditEventId: string, expectedRevision?: number): Promise<ResourceRelease> {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(modelKey)) throw new ControlPlaneError("invalid_contract", "modelKey has an invalid format");
    const routeReleases = await this.catalog.listReleases("model_route");
    const latest = routeReleases.slice().sort((left, right) => right.createdAt - left.createdAt || right.version - left.version)[0];
    if (latest === undefined) throw new ControlPlaneError("invalid_contract", `Unknown model ${modelKey}`);
    const base = providerConfigurationFromRelease(latest);
    if (!Object.hasOwn(base.models, modelKey)) throw new ControlPlaneError("invalid_contract", `Unknown model ${modelKey}`);
    const models = Object.fromEntries(Object.entries(base.models).filter(([key]) => key !== modelKey));
    if (Object.keys(models).length === 0) throw new ControlPlaneError("invalid_contract", "The last registered model cannot be deleted");
    const nextDefaultModelKey = base.defaultModelKey === modelKey ? Object.keys(models)[0] : base.defaultModelKey;
    const nextDefault = nextDefaultModelKey === undefined || !record(models[nextDefaultModelKey]) || typeof models[nextDefaultModelKey]!.providerKey !== "string"
      ? base.defaultProvider : models[nextDefaultModelKey]!.providerKey;
    return await this.publishConfiguration({ ...base, defaultProvider: nextDefault, defaultModelKey: nextDefaultModelKey, models }, latest, actorId, auditEventId, expectedRevision);
  }

  private async publishConfiguration(configuration: { readonly defaultProvider?: string; readonly defaultModelKey?: string; readonly providers: Record<string, unknown>; readonly models: Record<string, unknown> }, latest: ResourceRelease | undefined, actorId: string, auditEventId: string, expectedRevision?: number): Promise<ResourceRelease> {
    const resources = await this.catalog.listResources();
    const resourceId = latest?.resourceId ?? "model-route";
    const resourceRevision = resources.find((resource) => resource.resourceId === resourceId)?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== resourceRevision) throw new ControlPlaneError("revision_conflict", `Model route expected revision ${expectedRevision}, found ${resourceRevision}`);
    const providerConfiguration = { defaultProvider: configuration.defaultProvider, defaultModelKey: configuration.defaultModelKey, providers: configuration.providers, models: configuration.models };
    const release = { contractVersion: "control-plane/v1" as const, resourceId, releaseId: `model-route-${randomUUID()}`, version: (latest?.version ?? 0) + 1, kind: "model_route" as const, schemaVersion: "model-route/v1", contentHash: contentHashForRelease({ kind: "model_route", schemaVersion: "model-route/v1", payload: { providerConfiguration } }), authorId: actorId, createdAt: Date.now(), state: "draft" as const, payload: { providerConfiguration } };
    return await this.releases.publish({ release, expectedRevision: resourceRevision, actorId, auditEventId });
  }
}

function modelsFromRelease(release: ResourceRelease): readonly AdminModelSummary[] {
  const configuration = providerConfigurationFromRelease(release);
  return Object.entries(configuration.models).map(([key, value]) => {
    if (!record(value) || typeof value.providerKey !== "string" || typeof value.providerModel !== "string" || typeof value.displayName !== "string") {
      throw new ControlPlaneError("invalid_contract", `Model route ${release.releaseId} contains an invalid model ${key}`);
    }
    const provider = configuration.providers[value.providerKey];
    const protocol = value.protocol ?? (record(provider) && provider.protocol === "responses" ? "responses" : "chat-completions");
    if (protocol !== "chat-completions" && protocol !== "responses") throw new ControlPlaneError("invalid_contract", `Model ${key} has an invalid protocol`);
    const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : record(provider) && typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    const apiKeyEnv = typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : record(provider) && typeof provider.apiKeyEnv === "string" ? provider.apiKeyEnv : undefined;
    // Keep the two bounded token fields in their typed summary slots. They are
    // still part of the release payload, but must not be duplicated in the
    // generic key-value parameter map returned to Admin Web.
    const parameters = Object.fromEntries(Object.entries(value).filter(([name]) => ![
      "providerKey", "providerModel", "displayName", "protocol", "baseUrl", "apiKey", "apiKeyEnv",
      "contextWindowTokens", "maxOutputTokens",
    ].includes(name)));
    const contextWindowTokens = numberValue(value.contextWindowTokens) ?? (record(provider) ? numberValue(provider.contextWindowTokens) : undefined);
    const maxOutputTokens = numberValue(value.maxOutputTokens) ?? (record(provider) ? numberValue(provider.maxOutputTokens) : undefined);
    const apiKeyConfigured = record(provider) && ((typeof provider.apiKey === "string" && provider.apiKey.trim() !== "") || typeof provider.apiKeyEnv === "string");
    return { key, displayName: value.displayName, providerKey: value.providerKey, providerModel: value.providerModel, protocol, releaseId: release.releaseId, releaseState: release.state, version: release.version, defaultModel: configuration.defaultModelKey === key, baseUrl, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }), apiKeyConfigured, ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), parameters };
  });
}

function providersFromRelease(release: ResourceRelease): readonly AdminProviderSummary[] {
  const configuration = providerConfigurationFromRelease(release);
  const models = modelsFromRelease(release);
  return Object.entries(configuration.providers).map(([key, value]) => {
    if (!record(value)) throw new ControlPlaneError("invalid_contract", `Model route ${release.releaseId} contains an invalid provider ${key}`);
    const protocol: "chat-completions" | "responses" = value.protocol === "responses" ? "responses" : "chat-completions";
    const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : "";
    const providerModels = models.filter((model) => model.providerKey === key).sort((left, right) => left.key.localeCompare(right.key));
    return {
      key, kind: "openai-compatible" as const, baseUrl, protocol,
      apiKeyConfigured: typeof value.apiKey === "string" && value.apiKey.trim() !== "" || providerModels.some((model) => model.apiKeyConfigured),
      defaultProvider: configuration.defaultProvider === key,
      releaseId: release.releaseId, releaseState: release.state, version: release.version, models: providerModels,
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function providerConfigurationFromRelease(release: ResourceRelease): { readonly defaultProvider?: string; readonly defaultModelKey?: string; readonly providers: Record<string, unknown>; readonly models: Record<string, unknown> } {
  if (release.schemaVersion !== "model-route/v1" || !record(release.payload.providerConfiguration)) throw new ControlPlaneError("invalid_contract", `Model route ${release.releaseId} has no valid provider configuration`);
  const value = release.payload.providerConfiguration;
  if (!record(value.providers) || !record(value.models)) throw new ControlPlaneError("invalid_contract", `Model route ${release.releaseId} has invalid providers or models`);
  return { defaultProvider: typeof value.defaultProvider === "string" ? value.defaultProvider : undefined, defaultModelKey: typeof value.defaultModelKey === "string" ? value.defaultModelKey : undefined, providers: value.providers, models: value.models };
}

function emptyProviderConfiguration(input: RegisterModelInput): { readonly defaultProvider: string; readonly defaultModelKey: string; readonly providers: Record<string, unknown>; readonly models: Record<string, unknown> } {
  return { defaultProvider: input.providerKey, defaultModelKey: input.modelKey, providers: {}, models: {} };
}

function normalizeProviderConfiguration(value: unknown): { readonly defaultProvider: string; readonly defaultModelKey: string; readonly providers: Record<string, unknown>; readonly models: Record<string, unknown> } {
  if (!record(value) || !record(value.providers)) {
    throw new ControlPlaneError("invalid_contract", "Provider configuration must contain a providers object");
  }
  const providers = Object.fromEntries(Object.entries(value.providers).map(([providerKey, provider]) => {
    if (!record(provider)) throw new ControlPlaneError("invalid_contract", `Provider ${providerKey} must be an object`);
    const { models: _models, ...connection } = provider;
    return [providerKey, connection];
  }));
  const nestedModelMap: Record<string, unknown> = {};
  for (const [providerKey, provider] of Object.entries(value.providers)) {
    if (!record(provider) || provider.models === undefined) continue;
    if (!record(provider.models)) throw new ControlPlaneError("invalid_contract", `Provider ${providerKey}.models must be an object`);
    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (Object.hasOwn(nestedModelMap, modelKey)) throw new ControlPlaneError("invalid_contract", `Duplicate model key ${modelKey}`);
      if (!record(model)) throw new ControlPlaneError("invalid_contract", `Model ${modelKey} must be an object`);
      nestedModelMap[modelKey] = { ...model, providerKey };
    }
  }
  const modelMap = record(value.models) ? value.models : nestedModelMap;
  const models: Record<string, unknown> = {};
  const modelKeys = Object.keys(modelMap).sort();
  if (modelKeys.length === 0) throw new ControlPlaneError("invalid_contract", "Provider configuration must contain at least one model");
  for (const modelKey of modelKeys) {
    const rawModel: unknown = modelMap[modelKey];
    if (!record(rawModel)) throw new ControlPlaneError("invalid_contract", `Model ${modelKey} must be an object`);
    const providerKey = rawModel.providerKey;
    if (typeof providerKey !== "string" || !record(providers[providerKey])) throw new ControlPlaneError("invalid_contract", `Model ${modelKey} references an unknown provider`);
    const provider = providers[providerKey]!;
    const providerModel = rawModel.providerModel;
    const displayName = rawModel.displayName;
    const baseUrl = typeof rawModel.baseUrl === "string" ? rawModel.baseUrl : provider.baseUrl;
    const apiKeyEnv = typeof rawModel.apiKeyEnv === "string" ? rawModel.apiKeyEnv : provider.apiKeyEnv;
    const protocol = rawModel.protocol ?? provider.protocol ?? "chat-completions";
    const apiKey = typeof rawModel.apiKey === "string" ? rawModel.apiKey : provider.apiKey;
    if (typeof providerModel !== "string" || typeof displayName !== "string" || typeof baseUrl !== "string" || (typeof apiKeyEnv !== "string" && typeof apiKey !== "string")) {
      throw new ControlPlaneError("invalid_contract", `Model ${modelKey} is missing providerModel, displayName, baseUrl, or provider apiKey`);
    }
    if (protocol !== "chat-completions" && protocol !== "responses") throw new ControlPlaneError("invalid_contract", `Model ${modelKey} has an invalid protocol`);
    const parameters = Object.fromEntries(Object.entries(rawModel).filter(([name]) => ![
      "providerKey", "providerModel", "displayName", "baseUrl", "apiKeyEnv", "protocol",
    ].includes(name)));
    validateModelInput({
      modelKey, displayName, providerKey, providerModel, baseUrl, ...(typeof apiKeyEnv === "string" ? { apiKeyEnv } : {}), ...(typeof apiKey === "string" ? { apiKey } : {}), protocol,
      ...(typeof rawModel.defaultModel === "boolean" ? { defaultModel: rawModel.defaultModel } : {}),
      ...(numberValue(rawModel.contextWindowTokens) === undefined ? {} : { contextWindowTokens: numberValue(rawModel.contextWindowTokens) }),
      ...(numberValue(rawModel.maxOutputTokens) === undefined ? {} : { maxOutputTokens: numberValue(rawModel.maxOutputTokens) }),
      parameters,
    });
    models[modelKey] = { ...rawModel, protocol };
  }
  const defaultProvider = typeof value.defaultProvider === "string" ? value.defaultProvider : undefined;
  const defaultModelKey = typeof value.defaultModelKey === "string" ? value.defaultModelKey : modelKeys[0];
  if (defaultProvider === undefined || !record(providers[defaultProvider])) throw new ControlPlaneError("invalid_contract", "Provider configuration has no valid defaultProvider");
  if (defaultModelKey === undefined || !Object.hasOwn(models, defaultModelKey)) throw new ControlPlaneError("invalid_contract", "Provider configuration has no valid defaultModelKey");
  return { defaultProvider, defaultModelKey, providers, models };
}

function validateModelInput(input: RegisterModelInput): void {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(input.modelKey)) throw new ControlPlaneError("invalid_contract", "modelKey has an invalid format");
  for (const [name, value] of [["displayName", input.displayName], ["providerKey", input.providerKey], ["providerModel", input.providerModel], ["baseUrl", input.baseUrl]] as const) {
    if (value.trim() === "") throw new ControlPlaneError("invalid_contract", `${name} is required`);
  }
  try { const url = new URL(input.baseUrl); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(); } catch { throw new ControlPlaneError("invalid_contract", "baseUrl must be an HTTP(S) URL"); }
  if (input.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(input.apiKeyEnv)) throw new ControlPlaneError("invalid_contract", "apiKeyEnv must be an environment variable name");
  if (input.contextWindowTokens !== undefined && (!Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens < 4_096)) throw new ControlPlaneError("invalid_contract", "contextWindowTokens is invalid");
  if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)) throw new ControlPlaneError("invalid_contract", "maxOutputTokens is invalid");
  if (input.parameters !== undefined) {
    for (const [key, value] of Object.entries(input.parameters)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || ["providerKey", "providerModel", "displayName", "baseUrl", "apiKeyEnv", "protocol"].includes(key)) throw new ControlPlaneError("invalid_contract", `Model parameter key ${key} is reserved or invalid`);
      assertJsonValue(value, `parameters.${key}`);
    }
  }
}

function validateProviderInput(input: RegisterProviderInput, requireApiKey = true): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.providerKey)) throw new ControlPlaneError("invalid_contract", "providerKey has an invalid format");
  if (input.baseUrl.trim() === "") throw new ControlPlaneError("invalid_contract", "baseUrl is required");
  try { const url = new URL(input.baseUrl); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(); } catch { throw new ControlPlaneError("invalid_contract", "baseUrl must be an HTTP(S) URL"); }
  if (requireApiKey && (input.apiKey === undefined || input.apiKey.trim() === "")) throw new ControlPlaneError("invalid_contract", "apiKey is required");
  if (input.protocol !== "chat-completions" && input.protocol !== "responses") throw new ControlPlaneError("invalid_contract", "protocol is invalid");
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function recordValue(value: unknown): Record<string, unknown> { return record(value) ? value : {}; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined; }
function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`)); return; }
  if (record(value)) { Object.entries(value).forEach(([key, item]) => assertJsonValue(item, `${label}.${key}`)); return; }
  throw new ControlPlaneError("invalid_contract", `${label} must be JSON serializable`);
}
