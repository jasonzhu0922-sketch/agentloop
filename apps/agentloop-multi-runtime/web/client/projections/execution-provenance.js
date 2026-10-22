/**
 * Per-turn execution facts. Keep this independent of the Composer's current
 * selections: a conversation can contain turns from different Runtimes.
 */
export function executionLocationLabel(location) {
  if (location === "cloud") return "云端";
  if (location === "local") return "本机";
  if (location === "strict_local") return "严格本地";
  return "执行位置未记录";
}

export function executionProvenanceParts(message, models = []) {
  const runtimeName = text(message?.runtimeDisplayName);
  const modelKey = text(message?.modelKey);
  const modelDisplayName = text(message?.modelDisplayName) ?? modelDisplayNameForKey(models, modelKey);
  const isLive = message?.status === "running";
  const runtimePart = message?.executionLocation === "cloud"
    ? []
    : [{ kind: "runtime", label: runtimeName === undefined ? "Runtime 未命名" : `Runtime ${runtimeName}` }];
  return [
    { kind: "location", label: executionLocationLabel(message?.executionLocation) },
    ...runtimePart,
    { kind: "model", label: modelKey === undefined ? (isLive ? "模型确认中" : "模型未记录") : `模型 ${modelDisplayName ?? modelKey}` },
  ];
}

function modelDisplayNameForKey(models, modelKey) {
  if (modelKey === undefined || !Array.isArray(models)) return undefined;
  const model = models.find((candidate) => candidate?.key === modelKey);
  return text(model?.displayName);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
