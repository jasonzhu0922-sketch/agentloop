export function modelSelectionStatus(models, selectedKey) {
  if (!selectedKey) return "模型：使用 Runtime 默认模型";
  const selected = (Array.isArray(models) ? models : []).find((model) => model?.key === selectedKey);
  return selected ? `模型：${selected.displayName || selected.key}` : "模型：使用 Runtime 默认模型";
}
