/** Parse a deployment-owned model-turn budget before constructing RunService. */
export function parseTurnBudget(raw: string | undefined, name: string, maximum: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} 必须是正整数`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 之间的整数`);
  }
  return value;
}
