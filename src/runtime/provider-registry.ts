import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../shared/errors.ts";
import type { ModelAdapter, ModelRetryReporter } from "./contracts.ts";
import { OpenAICompatibleModel, ResponsesModel } from "./models.ts";
import type { RuntimeContextPlacement } from "./prompt-protocol.ts";

const PROVIDER_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL_KEY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;

export interface LlmProviderSummary {
  readonly key: string;
  readonly kind: "openai-compatible";
  readonly defaultModel: string;
}

export interface LlmModelSummary {
  readonly key: string;
  readonly displayName: string;
  readonly providerKey: string;
  readonly providerModel: string;
  readonly kind: "openai-compatible";
}

interface OpenAICompatibleProviderConfig extends LlmProviderSummary {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly toolChoiceMode: "native" | "constrained-as-auto";
  readonly runtimeContextPlacement: RuntimeContextPlacement;
  readonly protocol: "chat-completions" | "responses";
}

interface OpenAICompatibleModelConfig extends LlmModelSummary {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly toolChoiceMode: "native" | "constrained-as-auto";
  readonly runtimeContextPlacement: RuntimeContextPlacement;
  readonly protocol: "chat-completions" | "responses";
}

interface ParsedProviderDocument {
  readonly defaultProvider: string;
  readonly defaultModelKey: string;
  readonly providers: readonly OpenAICompatibleProviderConfig[];
  readonly models: readonly OpenAICompatibleModelConfig[];
}

/**
 * Server-owned registry for model providers.
 *
 * The JSON configuration defines provider endpoints and the environment
 * variable containing each secret. AgentLoop is a single-agent runtime: the
 * server-default provider and model are the only ones used, and no Run input
 * can provide a base URL, key, or other connection setting.
 */
export class LlmProviderRegistry {
  readonly defaultProviderKey: string;
  readonly defaultModelKey: string;
  private readonly providers: ReadonlyMap<string, OpenAICompatibleProviderConfig>;
  private readonly models: ReadonlyMap<string, OpenAICompatibleModelConfig>;
  private readonly environment: Readonly<Record<string, string | undefined>>;

  private constructor(
    parsed: ParsedProviderDocument,
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    this.defaultProviderKey = parsed.defaultProvider;
    this.defaultModelKey = parsed.defaultModelKey;
    this.providers = new Map(parsed.providers.map((provider) => [provider.key, provider]));
    this.models = new Map(parsed.models.map((model) => [model.key, model]));
    this.environment = environment;
  }

  static fromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): LlmProviderRegistry {
    const raw = environment.LLM_PROVIDERS_JSON;
    if (raw === undefined || raw.trim().length === 0) {
      throw new Error("LLM_PROVIDERS_JSON must configure at least one server-side LLM provider");
    }
    return LlmProviderRegistry.fromJson(raw, "LLM_PROVIDERS_JSON", environment);
  }

  static async fromConfigFile(
    path: string,
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): Promise<LlmProviderRegistry> {
    const resolved = resolve(path);
    const raw = await fs.readFile(resolved, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(`LLM provider configuration file does not exist: ${resolved}`);
      }
      throw error;
    });
    return LlmProviderRegistry.fromJson(raw, `LLM provider configuration file ${resolved}`, environment);
  }

  catalog(): readonly LlmProviderSummary[] {
    return [...this.providers.values()]
      .map(({ key, kind, defaultModel }) => ({ key, kind, defaultModel }))
      .sort((left, right) => left.key.localeCompare(right.key, "en"));
  }

  keys(): readonly string[] {
    return this.catalog().map((provider) => provider.key);
  }

  modelCatalog(): readonly LlmModelSummary[] {
    return [...this.models.values()]
      .map(({ key, displayName, providerKey, providerModel, kind }) => ({
        key,
        displayName,
        providerKey,
        providerModel,
        kind,
      }))
      .sort((left, right) => left.key.localeCompare(right.key, "en"));
  }

  modelKeys(): readonly string[] {
    return this.modelCatalog().map((model) => model.key);
  }

  /**
   * Create a model adapter bound to a server-declared model profile. Run input
   * may select the public model key only; endpoints, secrets, provider models,
   * protocols, and limits remain server-owned configuration.
   */
  create(modelKeyOrRetry?: string | ModelRetryReporter, onRetryValue?: ModelRetryReporter): ModelAdapter {
    const modelKey = typeof modelKeyOrRetry === "string" ? modelKeyOrRetry : this.defaultModelKey;
    const onRetry = typeof modelKeyOrRetry === "function" ? modelKeyOrRetry : onRetryValue;
    const model = this.models.get(modelKey);
    if (model === undefined) {
      throw new AppError("MODEL_ERROR", `Unknown server-side model key: ${modelKey}`, 400);
    }
    const apiKey = this.environment[model.apiKeyEnv];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new AppError("MODEL_ERROR", `LLM model "${model.key}" is not configured`, 503);
    }
    const modelOptions = {
      baseUrl: model.baseUrl,
      apiKey,
      model: model.providerModel,
      contextWindowTokens: model.contextWindowTokens,
      maxOutputTokens: model.maxOutputTokens,
      timeoutMs: model.timeoutMs,
      maxAttempts: model.maxAttempts,
      retryDelayMs: model.retryDelayMs,
      toolChoiceMode: model.toolChoiceMode,
      runtimeContextPlacement: model.runtimeContextPlacement,
      ...(onRetry === undefined ? {} : { onRetry }),
    };
    return model.protocol === "responses"
      ? new ResponsesModel(modelOptions)
      : new OpenAICompatibleModel(modelOptions);
  }

  private static fromJson(
    raw: string,
    label: string,
    environment: Readonly<Record<string, string | undefined>>,
  ): LlmProviderRegistry {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`${label} must be valid JSON`);
    }
    return new LlmProviderRegistry(parseProviderDocument(value, label), environment);
  }
}

function parseProviderDocument(value: unknown, label: string): ParsedProviderDocument {
  const document = requireObject(value, label);
  assertExactKeys(document, ["defaultProvider", "defaultModelKey", "providers", "models"], label);
  const defaultProvider = requireProviderKey(document.defaultProvider, `${label}.defaultProvider`);
  const providersRecord = requireObject(document.providers, `${label}.providers`);
  const entries = Object.entries(providersRecord);
  if (entries.length === 0) throw new Error(`${label}.providers must contain at least one provider`);
  const providers = entries.map(([key, config]) => parseProvider(key, config, label));
  if (!providers.some((provider) => provider.key === defaultProvider)) {
    throw new Error(`${label}.defaultProvider must name a configured provider`);
  }
  const models = document.models === undefined
    ? legacyModelsFromProviders(providers)
    : parseModels(document.models, providers, label);
  const defaultModelKey = document.defaultModelKey === undefined
    ? legacyModelKeyForProvider(providers.find((provider) => provider.key === defaultProvider)!)
    : requireModelKey(document.defaultModelKey, `${label}.defaultModelKey`);
  if (!models.some((model) => model.key === defaultModelKey)) {
    throw new Error(`${label}.defaultModelKey must name a configured model`);
  }
  return { defaultProvider, defaultModelKey, providers, models };
}

function parseProvider(key: string, value: unknown, documentLabel: string): OpenAICompatibleProviderConfig {
  const providerKey = requireProviderKey(key, `${documentLabel}.providers key`);
  const label = `LLM provider "${providerKey}"`;
  const config = requireObject(value, label);
  assertExactKeys(
    config,
    [
      "kind",
      "baseUrl",
      "apiKeyEnv",
      "defaultModel",
      "contextWindowTokens",
      "maxOutputTokens",
      "timeoutMs",
      "maxAttempts",
      "retryDelayMs",
      "toolChoiceMode",
      "runtimeContextPlacement",
      "protocol",
    ],
    label,
  );
  if (config.kind !== "openai-compatible") {
    throw new Error(`${label} has unsupported kind`);
  }
  const baseUrl = requireHttpUrl(config.baseUrl, `${label}.baseUrl`);
  const apiKeyEnv = requireEnvironmentKey(config.apiKeyEnv, `${label}.apiKeyEnv`);
  const defaultModel = requireNonEmptyString(config.defaultModel, `${label}.defaultModel`, 160);
  const contextWindowTokens = optionalInteger(
    config.contextWindowTokens,
    128_000,
    4_096,
    MAX_CONTEXT_WINDOW_TOKENS,
    `${label}.contextWindowTokens`,
  );
  const maxOutputTokens = optionalInteger(
    config.maxOutputTokens,
    8_192,
    1,
    Math.min(MAX_OUTPUT_TOKENS, contextWindowTokens - 1),
    `${label}.maxOutputTokens`,
  );
  const timeoutMs = optionalInteger(
    config.timeoutMs,
    120_000,
    1_000,
    MAX_TIMEOUT_MS,
    `${label}.timeoutMs`,
  );
  const maxAttempts = optionalInteger(
    config.maxAttempts,
    3,
    1,
    5,
    `${label}.maxAttempts`,
  );
  const retryDelayMs = optionalInteger(
    config.retryDelayMs,
    250,
    0,
    30_000,
    `${label}.retryDelayMs`,
  );
  const toolChoiceMode = optionalToolChoiceMode(config.toolChoiceMode, `${label}.toolChoiceMode`);
  const runtimeContextPlacement = optionalRuntimeContextPlacement(
    config.runtimeContextPlacement,
    `${label}.runtimeContextPlacement`,
  );
  const protocol = optionalProtocol(config.protocol, `${label}.protocol`);
  return {
    key: providerKey,
    kind: "openai-compatible",
    baseUrl,
    apiKeyEnv,
    defaultModel,
    contextWindowTokens,
    maxOutputTokens,
    timeoutMs,
    maxAttempts,
    retryDelayMs,
    toolChoiceMode,
    runtimeContextPlacement,
    protocol,
  };
}

function parseModels(
  value: unknown,
  providers: readonly OpenAICompatibleProviderConfig[],
  documentLabel: string,
): OpenAICompatibleModelConfig[] {
  const providersByKey = new Map(providers.map((provider) => [provider.key, provider]));
  const modelsRecord = requireObject(value, `${documentLabel}.models`);
  const entries = Object.entries(modelsRecord);
  if (entries.length === 0) throw new Error(`${documentLabel}.models must contain at least one model`);
  return entries.map(([key, config]) => parseModel(key, config, providersByKey, documentLabel));
}

function parseModel(
  key: string,
  value: unknown,
  providersByKey: ReadonlyMap<string, OpenAICompatibleProviderConfig>,
  documentLabel: string,
): OpenAICompatibleModelConfig {
  const modelKey = requireModelKey(key, `${documentLabel}.models key`);
  const label = `LLM model "${modelKey}"`;
  const config = requireObject(value, label);
  assertExactKeys(
    config,
    [
      "providerKey",
      "providerModel",
      "displayName",
      "contextWindowTokens",
      "maxOutputTokens",
      "timeoutMs",
      "maxAttempts",
      "retryDelayMs",
      "toolChoiceMode",
      "runtimeContextPlacement",
      "protocol",
    ],
    label,
  );
  const providerKey = requireProviderKey(config.providerKey, `${label}.providerKey`);
  const provider = providersByKey.get(providerKey);
  if (provider === undefined) throw new Error(`${label}.providerKey must name a configured provider`);
  const providerModel = requireNonEmptyString(config.providerModel, `${label}.providerModel`, 160);
  const contextWindowTokens = optionalInteger(
    config.contextWindowTokens,
    provider.contextWindowTokens,
    4_096,
    MAX_CONTEXT_WINDOW_TOKENS,
    `${label}.contextWindowTokens`,
  );
  return {
    key: modelKey,
    displayName: optionalDisplayName(config.displayName, providerModel, `${label}.displayName`),
    providerKey,
    providerModel,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    contextWindowTokens,
    maxOutputTokens: optionalInteger(
      config.maxOutputTokens,
      Math.min(provider.maxOutputTokens, contextWindowTokens - 1),
      1,
      Math.min(MAX_OUTPUT_TOKENS, contextWindowTokens - 1),
      `${label}.maxOutputTokens`,
    ),
    timeoutMs: optionalInteger(config.timeoutMs, provider.timeoutMs, 1_000, MAX_TIMEOUT_MS, `${label}.timeoutMs`),
    maxAttempts: optionalInteger(config.maxAttempts, provider.maxAttempts, 1, 5, `${label}.maxAttempts`),
    retryDelayMs: optionalInteger(config.retryDelayMs, provider.retryDelayMs, 0, 30_000, `${label}.retryDelayMs`),
    toolChoiceMode: optionalToolChoiceMode(config.toolChoiceMode, `${label}.toolChoiceMode`, provider.toolChoiceMode),
    runtimeContextPlacement: optionalRuntimeContextPlacement(
      config.runtimeContextPlacement,
      `${label}.runtimeContextPlacement`,
      provider.runtimeContextPlacement,
    ),
    protocol: optionalProtocol(config.protocol, `${label}.protocol`, provider.protocol),
  };
}

function legacyModelsFromProviders(
  providers: readonly OpenAICompatibleProviderConfig[],
): OpenAICompatibleModelConfig[] {
  return providers.map((provider) => ({
    key: legacyModelKeyForProvider(provider),
    displayName: provider.defaultModel,
    providerKey: provider.key,
    providerModel: provider.defaultModel,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    contextWindowTokens: provider.contextWindowTokens,
    maxOutputTokens: provider.maxOutputTokens,
    timeoutMs: provider.timeoutMs,
    maxAttempts: provider.maxAttempts,
    retryDelayMs: provider.retryDelayMs,
    toolChoiceMode: provider.toolChoiceMode,
    runtimeContextPlacement: provider.runtimeContextPlacement,
    protocol: provider.protocol,
  }));
}

function legacyModelKeyForProvider(provider: OpenAICompatibleProviderConfig): string {
  const candidate = provider.defaultModel.trim().toLowerCase();
  return MODEL_KEY_PATTERN.test(candidate) ? candidate : provider.key;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const invalid = Object.keys(value).filter((key) => !allowed.includes(key));
  if (invalid.length > 0) throw new Error(`${label} contains unsupported fields: ${invalid.join(", ")}`);
}

function requireProviderKey(value: unknown, label: string): string {
  const key = requireNonEmptyString(value, label, 80);
  if (!PROVIDER_KEY_PATTERN.test(key)) throw new Error(`${label} must use lowercase kebab-case`);
  return key;
}

function requireModelKey(value: unknown, label: string): string {
  const key = requireNonEmptyString(value, label, 120);
  if (!MODEL_KEY_PATTERN.test(key)) throw new Error(`${label} must use lowercase model-key syntax`);
  return key;
}

function requireEnvironmentKey(value: unknown, label: string): string {
  const key = requireNonEmptyString(value, label, 128);
  if (!ENVIRONMENT_KEY_PATTERN.test(key)) throw new Error(`${label} must be an environment-variable name`);
  return key;
}

function requireHttpUrl(value: unknown, label: string): string {
  const raw = requireNonEmptyString(value, label, 4_000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error(`${label} must be an HTTP(S) URL without embedded credentials`);
  }
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function requireNonEmptyString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value.trim();
}

function optionalInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function optionalDisplayName(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  return requireNonEmptyString(value, label, 120);
}

function optionalToolChoiceMode(
  value: unknown,
  label: string,
  fallback: "native" | "constrained-as-auto" = "native",
): "native" | "constrained-as-auto" {
  if (value === undefined) return fallback;
  if (value === "native" || value === "constrained-as-auto") return value;
  throw new Error(`${label} must be native or constrained-as-auto`);
}

function optionalRuntimeContextPlacement(
  value: unknown,
  label: string,
  fallback: RuntimeContextPlacement = "system",
): RuntimeContextPlacement {
  if (value === undefined) return fallback;
  if (value === "system" || value === "user-envelope") return value;
  throw new Error(`${label} must be system or user-envelope`);
}

function optionalProtocol(
  value: unknown,
  label: string,
  fallback: "chat-completions" | "responses" = "chat-completions",
): "chat-completions" | "responses" {
  if (value === undefined) return fallback;
  if (value === "chat-completions" || value === "responses") return value;
  throw new Error(`${label} must be chat-completions or responses`);
}
