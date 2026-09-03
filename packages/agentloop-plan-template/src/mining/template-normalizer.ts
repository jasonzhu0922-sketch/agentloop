export function normalizeTemplateText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
