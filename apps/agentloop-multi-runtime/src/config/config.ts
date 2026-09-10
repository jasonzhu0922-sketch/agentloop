import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { RuntimeInstance, RuntimeProfile } from "../domain/contracts.ts";

export interface SkillDirectoriesConfig {
  readonly schema: "agentloop.skillDirectories/v1";
  readonly customSkillDirectories: readonly string[];
}

export interface RuntimeEndpointConfig {
  readonly id: string;
  readonly endpoint: string;
  readonly profile: RuntimeProfile;
  readonly capabilities: readonly string[];
  readonly maxConcurrentRuns: number;
}

export interface MultiRuntimeConfig {
  readonly schema: "agentloop.multiRuntimeConfig/v1";
  readonly runtimes: readonly RuntimeEndpointConfig[];
}

export interface StepExecutionStrategyProfileConfig {
  readonly schema: "agentloop.stepExecutionStrategyConfig/v1";
  readonly profile: "action-aware" | "full-catalog";
  readonly projection: {
    readonly diagnosticProjectionCharacters?: number;
    readonly diagnosticPreviewCharacters?: number;
    readonly terminalProjectionCharacters?: number;
    readonly terminalPreviewCharacters?: number;
  };
}

export async function loadMultiRuntimeConfig(path: string): Promise<MultiRuntimeConfig> {
  return parseMultiRuntimeConfig(await readFile(path, "utf8"));
}

export async function loadStepExecutionStrategyProfileConfig(path: string): Promise<StepExecutionStrategyProfileConfig> {
  return parseStepExecutionStrategyProfileConfig(await readFile(path, "utf8"));
}

/**
 * Loads application-owned extension Skill roots. Relative directories are
 * deliberately resolved from the application root, never a Router request or
 * the Host process working directory.
 */
export async function loadSkillDirectoriesConfig(input: {
  readonly appRoot: string;
  readonly configPath: string;
}): Promise<readonly string[]> {
  return resolveSkillDirectoriesConfig(parseSkillDirectoriesConfig(await readFile(input.configPath, "utf8")), input.appRoot);
}

export function parseSkillDirectoriesConfig(raw: string): SkillDirectoriesConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("Skill directories config must be valid JSON");
  }
  if (!isRecord(value) || value.schema !== "agentloop.skillDirectories/v1" || !Array.isArray(value.customSkillDirectories)) {
    throw new TypeError("Skill directories config must use schema agentloop.skillDirectories/v1");
  }
  if (value.customSkillDirectories.some((directory) => typeof directory !== "string" || directory.trim().length === 0)) {
    throw new TypeError("customSkillDirectories must be an array of non-empty strings");
  }
  return {
    schema: "agentloop.skillDirectories/v1",
    customSkillDirectories: value.customSkillDirectories as readonly string[],
  };
}

export function resolveSkillDirectoriesConfig(config: SkillDirectoriesConfig, appRoot: string): readonly string[] {
  return uniqueStrings(config.customSkillDirectories.map((directory) => resolve(appRoot, directory)));
}

export function mergeSkillDirectories(
  bundledDirectories: readonly string[],
  customDirectories: readonly string[],
): readonly string[] {
  return uniqueStrings([...bundledDirectories, ...customDirectories]);
}

export function parseMultiRuntimeConfig(raw: string): MultiRuntimeConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("multi-runtime config must be valid JSON");
  }
  if (!isRecord(value) || value.schema !== "agentloop.multiRuntimeConfig/v1" || !Array.isArray(value.runtimes)) {
    throw new TypeError("multi-runtime config must use schema agentloop.multiRuntimeConfig/v1");
  }
  const ids = new Set<string>();
  const runtimes = value.runtimes.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`runtimes[${index}] must be an object`);
    const id = requiredString(item.id, `runtimes[${index}].id`);
    if (ids.has(id)) throw new TypeError(`duplicate runtime id: ${id}`);
    ids.add(id);
    const endpoint = requiredString(item.endpoint, `runtimes[${index}].endpoint`);
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new TypeError(`runtimes[${index}].endpoint must be an absolute URL`);
    }
    if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") {
      throw new TypeError(`runtimes[${index}].endpoint must use http or https`);
    }
    const profile = requiredString(item.profile, `runtimes[${index}].profile`);
    if (profile !== "general" && profile !== "artifact") {
      throw new TypeError(`runtimes[${index}].profile is not allowed in cloud v1`);
    }
    const capabilities = item.capabilities;
    if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string" || capability.length === 0)) {
      throw new TypeError(`runtimes[${index}].capabilities must be a string array`);
    }
    const maxConcurrentRuns = item.maxConcurrentRuns;
    if (typeof maxConcurrentRuns !== "number" || !Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
      throw new TypeError(`runtimes[${index}].maxConcurrentRuns must be a positive integer`);
    }
    for (const key of ["visibleDirectories", "workspaceRoot", "databasePath"]) {
      if (Object.hasOwn(item, key)) throw new TypeError(`${key} is not allowed in cloud runtime config`);
    }
    return {
      id,
      endpoint,
      profile: profile as RuntimeProfile,
      capabilities: capabilities as string[],
      maxConcurrentRuns: maxConcurrentRuns as number,
    };
  });
  return { schema: "agentloop.multiRuntimeConfig/v1", runtimes };
}

/**
 * Runtime Hosts intentionally accept only the built-in profiles. A Host's
 * execution policy is deployment configuration, not code supplied by Router
 * requests or individual tasks.
 */
export function parseStepExecutionStrategyProfileConfig(raw: string): StepExecutionStrategyProfileConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("step execution strategy config must be valid JSON");
  }
  if (!isRecord(value) || value.schema !== "agentloop.stepExecutionStrategyConfig/v1") {
    throw new TypeError("step execution strategy config must use schema agentloop.stepExecutionStrategyConfig/v1");
  }
  for (const field of Object.keys(value)) {
    if (!(["schema", "profile", "projection"] as readonly string[]).includes(field)) {
      throw new TypeError(`unsupported step execution strategy config field: ${field}`);
    }
  }
  const profile = requiredString(value.profile, "step execution strategy profile");
  if (profile !== "action-aware" && profile !== "full-catalog") {
    throw new TypeError("step execution strategy profile must be action-aware or full-catalog");
  }
  const projection = value.projection;
  if (projection === undefined) {
    return { schema: "agentloop.stepExecutionStrategyConfig/v1", profile, projection: {} };
  }
  if (!isRecord(projection)) throw new TypeError("step execution strategy projection must be an object");
  const allowedProjectionFields = [
    "diagnosticProjectionCharacters",
    "diagnosticPreviewCharacters",
    "terminalProjectionCharacters",
    "terminalPreviewCharacters",
  ];
  for (const field of Object.keys(projection)) {
    if (!allowedProjectionFields.includes(field)) throw new TypeError(`unsupported step execution strategy projection field: ${field}`);
  }
  const parsedProjection = Object.fromEntries(Object.entries(projection).map(([field, fieldValue]) => {
    if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue) || fieldValue < 1) {
      throw new TypeError(`step execution strategy projection ${field} must be a positive integer`);
    }
    return [field, fieldValue];
  }));
  return {
    schema: "agentloop.stepExecutionStrategyConfig/v1",
    profile,
    projection: parsedProjection,
  };
}

export function toRuntimeInstance(config: RuntimeEndpointConfig): RuntimeInstance {
  return { ...config, status: "ready", activeRunCount: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
  if (isAbsolute(value) && field.endsWith("endpoint")) throw new TypeError(`${field} must be a URL, not a local path`);
  return value;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
