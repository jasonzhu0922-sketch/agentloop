export function providerKeyNames(config: unknown): string[];
export function readEnvValue(lines: readonly string[], name: string): string;
export function mergeEnvLines(lines: readonly string[], entries: readonly (readonly [string, string])[]): string[];
export function configurationForApply(text: string, envLines: readonly string[] | undefined, entries: readonly (readonly [string, string])[]): { configuration: Record<string, unknown>; credentialUpdates: Record<string, string>; environment?: string };
