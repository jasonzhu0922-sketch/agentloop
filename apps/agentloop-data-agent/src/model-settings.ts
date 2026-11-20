import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError, LlmProviderRegistry, modelProviderDefinition } from "@zhujun/agentloop";

type RecordValue = Record<string, any>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
function invalid(message: string): never { throw new AppError("BAD_REQUEST", message, 400); }
function text(value: unknown, label: string, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${label}无效`);
  return value.trim();
}

/** The existing provider document remains the sole model configuration source. */
export class ModelSettings {
  private document!: RecordValue;
  registry!: LlmProviderRegistry;
  readonly path: string;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(path: string, environment: NodeJS.ProcessEnv = process.env) {
    this.path = path; this.environment = environment;
  }
  async load() {
    this.document = JSON.parse(await readFile(this.path, "utf8"));
    this.registry = LlmProviderRegistry.fromConfigObject(this.document, this.environment);
    return this;
  }
  get defaultModelKey() { return this.environment.DATA_AGENT_MODEL_KEY ?? this.registry.defaultModelKey; }
  publicConfig() {
    return { revision: digest(this.document), defaultModelKey: this.defaultModelKey,
      models: this.registry.modelCatalog().map(model => {
        const provider = this.document.providers[model.providerKey];
        const overrides = this.document.models?.[model.key] ?? {};
        const effective = { ...provider, ...overrides };
        const contextWindowTokens = effective.contextWindowTokens ?? 128000;
        return { key: model.key, displayName: model.displayName, providerModel: model.providerModel,
          kind: model.kind, baseUrl: provider.baseUrl,
          protocol: effective.protocol ?? modelProviderDefinition(model.kind).defaultProtocol,
          temperature: effective.temperature ?? null, reasoning: effective.reasoning ?? "provider-default",
          providerOptions: effective.providerOptions ?? {}, reasoningVisibility: effective.reasoningVisibility ?? "visible",
          contextWindowTokens, maxOutputTokens: effective.maxOutputTokens ?? Math.min(8192, contextWindowTokens - 1),
          apiKeyConfigured: Boolean(provider.apiKey || this.environment[provider.apiKeyEnv]) };
      }) };
  }
  async save(input: RecordValue) {
    if (["enableThinking", "enable_thinking", "thinkingMode", "thinkingEffort", "reasoningEffort", "planningThinkingMode", "base_url"].some(key => Object.hasOwn(input, key))) invalid("请使用内核标准字段 kind、baseUrl 和 reasoning；厂商扩展使用 providerOptions");
    if (input.revision !== digest(this.document)) throw new AppError("CONFLICT", "模型配置已更新，请刷新后重试", 409);
    if (digest(JSON.parse(await readFile(this.path, "utf8"))) !== input.revision) throw new AppError("CONFLICT", "模型配置文件已更新，请刷新后重试", 409);
    const next = structuredClone(this.document);
    // Normalize documents that rely on the registry's implicit model entries.
    next.models ??= Object.fromEntries(this.registry.modelCatalog().map(m => [m.key, { providerKey: m.providerKey, providerModel: m.providerModel, displayName: m.displayName }]));
    next.defaultModelKey = this.defaultModelKey;
    const key = input.key == null ? `model-${randomUUID().slice(0, 8)}` : text(input.key, "模型标识");
    const prior = this.registry.modelCatalog().find(m => m.key === key);
    if (input.key != null && !prior) invalid("模型不存在");
    if (input.remove === true) {
      if (key === this.defaultModelKey) invalid("请先选择其他默认模型，再删除此模型");
      delete next.models[key];
    } else {
      const displayName = text(input.displayName, "展示名称", 160);
      const name = text(input.providerModel, "模型名称", 160);
      const kind = text(input.kind, "接入服务类型");
      try { modelProviderDefinition(kind); } catch { invalid("接入服务类型无效"); }
      const baseUrl = text(input.baseUrl, "Base URL", 2048);
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { invalid("Base URL 无效"); }
      if (!["http:", "https:"].includes(parsed!.protocol) || parsed!.username || parsed!.password || parsed!.search || parsed!.hash) invalid("Base URL 必须为不含凭据和查询参数的 HTTP(S) 地址");
      const previous = prior ? { ...next.providers[prior.providerKey], ...next.models[key] } : {};
      const shared = prior && Object.values(next.models).filter((m: any) => m.providerKey === prior.providerKey).length > 1;
      const providerKey = prior && !shared ? prior.providerKey : `data-agent-${randomUUID()}`;
      const provider: RecordValue = { ...previous, kind, baseUrl, defaultModel: name,
        protocol: input.protocol, contextWindowTokens: input.contextWindowTokens, maxOutputTokens: input.maxOutputTokens,
        reasoning: input.reasoning, reasoningVisibility: input.reasoningVisibility ?? previous.reasoningVisibility };
      for (const field of ["providerKey", "providerModel", "displayName", "enableThinking", "thinkingMode", "thinkingEffort", "reasoningEffort", "planningThinkingMode", "temperature"]) delete provider[field];
      if (input.temperature != null) provider.temperature = input.temperature;
      if (input.providerOptions !== undefined) provider.providerOptions = input.providerOptions;
      // Credentials belong to the configured service identity, never to a new URL or SDK selected by the form.
      if (prior && (kind !== prior.kind || baseUrl !== previous.baseUrl)) {
        delete provider.apiKey; delete provider.apiKeyEnv;
        if (input.providerOptions === undefined && previous.providerOptions !== undefined) invalid("切换接入服务时请明确设置新服务的 SDK 扩展参数");
      }
      if (typeof input.apiKey === "string" && input.apiKey.trim()) {
        provider.apiKey = text(input.apiKey, "API Key", 8192); delete provider.apiKeyEnv;
      }
      if (!provider.apiKey && !this.environment[provider.apiKeyEnv]) invalid("请配置 API Key");
      next.providers[providerKey] = provider;
      next.models[key] = { providerKey, providerModel: name, displayName };
      if (input.isDefault === true) {
        if (this.environment.DATA_AGENT_MODEL_KEY && this.environment.DATA_AGENT_MODEL_KEY !== key) invalid("启动参数 DATA_AGENT_MODEL_KEY 固定了默认模型，请先移除该参数");
        next.defaultModelKey = key;
      }
    }
    const used = new Set(Object.values(next.models).map((v: any) => v.providerKey));
    for (const providerKey of Object.keys(next.providers)) if (!used.has(providerKey)) delete next.providers[providerKey];
    next.defaultProvider = next.models[next.defaultModelKey].providerKey;
    let registry: LlmProviderRegistry;
    try {
      registry = LlmProviderRegistry.fromConfigObject(next, this.environment);
      registry.create(key === this.defaultModelKey && input.remove ? next.defaultModelKey : input.remove ? this.defaultModelKey : key);
    } catch { invalid("模型参数无效，请检查协议、上下文窗口、输出上限和 API Key"); }
    await atomicJson(this.path, next);
    this.document = next; this.registry = registry!;
    return this.publicConfig();
  }
}
