import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createStepExecutionStrategyProfile,
  type StepExecutionStrategy,
} from "@zhujun/agentloop";

export interface StepExecutionStrategyConfigLoaderOptions {
  readonly configPath: string;
  readonly required?: boolean;
  readonly appRoot?: string;
  readonly workspaceRoot?: string;
}

export interface StepExecutionStrategyPluginContext {
  readonly appRoot?: string;
  readonly workspaceRoot?: string;
  readonly configPath: string;
  readonly configDir: string;
}

export async function loadStepExecutionStrategyFromConfigFile(
  options: StepExecutionStrategyConfigLoaderOptions,
): Promise<StepExecutionStrategy> {
  const exists = await fileExists(options.configPath);
  if (!exists) {
    if (options.required === true) {
      throw new Error(`Step execution strategy config does not exist: ${options.configPath}`);
    }
    return createStepExecutionStrategyProfile("full-catalog");
  }
  const raw = JSON.parse(await fs.readFile(options.configPath, "utf8"));
  const config = parseStepExecutionStrategyConfig(raw);
  if (config.kind === "module") {
    return loadStepExecutionStrategyPlugin(config, {
      appRoot: options.appRoot,
      workspaceRoot: options.workspaceRoot,
      configPath: options.configPath,
      configDir: dirname(options.configPath),
    });
  }
  return createStepExecutionStrategyProfile(config.profile, config.projection);
}

export type StepExecutionStrategyConfig = BuiltInStepExecutionStrategyConfig | ModuleStepExecutionStrategyConfig;

export interface BuiltInStepExecutionStrategyConfig {
  readonly kind: "profile";
  readonly schema?: "agentloop.stepExecutionStrategyConfig/v1";
  readonly profile: "action-aware" | "full-catalog";
  readonly projection: {
    readonly diagnosticProjectionCharacters?: number;
    readonly diagnosticPreviewCharacters?: number;
    readonly terminalProjectionCharacters?: number;
    readonly terminalPreviewCharacters?: number;
  };
}

export interface ModuleStepExecutionStrategyConfig {
  readonly kind: "module";
  readonly schema?: "agentloop.stepExecutionStrategyConfig/v1";
  readonly module: string;
  readonly factory?: string;
  readonly optionsPath?: string;
  readonly options?: unknown;
}

export function parseStepExecutionStrategyConfig(input: unknown): StepExecutionStrategyConfig {
  const record = requireRecord(input, "Step execution strategy config");
  const schema = optionalString(record.schema, "Step execution strategy config schema");
  if (schema !== undefined && schema !== "agentloop.stepExecutionStrategyConfig/v1") {
    throw new Error(`Unsupported Step execution strategy config schema: ${schema}`);
  }
  if (record.module !== undefined) {
    if (record.profile !== undefined || record.projection !== undefined) {
      throw new Error("Step execution strategy config cannot combine module with profile/projection");
    }
    const moduleSpecifier = optionalString(record.module, "Step execution strategy module");
    if (moduleSpecifier === undefined) {
      throw new Error("Step execution strategy module must be a non-empty string");
    }
    const factory = record.factory === undefined
      ? undefined
      : optionalString(record.factory, "Step execution strategy factory");
    const optionsPath = record.optionsPath === undefined
      ? undefined
      : optionalString(record.optionsPath, "Step execution strategy optionsPath");
    assertNoUnknownFields(record, ["schema", "module", "factory", "optionsPath", "options"], "Step execution strategy config");
    return {
      kind: "module",
      ...(schema === undefined ? {} : { schema }),
      module: moduleSpecifier,
      ...(factory === undefined ? {} : { factory }),
      ...(optionsPath === undefined ? {} : { optionsPath }),
      ...(record.options === undefined ? {} : { options: record.options }),
    };
  }
  const profile = optionalString(record.profile, "Step execution strategy profile") ?? "full-catalog";
  if (profile !== "action-aware" && profile !== "full-catalog") {
    throw new Error(`Unsupported Step execution strategy profile: ${profile}`);
  }
  const projection = record.projection === undefined
    ? {}
    : parseProjectionConfig(record.projection);
  assertNoUnknownFields(record, ["schema", "profile", "projection"], "Step execution strategy config");
  return {
    kind: "profile",
    ...(schema === undefined ? {} : { schema }),
    profile,
    projection,
  };
}

function parseProjectionConfig(input: unknown): BuiltInStepExecutionStrategyConfig["projection"] {
  const record = requireRecord(input, "Step execution strategy projection");
  assertNoUnknownFields(record, [
    "diagnosticProjectionCharacters",
    "diagnosticPreviewCharacters",
    "terminalProjectionCharacters",
    "terminalPreviewCharacters",
  ], "Step execution strategy projection");
  return {
    diagnosticProjectionCharacters: optionalPositiveInteger(record.diagnosticProjectionCharacters, "diagnosticProjectionCharacters"),
    diagnosticPreviewCharacters: optionalPositiveInteger(record.diagnosticPreviewCharacters, "diagnosticPreviewCharacters"),
    terminalProjectionCharacters: optionalPositiveInteger(record.terminalProjectionCharacters, "terminalProjectionCharacters"),
    terminalPreviewCharacters: optionalPositiveInteger(record.terminalPreviewCharacters, "terminalPreviewCharacters"),
  };
}

async function loadStepExecutionStrategyPlugin(
  config: ModuleStepExecutionStrategyConfig,
  context: StepExecutionStrategyPluginContext,
): Promise<StepExecutionStrategy> {
  const moduleSpecifier = resolveModuleSpecifier(config.module, context.configDir);
  const moduleNamespace = await import(moduleSpecifier);
  const factory = resolveStrategyFactory(moduleNamespace, config);
  const pluginOptions = await resolvePluginOptions(config, context.configDir);
  const instance = await factory(pluginOptions, context);
  return resolveStepExecutionStrategy(instance, config.module);
}

type StepExecutionStrategyFactory = (
  options: unknown,
  context: StepExecutionStrategyPluginContext,
) => Promise<unknown> | unknown;

async function resolvePluginOptions(
  config: ModuleStepExecutionStrategyConfig,
  configDir: string,
): Promise<unknown> {
  if (config.optionsPath === undefined) return config.options ?? {};
  const optionsPath = resolve(configDir, config.optionsPath);
  const fileOptions = JSON.parse(await fs.readFile(optionsPath, "utf8"));
  if (config.options === undefined) return fileOptions;
  return mergeJsonValues(fileOptions, config.options);
}

function mergeJsonValues(base: unknown, override: unknown): unknown {
  if (isPlainRecord(base) && isPlainRecord(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? mergeJsonValues(merged[key], value) : value;
    }
    return merged;
  }
  return override;
}

function resolveModuleSpecifier(moduleSpecifier: string, configDir: string): string {
  if (moduleSpecifier.startsWith("file:")) return moduleSpecifier;
  if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/") || moduleSpecifier.startsWith("..")) {
    const absolutePath = isAbsolute(moduleSpecifier) ? moduleSpecifier : resolve(configDir, moduleSpecifier);
    return pathToFileURL(absolutePath).href;
  }
  return moduleSpecifier;
}

function resolveStrategyFactory(
  moduleNamespace: Record<string, unknown>,
  config: ModuleStepExecutionStrategyConfig,
): StepExecutionStrategyFactory {
  if (config.factory !== undefined) {
    const factory = moduleNamespace[config.factory];
    if (typeof factory !== "function") {
      throw new Error(`Step execution strategy plugin ${config.module} does not export factory ${config.factory}`);
    }
    return factory as StepExecutionStrategyFactory;
  }
  for (const exportName of ["createStepExecutionStrategy", "createAgentLoopStepExecutionStrategy", "createPlugin", "default"]) {
    const factory = moduleNamespace[exportName];
    if (typeof factory === "function") return factory as StepExecutionStrategyFactory;
  }
  throw new Error(`Step execution strategy plugin ${config.module} does not export a strategy factory`);
}

function resolveStepExecutionStrategy(instance: unknown, moduleSpecifier: string): StepExecutionStrategy {
  if (isStepExecutionStrategy(instance)) return instance;
  if (isPluginWithStrategy(instance)) {
    const strategy = instance.stepExecutionStrategy();
    if (isStepExecutionStrategy(strategy)) return strategy;
  }
  throw new Error(`Step execution strategy plugin ${moduleSpecifier} did not return a StepExecutionStrategy`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStepExecutionStrategy(value: unknown): value is StepExecutionStrategy {
  return (
    value !== null
    && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { prepareModelStep?: unknown }).prepareModelStep === "function"
  );
}

function isPluginWithStrategy(value: unknown): value is { stepExecutionStrategy(): unknown } {
  return (
    value !== null
    && typeof value === "object"
    && typeof (value as { stepExecutionStrategy?: unknown }).stepExecutionStrategy === "function"
  );
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertNoUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
  }
}
