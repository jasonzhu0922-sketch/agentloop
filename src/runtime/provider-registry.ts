import type { AgentDefinition } from "../agents/agent-service.ts";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../shared/errors.ts";
import type { ModelAdapter } from "./contracts.ts";
import { OpenAICompatibleModel, ResponsesModel } from "./models.ts";
import type { RuntimeContextPlacement } from "./prompt-protocol.ts";

const PROVIDER_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;

export interface LlmProviderSummary {
  readonly key: string;
  readonly kind: "openai-compatible";
  readonly defaultModel: string;
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

interface ParsedProviderDocument {
  readonly defaultProvider: string;
  readonly providers: readonly OpenAICompatibleProviderConfig[];
}

/**
 * Server-owned registry for model providers.
 *
 * The JSON configuration defines only provider endpoints and the environment
 * variable containing each secret. Agent and Run inputs can select a declared
 * provider key and optionally override its model ID; they can never provide a
 * base URL, key, or other connection setting.
 */
export class LlmProviderRegistry {
  readonly defaultProviderKey: string;
  private readonly providers: ReadonlyMap<string, OpenAICompatibleProviderConfig>;
  private readonly environment: Readonly<Record<string, string | undefined>>;

  private constructor(
    parsed: ParsedProviderDocument,
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    this.defaultProviderKey = parsed.defaultProvider;
    this.providers = new Map(parsed.providers.map((provider) => [provider.key, provider]));
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

  create(agent: Pick<AgentDefinition, "providerKey" | "modelId">): ModelAdapter {
    const provider = this.providers.get(agent.providerKey);
    if (provider === undefined) {
      throw new AppError("MODEL_ERROR", `Unknown server-side provider key: ${agent.providerKey}`, 400);
    }
    const apiKey = this.environment[provider.apiKeyEnv];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new AppError("MODEL_ERROR", `LLM provider "${provider.key}" is not configured`, 503);
    }
    const modelOptions = {
      baseUrl: provider.baseUrl,
      apiKey,
      model: agent.modelId === "default" ? provider.defaultModel : agent.modelId,
      contextWindowTokens: provider.contextWindowTokens,
      maxOutputTokens: provider.maxOutputTokens,
      timeoutMs: provider.timeoutMs,
      maxAttempts: provider.maxAttempts,
      retryDelayMs: provider.retryDelayMs,
      toolChoiceMode: provider.toolChoiceMode,
      runtimeContextPlacement: provider.runtimeContextPlacement,
    };
    return provider.protocol === "responses"
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
  assertExactKeys(document, ["defaultProvider", "providers"], label);
  const defaultProvider = requireProviderKey(document.defaultProvider, `${label}.defaultProvider`);
  const providersRecord = requireObject(document.providers, `${label}.providers`);
  const entries = Object.entries(providersRecord);
  if (entries.length === 0) throw new Error(`${label}.providers must contain at least one provider`);
  const providers = entries.map(([key, config]) => parseProvider(key, config, label));
  if (!providers.some((provider) => provider.key === defaultProvider)) {
    throw new Error(`${label}.defaultProvider must name a configured provider`);
  }
  return { defaultProvider, providers };
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

function optionalToolChoiceMode(value: unknown, label: string): "native" | "constrained-as-auto" {
  if (value === undefined) return "native";
  if (value === "native" || value === "constrained-as-auto") return value;
  throw new Error(`${label} must be native or constrained-as-auto`);
}

function optionalRuntimeContextPlacement(value: unknown, label: string): RuntimeContextPlacement {
  if (value === undefined) return "system";
  if (value === "system" || value === "user-envelope") return value;
  throw new Error(`${label} must be system or user-envelope`);
}

function optionalProtocol(value: unknown, label: string): "chat-completions" | "responses" {
  if (value === undefined) return "chat-completions";
  if (value === "chat-completions" || value === "responses") return value;
  throw new Error(`${label} must be chat-completions or responses`);
}
