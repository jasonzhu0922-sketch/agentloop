import { LlmProviderRegistry, type AppDatabase } from "@zhujun/agentloop";
import type { LocalRuntimeSecretStore } from "./local-runtime-configuration-store.ts";

export interface LocalModelProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly credentialConfigured?: boolean;
  readonly models: readonly LocalModelInput[];
}

export interface LocalModelInput {
  readonly key: string;
  readonly displayName: string;
  readonly providerModel: string;
  readonly protocol?: "responses" | "chat-completions";
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high";
  readonly reasoningSummary?: "auto" | "detailed";
  readonly thinkingMode?: "enabled" | "disabled";
  readonly thinkingEffort?: "low" | "medium" | "high";
  readonly toolChoiceMode?: "native" | "constrained-as-auto" | "named-as-required";
  readonly runtimeContextPlacement?: "system" | "user-envelope";
  readonly reasoningEncryptedContent?: boolean;
  readonly reasoningVisibility?: "visible" | "hidden";
  readonly planningThinkingMode?: "enabled" | "disabled";
  readonly chatTemplateKwargs?: Readonly<Record<string, unknown>>;
}

export interface LocalModelConfigurationInput {
  readonly reuseCloudModels: boolean;
  readonly providers: readonly LocalModelProviderInput[];
}

export interface ResolvedLocalModelConfiguration {
  readonly configured: boolean;
  readonly reuseCloudModels: boolean;
  readonly registryConfig: unknown;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

interface ModelConfigurationRow { configuration_json: string; secret_storage_key: string | null; updated_at: number }
export interface LocalModelConfigurationSnapshot { readonly row?: ModelConfigurationRow }

export class LocalModelConfigurationStore {
  private readonly database: AppDatabase;
  private readonly secrets: LocalRuntimeSecretStore;
  private currentConfiguration?: ResolvedLocalModelConfiguration;

  constructor(database: AppDatabase, secrets: LocalRuntimeSecretStore) {
    this.database = database;
    this.secrets = secrets;
  }

  async ready(): Promise<void> {
    await this.database.exec(`CREATE TABLE IF NOT EXISTS local_model_configuration (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), configuration_json TEXT NOT NULL,
      secret_storage_key TEXT, updated_at INTEGER NOT NULL
    )`);
    this.currentConfiguration = await this.resolve();
  }

  /** Published only after a successful durable write; new model admissions read this snapshot. */
  current(): ResolvedLocalModelConfiguration {
    if (this.currentConfiguration === undefined) throw new Error("local_model_configuration_not_ready");
    return this.currentConfiguration;
  }

  async read(): Promise<LocalModelConfigurationInput> {
    const row = await this.row();
    return row === undefined ? { reuseCloudModels: true, providers: [] } : configurationWithoutLegacyDefaults(row.configuration_json);
  }

  async write(value: LocalModelConfigurationInput): Promise<LocalModelConfigurationInput> {
    value = normalizeInput(value);
    const previous = await this.row();
    const secretValues: Record<string, string> = {};
    const previousSecrets = previous?.secret_storage_key ? await this.secrets.read(previous.secret_storage_key) : undefined;
    const previousProviders = previous === undefined ? [] : (JSON.parse(previous.configuration_json) as LocalModelConfigurationInput).providers;
    const providers = value.providers.map((provider): LocalModelProviderInput => {
      const apiKeyEnv = `LOCAL_MODEL_KEY_${provider.key.toUpperCase().replace(/-/g, "_")}`;
      const previousProvider = previousProviders.find((entry) => entry.key === provider.key);
      // A saved credential cannot silently move to a newly supplied endpoint.
      const key = provider.apiKey?.trim() || (previousProvider?.baseUrl === provider.baseUrl ? previousSecrets?.[apiKeyEnv] : undefined);
      if (key === undefined) throw new TypeError("local_model_api_key_required");
      if (key !== undefined) secretValues[apiKeyEnv] = key;
      const { apiKey: _apiKey, ...publicProvider } = provider;
      return { ...publicProvider, credentialConfigured: key !== undefined };
    });
    const registry = registryConfiguration({ ...value, providers });
    if (registry !== undefined) LlmProviderRegistry.fromConfigObject(registry, secretValues);
    const secretStorageKey = Object.keys(secretValues).length > 0 ? await this.secrets.write(secretValues) : null;
    const stored: LocalModelConfigurationInput = {
      reuseCloudModels: value.reuseCloudModels,
      providers,
    };
    try {
      await this.database.prepare(`INSERT INTO local_model_configuration(singleton, configuration_json, secret_storage_key, updated_at)
        VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET configuration_json = excluded.configuration_json,
        secret_storage_key = excluded.secret_storage_key, updated_at = excluded.updated_at`)
        .run(JSON.stringify(stored), secretStorageKey, Date.now());
    } catch (error) {
      if (secretStorageKey !== null) await this.secrets.remove(secretStorageKey);
      throw error;
    }
    this.currentConfiguration = {
      configured: true, reuseCloudModels: stored.reuseCloudModels,
      registryConfig: registry, environment: secretValues,
    };
    return stored;
  }

  async snapshot(): Promise<LocalModelConfigurationSnapshot> {
    return { row: await this.row() };
  }

  async restore(snapshot: LocalModelConfigurationSnapshot): Promise<void> {
    const current = await this.row();
    if (snapshot.row === undefined) await this.database.prepare("DELETE FROM local_model_configuration WHERE singleton = 1").run();
    else await this.database.prepare(`INSERT INTO local_model_configuration(singleton, configuration_json, secret_storage_key, updated_at)
      VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET configuration_json = excluded.configuration_json,
      secret_storage_key = excluded.secret_storage_key, updated_at = excluded.updated_at`)
      .run(snapshot.row.configuration_json, snapshot.row.secret_storage_key, snapshot.row.updated_at);
    this.currentConfiguration = await this.resolve();
    if (current !== undefined && current.secret_storage_key !== null && current.secret_storage_key !== snapshot.row?.secret_storage_key) await this.secrets.remove(current.secret_storage_key);
  }

  async commit(snapshot: LocalModelConfigurationSnapshot): Promise<void> {
    const current = await this.row();
    if (snapshot.row !== undefined && snapshot.row.secret_storage_key !== null && snapshot.row.secret_storage_key !== current?.secret_storage_key) await this.secrets.remove(snapshot.row.secret_storage_key);
  }

  async resolve(): Promise<ResolvedLocalModelConfiguration> {
    const row = await this.row();
    if (row === undefined) return { configured: false, reuseCloudModels: true, registryConfig: undefined, environment: {} };
    const config = configurationWithoutLegacyDefaults(row.configuration_json);
    const environment = row.secret_storage_key === null ? {} : await this.secrets.read(row.secret_storage_key) ?? {};
    return {
      configured: true, reuseCloudModels: config.reuseCloudModels,
      registryConfig: registryConfiguration(config), environment,
    };
  }

  private async row(): Promise<ModelConfigurationRow | undefined> {
    return await this.database.prepare("SELECT configuration_json, secret_storage_key, updated_at FROM local_model_configuration WHERE singleton = 1")
      .get() as ModelConfigurationRow | undefined;
  }
}

function configurationWithoutLegacyDefaults(serialized: string): LocalModelConfigurationInput {
  const value = JSON.parse(serialized) as LocalModelConfigurationInput & { defaultModelKey?: unknown; defaultProvider?: unknown };
  const { defaultModelKey: _defaultModelKey, defaultProvider: _defaultProvider, ...configuration } = value;
  return configuration;
}

function registryConfiguration(config: LocalModelConfigurationInput): unknown {
  // A Provider may be configured before it has any models. Only explicitly
  // configured models enter the executable registry; no synthetic model is added.
  const activeProviders = config.providers.filter((provider) => provider.models.length > 0);
  if (activeProviders.length === 0) return undefined;
  const providers: Record<string, unknown> = {};
  const models: Record<string, unknown> = {};
  for (const provider of activeProviders) {
    providers[provider.key] = {
      kind: "openai-compatible", baseUrl: provider.baseUrl,
      apiKeyEnv: `LOCAL_MODEL_KEY_${provider.key.toUpperCase().replace(/-/g, "_")}`,
      defaultModel: provider.models[0]!.providerModel, protocol: "responses",
    };
    for (const model of provider.models) {
      const { key, ...configuration } = model;
      models[key] = { ...configuration, providerKey: provider.key };
    }
  }
  return {
    defaultProvider: activeProviders[0]!.key,
    defaultModelKey: activeProviders[0]!.models[0]!.key,
    providers, models,
  };
}

function normalizeInput(value: LocalModelConfigurationInput): LocalModelConfigurationInput {
  if (!value || typeof value !== "object" || typeof value.reuseCloudModels !== "boolean" || !Array.isArray(value.providers) || value.providers.length > 50) throw new TypeError("local_model_configuration_invalid");
  const keys = new Set<string>();
  const modelKeys = new Set<string>();
  const providers = (value.providers as readonly LocalModelProviderInput[]).map((provider): LocalModelProviderInput => {
    if (!provider || typeof provider !== "object" || typeof provider.key !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider.key) || keys.has(provider.key) || provider.key.length > 80 || !Array.isArray(provider.models) || provider.models.length > 100) throw new TypeError("local_model_configuration_invalid");
    if (Object.keys(provider).some((key) => !["key", "displayName", "baseUrl", "apiKey", "credentialConfigured", "models"].includes(key))) throw new TypeError("local_model_provider_parameter_unknown");
    keys.add(provider.key);
    let url: URL;
    try { url = new URL(provider.baseUrl); } catch { throw new TypeError("local_model_base_url_invalid"); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && url.protocol !== "http:")) throw new TypeError("local_model_base_url_invalid");
    if (provider.apiKey !== undefined && (typeof provider.apiKey !== "string" || provider.apiKey.length > 4096)) throw new TypeError("local_model_configuration_invalid");
    const models = (provider.models as LocalModelProviderInput["models"]).map((model) => {
      if (!model || typeof model !== "object" || typeof model.key !== "string" || model.key.length > 100 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(model.key) || modelKeys.has(model.key)) throw new TypeError("local_model_configuration_invalid");
      modelKeys.add(model.key);
      const allowed = new Set(["key", "displayName", "providerModel", "protocol", "contextWindowTokens", "maxOutputTokens",
        "temperature", "topP", "timeoutMs", "maxAttempts", "retryDelayMs", "reasoningEffort", "reasoningSummary", "thinkingMode", "thinkingEffort", "toolChoiceMode", "runtimeContextPlacement", "reasoningEncryptedContent",
        "reasoningVisibility", "planningThinkingMode", "chatTemplateKwargs"]);
      if (Object.keys(model).some((key) => !allowed.has(key))) throw new TypeError("local_model_parameter_unknown");
      // Keep every admitted parameter. The canonical registry below validates
      // protocol constraints and numeric ranges before anything is persisted.
      return { ...model, key: model.key, displayName: text(model.displayName, 100), providerModel: text(model.providerModel, 160) };
    });
    return { key: provider.key, displayName: text(provider.displayName, 100), baseUrl: url.href.replace(/\/$/, ""),
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey.trim() }), models };
  });
  return { reuseCloudModels: value.reuseCloudModels, providers };
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError("local_model_configuration_invalid");
  return value.trim();
}
