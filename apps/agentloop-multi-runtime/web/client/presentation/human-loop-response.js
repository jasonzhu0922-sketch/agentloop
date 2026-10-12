export function humanLoopResponseText(request, value) {
  const schema = request?.responseSchema || {};
  if (schema.type === "select" && Array.isArray(value)) {
    const optionLabels = new Map((schema.options || []).map((option) => [option.id, option.label]));
    return value.length ? value.map((optionId) => optionLabels.get(optionId) || optionId).join("、") : "未选择";
  }
  if (schema.type === "confirm") {
    if (value === true) return schema.acceptLabel || "已确认";
    if (value && typeof value === "object" && value.accepted === false) return schema.rejectLabel || "已拒绝";
  }
  if (schema.type === "form" && value && typeof value === "object" && !Array.isArray(value)) {
    const fieldLabels = new Map((schema.fields || []).map((field) => [field.id, field.label]));
    return Object.entries(value).map(([fieldId, entry]) => `${fieldLabels.get(fieldId) || fieldId}: ${String(entry)}`).join("；");
  }
  if (value === true) return "已确认";
  if (Array.isArray(value)) return value.length ? value.join("、") : "未选择";
  if (value && typeof value === "object") return Object.entries(value).map(([key, entry]) => `${key}: ${String(entry)}`).join("；");
  return String(value ?? "");
}
