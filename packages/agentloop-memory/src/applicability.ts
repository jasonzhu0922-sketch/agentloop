import type { MemoryApplicability } from "./types.ts";

/** Exact selectors restrict scope. Text similarity only ranks suggestions; it
 * never proves a natural-language condition or grants authority. */
export function applicabilityMatches(scope: MemoryApplicability, context: Readonly<Record<string, unknown>>): boolean {
  const intersects = (key: string, expected: readonly unknown[]) => {
    const actual = context[key];
    return (Array.isArray(actual) ? actual : [actual]).some(item => expected.includes(item));
  };
  return Object.entries(scope.context ?? {}).every(([key, values]) => intersects(key, values))
    && !Object.entries(scope.excludedContext ?? {}).some(([key, values]) => intersects(key, values));
}
