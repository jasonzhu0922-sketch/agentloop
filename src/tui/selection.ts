export function parseSelection<T>(value: string, values: readonly T[]): T[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const selected = new Set<number>();
  for (const part of trimmed.split(",")) {
    const number = Number(part.trim());
    if (!Number.isSafeInteger(number) || number < 1 || number > values.length) {
      throw new Error(`请输入 1 到 ${values.length} 之间、以逗号分隔的序号。`);
    }
    selected.add(number - 1);
  }
  return [...selected].map((index) => values[index]);
}
