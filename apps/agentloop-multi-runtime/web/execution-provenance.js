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

export function executionProvenanceParts(message) {
  const runtimeName = text(message?.runtimeDisplayName);
  const modelKey = text(message?.modelKey);
  const isLive = message?.status === "running";
  return [
    { kind: "location", label: executionLocationLabel(message?.executionLocation) },
    { kind: "runtime", label: runtimeName === undefined ? "Runtime 未命名" : `Runtime ${runtimeName}` },
    { kind: "model", label: modelKey === undefined ? (isLive ? "模型确认中" : "模型未记录") : `模型 ${modelKey}` },
  ];
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
