/** Configuration metadata shared by the editor, registry and SDK factory. */
export const MODEL_PROVIDER_DEFINITIONS = [
  { id: "openai-compatible", label: "通用兼容服务", namespace: "agentloop", baseUrl: "", protocols: ["responses", "chat-completions"], defaultProtocol: "responses" },
  { id: "openai", label: "OpenAI", namespace: "openai", baseUrl: "https://api.openai.com/v1", protocols: ["responses", "chat-completions"], defaultProtocol: "responses" },
  { id: "deepseek", label: "DeepSeek", namespace: "deepseek", baseUrl: "https://api.deepseek.com/beta", protocols: ["chat-completions"], defaultProtocol: "chat-completions", strictToolBasePathSuffix: "/beta", hint: "DeepSeek 原生 SDK 的严格工具调用要求服务地址以 /beta 结尾。" },
  { id: "alibaba", label: "百炼 / Alibaba", namespace: "alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocols: ["chat-completions"], defaultProtocol: "chat-completions" },
] as const;
export type ModelProviderKind = typeof MODEL_PROVIDER_DEFINITIONS[number]["id"];
/** Service identity is independent of the SDK driver and of the hosted model name.
 * Compatible endpoint references:
 * https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions
 * https://platform.moonshot.cn/docs/guide/start-using-kimi-api
 * https://docs.bigmodel.cn/cn/api/introduction
 */
export const MODEL_SERVICE_PRESETS = [
  { id: "custom", label: "自定义兼容服务", kind: "openai-compatible", baseUrl: "", defaultProtocol: "responses" },
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", defaultProtocol: "responses" },
  { id: "deepseek", label: "DeepSeek", kind: "deepseek", baseUrl: "https://api.deepseek.com/beta", defaultProtocol: "chat-completions" },
  { id: "alibaba", label: "阿里云百炼", kind: "alibaba", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultProtocol: "chat-completions" },
  { id: "siliconflow", label: "硅基流动", kind: "openai-compatible", baseUrl: "https://api.siliconflow.cn/v1", defaultProtocol: "chat-completions", thinkingControl: "toggle", hint: "思考开关发送 enable_thinking，仅对支持此参数的模型生效。模型 ID 请从硅基流动控制台复制。" },
  { id: "moonshot", label: "Moonshot / Kimi", kind: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1", defaultProtocol: "chat-completions", hint: "请使用 Moonshot 控制台的模型 ID；思考参数及温度范围以所选模型文档为准。" },
  { id: "zhipu", label: "智谱开放平台", kind: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultProtocol: "chat-completions", hint: "请使用智谱控制台的模型 ID；模型专属参数可在高级设置中填写。" },
] as const;
export type ModelServicePresetId = typeof MODEL_SERVICE_PRESETS[number]["id"];
export function modelServicePreset(id: string) {
  const preset = MODEL_SERVICE_PRESETS.find(entry => entry.id === id);
  if (!preset) throw new TypeError("model_service_preset_invalid");
  return preset;
}
export const MODEL_REASONING_LEVELS = ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelReasoning = typeof MODEL_REASONING_LEVELS[number];
export function modelProviderDefinition(kind: string) {
  const definition = MODEL_PROVIDER_DEFINITIONS.find(entry => entry.id === kind);
  if (!definition) throw new TypeError("model_provider_kind_invalid");
  return definition;
}
export interface ModelEditorField {
  readonly key: string;
  readonly label: string;
  readonly type: "number" | "select";
  readonly group: "common" | "advanced";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly options?: readonly { value: string; label: string }[];
}
export const MODEL_SDK_RESERVED_OPTION_KEYS = [
  "apiKey", "apiKeyEnv", "baseUrl", "baseURL", "headers", "fetch", "abortSignal",
  "model", "messages", "input", "prompt", "instructions", "tools", "toolChoice", "tool_choice", "stream",
  "maxOutputTokens", "max_tokens", "max_completion_tokens", "max_output_tokens", "temperature", "topP", "top_p",
] as const;
export const MODEL_CONFIGURATION_EDITOR_SCHEMA = {
  reservedProviderOptions: MODEL_SDK_RESERVED_OPTION_KEYS,
  providers: MODEL_PROVIDER_DEFINITIONS,
  presets: MODEL_SERVICE_PRESETS,
  fields: [
    { key: "contextWindowTokens", label: "上下文窗口（Token）", type: "number", group: "common", min: 4096, max: 10000000, step: 1, placeholder: "默认 128000", hint: "留空使用 128000；请按服务实际支持的上限填写。" },
    { key: "maxOutputTokens", label: "最大输出（Token）", type: "number", group: "common", min: 1, max: 1000000, step: 1, placeholder: "默认上限 8192", hint: "留空最多使用 8192，按上下文窗口收缩；手动值必须小于上下文窗口。" },
    { key: "reasoning", label: "思考强度", type: "select", group: "common", hint: "由 Provider SDK 映射到厂商参数；相同档位在不同模型上的行为可能不同。", options: MODEL_REASONING_LEVELS.map((value, i) => ({ value, label: ["服务默认", "关闭思考", "最少", "低", "中", "高", "更高", "最高"][i]! })) },
    { key: "temperature", label: "温度", type: "number", group: "common", min: 0, max: 2, step: 0.1, placeholder: "服务默认", hint: "当前调用层仅对 Chat Completions 发送此参数；留空使用服务默认。" },
    { key: "topP", label: "Top P", type: "number", group: "advanced", min: 0, max: 1, step: 0.05 },
    { key: "timeoutMs", label: "请求超时（毫秒）", type: "number", group: "advanced", min: 1000, max: 1800000, step: 1, hint: "留空使用 120000。" },
    { key: "maxAttempts", label: "最多尝试次数", type: "number", group: "advanced", min: 1, max: 5, step: 1 },
    { key: "retryDelayMs", label: "重试间隔（毫秒）", type: "number", group: "advanced", min: 0, max: 30000, step: 1 },
    { key: "reasoningVisibility", label: "思考过程展示", type: "select", group: "advanced", hint: "仅控制界面展示，不会关闭模型思考。", options: [{ value: "visible", label: "显示" }, { value: "hidden", label: "隐藏" }] },
    { key: "toolChoiceMode", label: "工具选择策略", type: "select", group: "advanced", options: [{ value: "native", label: "原生" }, { value: "constrained-as-auto", label: "受限选择转自动" }, { value: "named-as-required", label: "指定工具转必选" }] },
    { key: "runtimeContextPlacement", label: "运行上下文位置", type: "select", group: "advanced", options: [{ value: "system", label: "系统消息" }, { value: "user-envelope", label: "用户消息" }] },
  ] satisfies readonly ModelEditorField[],
};

/** Validate the same field ranges and choices the editor presents. */
export function validateModelEditorFields(value: Record<string, unknown>, label: string): void {
  for (const field of MODEL_CONFIGURATION_EDITOR_SCHEMA.fields as readonly ModelEditorField[]) {
    const entry = value[field.key];
    if (entry === undefined) continue;
    if (field.type === "number") {
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry < field.min! || entry > field.max! || (field.step === 1 && !Number.isSafeInteger(entry))) throw new TypeError(`${label}.${field.key} is invalid`);
    } else if (!field.options!.some(option => option.value === entry)) throw new TypeError(`${label}.${field.key} is invalid`);
  }
}
