import { createHash } from "node:crypto";
import type { SqlConnection } from "@zhujun/agentloop";
import { LlmProviderRegistry } from "@zhujun/agentloop";

export type RouterModelProtocol = "chat-completions" | "responses";

export interface RouterModelSummary {
  readonly key: string;
  readonly displayName: string;
  readonly providerKey: string;
  readonly providerModel: string;
  readonly protocol: RouterModelProtocol;
  readonly defaultModel: boolean;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface RouterProviderSummary {
  readonly key: string;
  readonly baseUrl: string;
  readonly protocol: RouterModelProtocol;
  readonly apiKeyConfigured: boolean;
  readonly defaultProvider: boolean;
  readonly models: readonly RouterModelSummary[];
}

export interface RouterModelCatalogView {
  readonly revision: number;
  readonly contentHash: string;
  readonly providers: readonly RouterProviderSummary[];
}

export interface RouterModelConfiguration {
  readonly revision: number;
  readonly contentHash: string;
  readonly providerConfiguration: Readonly<Record<string, unknown>>;
}

export interface UpsertRouterProviderInput {
  readonly providerKey: string;
  readonly baseUrl: string;
  /** Omit on edit to retain the Router-stored key. Required for a new Provider. */
  readonly apiKey?: string;
  readonly protocol: RouterModelProtocol;
  readonly defaultProvider?: boolean;
}

export interface UpsertRouterModelInput {
  readonly modelKey: string;
  readonly displayName: string;
  readonly providerKey: string;
  readonly providerModel: string;
  readonly defaultModel?: boolean;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/** Router-owned, versioned provider/model configuration. API keys never leave this store except on the workload-only configuration route. */
export class RouterModelCatalog {
  private readonly database: SqlConnection;
  public constructor(database: SqlConnection) { this.database = database; }

  public async view(): Promise<RouterModelCatalogView> {
    // Admin needs to be able to create a Provider before its first Model.
    // This projection therefore permits an empty (but persisted) provider.
    const current = await this.current({ allowEmptyModels: true });
    return { revision: current.revision, contentHash: current.contentHash, providers: providerSummaries(current.providerConfiguration) };
  }

  public async configuration(): Promise<RouterModelConfiguration> { return await this.current(); }

  public async upsertProvider(input: UpsertRouterProviderInput): Promise<RouterModelCatalogView> {
    validateProvider(input);
    return await this.mutate((configuration) => {
      const providers = providersRecord(configuration);
      const existing = object(providers[input.providerKey]);
      if (Object.keys(existing).length === 0 && input.apiKey === undefined) throw new Error("apiKey is required for a new Provider");
      const provider = {
        ...existing,
        kind: "openai-compatible",
        baseUrl: input.baseUrl,
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        protocol: input.protocol,
        models: object(existing.models),
      };
      const defaultProvider = input.defaultProvider === true || typeof configuration.defaultProvider !== "string"
        ? input.providerKey
        : configuration.defaultProvider;
      return { ...configuration, defaultProvider, providers: { ...providers, [input.providerKey]: provider } };
    }, { allowEmptyModels: true });
  }

  public async upsertModel(input: UpsertRouterModelInput): Promise<RouterModelCatalogView> {
    validateModel(input);
    return await this.mutate((configuration) => {
      const providers = providersRecord(configuration);
      const provider = object(providers[input.providerKey]);
      if (Object.keys(provider).length === 0) throw new Error(`Unknown Provider ${input.providerKey}`);
      const models = object(provider.models);
      const model = {
        ...(input.parameters ?? {}),
        providerModel: input.providerModel,
        displayName: input.displayName,
        ...(input.contextWindowTokens === undefined ? {} : { contextWindowTokens: input.contextWindowTokens }),
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      };
      const defaultModelKey = input.defaultModel === true || typeof configuration.defaultModelKey !== "string"
        ? input.modelKey
        : configuration.defaultModelKey;
      return {
        ...configuration,
        defaultProvider: input.defaultModel === true ? input.providerKey : configuration.defaultProvider,
        defaultModelKey,
        providers: { ...providers, [input.providerKey]: { ...provider, models: { ...models, [input.modelKey]: model } } },
      };
    });
  }

  public async removeModel(modelKey: string): Promise<RouterModelCatalogView> {
    if (!modelKeyPattern.test(modelKey)) throw new Error("modelKey has an invalid format");
    return await this.mutate((configuration) => {
      const providers = providersRecord(configuration);
      let removed = false;
      const nextProviders = Object.fromEntries(Object.entries(providers).map(([providerKey, rawProvider]) => {
        const provider = object(rawProvider);
        const models = object(provider.models);
        if (!Object.hasOwn(models, modelKey)) return [providerKey, provider];
        removed = true;
        return [providerKey, { ...provider, models: Object.fromEntries(Object.entries(models).filter(([key]) => key !== modelKey)) }];
      }));
      if (!removed) throw new Error(`Unknown model ${modelKey}`);
      const remaining = flattenedModels(nextProviders);
      if (remaining.length === 0) throw new Error("The last configured model cannot be deleted");
      const defaultModelKey = configuration.defaultModelKey === modelKey ? remaining[0]!.key : configuration.defaultModelKey;
      const defaultProvider = defaultModelKey === undefined ? configuration.defaultProvider : remaining.find((model) => model.key === defaultModelKey)?.providerKey ?? configuration.defaultProvider;
      return { ...configuration, defaultProvider, defaultModelKey, providers: nextProviders };
    });
  }

  /** Imports legacy top-level models once, normalizing them into the Router-owned nested Provider shape. */
  public async seed(configuration: unknown): Promise<void> {
    const existing = await this.row();
    if (existing !== undefined) return;
    const normalized = normalize(configuration);
    if (Object.keys(providersRecord(normalized)).length === 0) return;
    const saved = await this.save(0, normalized);
    if (saved === undefined) return;
  }

  private async mutate(
    change: (configuration: Record<string, unknown>) => Record<string, unknown>,
    options: { readonly allowEmptyModels?: boolean } = {},
  ): Promise<RouterModelCatalogView> {
    return await this.database.transaction(async () => {
      const row = await this.row();
      const current = row === undefined
        ? { revision: 0, contentHash: "", providerConfiguration: { providers: {} } }
        // A Provider-only row is a valid intermediate editing state. The
        // mutation itself decides whether the resulting configuration may
        // remain empty; reading the base must therefore always permit it.
        : await this.current({ allowEmptyModels: true });
      const next = change(structuredClone(current.providerConfiguration) as Record<string, unknown>);
      validateConfiguration(next, { allowEmptyModels: options.allowEmptyModels === true });
      const result = await this.save(current.revision, next);
      if (result === undefined) throw new Error("Router model catalog changed concurrently; retry the request");
      return { revision: result.revision, contentHash: result.contentHash, providers: providerSummaries(result.providerConfiguration) };
    });
  }

  private async current(options: { readonly allowEmptyModels?: boolean } = {}): Promise<RouterModelConfiguration> {
    const row = await this.row();
    if (row === undefined) throw new Error("Router model catalog is not configured");
    const providerConfiguration = parseConfiguration(row.configuration_json);
    if (options.allowEmptyModels !== true && flattenedModels(providersRecord(providerConfiguration)).length === 0) {
      throw new Error("Router model catalog has no configured models");
    }
    return { revision: number(row.revision), contentHash: row.content_hash, providerConfiguration };
  }

  private async row(): Promise<{ readonly revision: number | string | bigint; readonly content_hash: string; readonly configuration_json: string } | undefined> {
    return await this.database.prepare("SELECT revision, content_hash, configuration_json FROM mr_model_catalog WHERE id = 1").get();
  }

  private async save(expectedRevision: number, providerConfiguration: Record<string, unknown>): Promise<RouterModelConfiguration | undefined> {
    const serialized = canonicalJson(providerConfiguration);
    const contentHash = createHash("sha256").update(serialized).digest("hex");
    const revision = expectedRevision + 1;
    if (expectedRevision === 0) {
      const inserted = await this.database.prepare("INSERT INTO mr_model_catalog(id, revision, content_hash, configuration_json, updated_at) VALUES (1, ?, ?, ?, ?)").run(revision, contentHash, serialized, Date.now());
      if (inserted.changes !== 1) return undefined;
    } else {
      const updated = await this.database.prepare("UPDATE mr_model_catalog SET revision = ?, content_hash = ?, configuration_json = ?, updated_at = ? WHERE id = 1 AND revision = ?").run(revision, contentHash, serialized, Date.now(), expectedRevision);
      if (updated.changes !== 1) return undefined;
    }
    return { revision, contentHash, providerConfiguration };
  }
}

export async function installRouterModelCatalogSchema(database: SqlConnection): Promise<void> {
  const text = database.dialect === "tidb" ? "LONGTEXT" : "TEXT";
  const epoch = database.dialect === "sqlite" ? "INTEGER" : "BIGINT";
  const hash = database.dialect === "tidb" ? "CHAR(64)" : "TEXT";
  await database.exec(`CREATE TABLE IF NOT EXISTS mr_model_catalog (
    id ${epoch} PRIMARY KEY, revision ${epoch} NOT NULL, content_hash ${hash} NOT NULL,
    configuration_json ${text} NOT NULL, updated_at ${epoch} NOT NULL
  )`);
}

const modelKeyPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const providerKeyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateProvider(input: UpsertRouterProviderInput): void {
  if (!providerKeyPattern.test(input.providerKey)) throw new Error("providerKey has an invalid format");
  if (input.apiKey !== undefined && input.apiKey.trim() === "") throw new Error("apiKey cannot be empty");
  if (input.protocol !== "chat-completions" && input.protocol !== "responses") throw new Error("protocol is invalid");
  validateHttpUrl(input.baseUrl);
}

function validateModel(input: UpsertRouterModelInput): void {
  if (!modelKeyPattern.test(input.modelKey)) throw new Error("modelKey has an invalid format");
  if (!providerKeyPattern.test(input.providerKey)) throw new Error("providerKey has an invalid format");
  if (input.displayName.trim() === "" || input.providerModel.trim() === "") throw new Error("displayName and providerModel are required");
  if (input.contextWindowTokens !== undefined && (!Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens < 4096)) throw new Error("contextWindowTokens is invalid");
  if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)) throw new Error("maxOutputTokens is invalid");
  if (input.parameters !== undefined) {
    for (const [key, value] of Object.entries(input.parameters)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || ["providerKey", "providerModel", "displayName", "baseUrl", "apiKey", "apiKeyEnv", "protocol", "models"].includes(key)) {
        throw new Error(`Model parameter key ${key} is reserved or invalid`);
      }
      assertJsonValue(value, `parameters.${key}`);
    }
  }
}

function validateConfiguration(configuration: Record<string, unknown>, options: { readonly allowEmptyModels?: boolean } = {}): void {
  const modelCount = flattenedModels(providersRecord(configuration)).length;
  if (modelCount === 0) {
    if (options.allowEmptyModels === true) return;
    throw new Error("Router model catalog must contain at least one model");
  }
  LlmProviderRegistry.fromConfigObject(configuration, {});
}

function normalize(value: unknown): Record<string, unknown> {
  const source = object(value);
  const providers = Object.fromEntries(Object.entries(object(source.providers)).map(([providerKey, rawProvider]) => {
    const provider = object(rawProvider);
    const { models: _models, ...connection } = provider;
    return [providerKey, { ...connection, models: object(provider.models) }];
  }));
  for (const [modelKey, rawModel] of Object.entries(object(source.models))) {
    const model = object(rawModel);
    const providerKey = typeof model.providerKey === "string" ? model.providerKey : undefined;
    if (providerKey === undefined || !Object.hasOwn(providers, providerKey)) continue;
    const { providerKey: _providerKey, ...modelWithoutProvider } = model;
    const provider = object(providers[providerKey]);
    providers[providerKey] = { ...provider, models: { ...object(provider.models), [modelKey]: modelWithoutProvider } };
  }
  const allModels = flattenedModels(providers);
  return {
    ...(typeof source.defaultProvider === "string" ? { defaultProvider: source.defaultProvider } : allModels[0] === undefined ? {} : { defaultProvider: allModels[0].providerKey }),
    ...(typeof source.defaultModelKey === "string" ? { defaultModelKey: source.defaultModelKey } : allModels[0] === undefined ? {} : { defaultModelKey: allModels[0].key }),
    providers,
  };
}

function providerSummaries(configuration: Readonly<Record<string, unknown>>): readonly RouterProviderSummary[] {
  const defaultProvider = typeof configuration.defaultProvider === "string" ? configuration.defaultProvider : undefined;
  const defaultModelKey = typeof configuration.defaultModelKey === "string" ? configuration.defaultModelKey : undefined;
  return Object.entries(providersRecord(configuration)).map(([key, rawProvider]) => {
    const provider = object(rawProvider);
    const protocol: RouterModelProtocol = provider.protocol === "responses" ? "responses" : "chat-completions";
    const models = Object.entries(object(provider.models)).map(([modelKey, rawModel]) => {
      const model = object(rawModel);
      const parameters = Object.fromEntries(Object.entries(model).filter(([name]) => !["providerModel", "displayName", "contextWindowTokens", "maxOutputTokens", "protocol"].includes(name)));
      return {
        key: modelKey,
        displayName: string(model.displayName, modelKey),
        providerKey: key,
        providerModel: string(model.providerModel, modelKey),
        protocol: model.protocol === "responses" ? "responses" : protocol,
        defaultModel: defaultModelKey === modelKey,
        ...(integer(model.contextWindowTokens) === undefined ? {} : { contextWindowTokens: integer(model.contextWindowTokens) }),
        ...(integer(model.maxOutputTokens) === undefined ? {} : { maxOutputTokens: integer(model.maxOutputTokens) }),
        parameters,
      } satisfies RouterModelSummary;
    }).sort((left, right) => left.key.localeCompare(right.key));
    return {
      key, baseUrl: string(provider.baseUrl, ""), protocol,
      apiKeyConfigured: typeof provider.apiKey === "string" && provider.apiKey.trim() !== "" || typeof provider.apiKeyEnv === "string",
      defaultProvider: defaultProvider === key, models,
    } satisfies RouterProviderSummary;
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function flattenedModels(providers: Record<string, unknown>): Array<{ readonly key: string; readonly providerKey: string }> {
  return Object.entries(providers).flatMap(([providerKey, rawProvider]) => Object.keys(object(object(rawProvider).models)).map((key) => ({ key, providerKey })));
}
function providersRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> { return object(value.providers); }
function parseConfiguration(value: string): Record<string, unknown> { try { return object(JSON.parse(value)); } catch { throw new Error("Persisted Router model catalog is invalid"); } }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() !== "" ? value : fallback; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined; }
function number(value: number | string | bigint): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new Error("Persisted Router model catalog revision is invalid"); return parsed; }
function validateHttpUrl(value: string): void { try { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(); } catch { throw new Error("baseUrl must be an HTTP(S) URL"); } }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`)); return; }
  if (value !== null && typeof value === "object") { Object.entries(value as Record<string, unknown>).forEach(([key, item]) => assertJsonValue(item, `${label}.${key}`)); return; }
  throw new Error(`${label} must contain only JSON values`);
}
