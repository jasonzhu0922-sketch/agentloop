export function providerKeyNames(config: unknown): string[];
export function readEnvValue(lines: readonly string[], name: string): string;
export function mergeEnvLines(lines: readonly string[], entries: readonly (readonly [string, string])[]): string[];
