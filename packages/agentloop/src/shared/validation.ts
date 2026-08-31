import { badRequest } from "./errors.ts";

export function requireRecord(value: unknown, label = "body"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  if (typeof value !== "string") throw badRequest(`${label} must be a string`);
  const result = value.trim();
  const min = options.min ?? 1;
  if (result.length < min) throw badRequest(`${label} must contain at least ${min} characters`);
  if (options.max !== undefined && result.length > options.max) {
    throw badRequest(`${label} must contain at most ${options.max} characters`);
  }
  if (options.pattern !== undefined && !options.pattern.test(result)) {
    throw badRequest(`${label} has an invalid format`);
  }
  return result;
}

export function optionalString(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label, options);
}

export function requireStringArray(value: unknown, label: string, max = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw badRequest(`${label} must be an array with at most ${max} entries`);
  }
  const result = value.map((item, index) => requireString(item, `${label}[${index}]`, { max: 128 }));
  if (new Set(result).size !== result.length) throw badRequest(`${label} must not contain duplicates`);
  return result;
}

export function optionalPositiveInteger(
  value: unknown,
  label: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw badRequest(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value as number;
}
