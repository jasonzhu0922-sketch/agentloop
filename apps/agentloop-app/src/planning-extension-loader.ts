import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PlanningExtension } from "@zhujun/agentloop";

export interface PlanningExtensionLoaderOptions {
  readonly appRoot: string;
  readonly workspaceRoot: string;
  readonly configPath?: string;
}

export interface PlanningExtensionPluginContext {
  readonly appRoot: string;
  readonly workspaceRoot: string;
  readonly configPath: string;
  readonly configDir: string;
}

export interface LoadedPlanningExtensions {
  readonly extensions: readonly PlanningExtension[];
  close(): Promise<void>;
}

interface PlanningExtensionPluginConfig {
  readonly enabled: boolean;
  readonly module: string;
  readonly factory?: string;
  readonly optionsPath?: string;
  readonly options?: unknown;
}

const DEFAULT_CONFIG_PATH = "./config/planning-extensions.json";

export async function loadPlanningExtensions(
  options: PlanningExtensionLoaderOptions,
): Promise<LoadedPlanningExtensions> {
  const configPath = resolve(options.appRoot, options.configPath ?? DEFAULT_CONFIG_PATH);
  const configExists = await fileExists(configPath);
  if (!configExists) {
    if (options.configPath !== undefined) {
      throw new Error(`Planning extension config does not exist: ${configPath}`);
    }
    return emptyLoadedPlanningExtensions();
  }

  const config = parsePlanningExtensionConfig(
    JSON.parse(await fs.readFile(configPath, "utf8")),
  );
  if (!config.enabled) return emptyLoadedPlanningExtensions();

  const configDir = dirname(configPath);
  const extensions: PlanningExtension[] = [];
  const closers: Array<() => Promise<void>> = [];
  for (const plugin of config.plugins) {
    if (!plugin.enabled) continue;
    const moduleSpecifier = resolveModuleSpecifier(plugin.module, configDir);
    const moduleNamespace = await import(moduleSpecifier);
    const factory = resolvePluginFactory(moduleNamespace, plugin);
    const pluginOptions = await resolvePluginOptions(plugin, configDir);
    const instance = await factory(pluginOptions, {
      appRoot: options.appRoot,
      workspaceRoot: options.workspaceRoot,
      configPath,
      configDir,
    });
    extensions.push(resolvePlanningExtension(instance, plugin.module));
    if (isCloseablePlugin(instance)) {
      closers.push(() => instance.close());
    }
  }

  return {
    extensions,
    close: async () => {
      const failures: unknown[] = [];
      for (const close of closers.toReversed()) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more planning extension plugins failed to close");
      }
    },
  };
}

function parsePlanningExtensionConfig(input: unknown): {
  readonly enabled: boolean;
  readonly plugins: readonly PlanningExtensionPluginConfig[];
} {
  const record = requireRecord(input, "Planning extension config");
  const enabled = optionalBoolean(record.enabled, true, "Planning extension config enabled");
  const rawPlugins = record.planningExtensions ?? [];
  if (!Array.isArray(rawPlugins)) {
    throw new Error("planningExtensions must be an array");
  }
  return {
    enabled,
    plugins: rawPlugins.map(parsePluginConfig),
  };
}

function parsePluginConfig(input: unknown, index: number): PlanningExtensionPluginConfig {
  const record = requireRecord(input, `planningExtensions[${index}]`);
  const enabled = optionalBoolean(record.enabled, false, `planningExtensions[${index}].enabled`);
  if (!enabled) return { enabled, module: "" };
  const moduleSpecifier = requireString(record.module, `planningExtensions[${index}].module`);
  const factory = record.factory === undefined
    ? undefined
    : requireString(record.factory, `planningExtensions[${index}].factory`);
  const optionsPath = record.optionsPath === undefined
    ? undefined
    : requireString(record.optionsPath, `planningExtensions[${index}].optionsPath`);
  return {
    enabled,
    module: moduleSpecifier,
    ...(factory === undefined ? {} : { factory }),
    ...(optionsPath === undefined ? {} : { optionsPath }),
    ...(record.options === undefined ? {} : { options: record.options }),
  };
}

async function resolvePluginOptions(
  plugin: PlanningExtensionPluginConfig,
  configDir: string,
): Promise<unknown> {
  if (plugin.optionsPath === undefined) return plugin.options ?? {};
  const optionsPath = resolve(configDir, plugin.optionsPath);
  const fileOptions = JSON.parse(await fs.readFile(optionsPath, "utf8"));
  if (plugin.options === undefined) return fileOptions;
  return mergeJsonValues(fileOptions, plugin.options);
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

type PluginFactory = (
  options: unknown,
  context: PlanningExtensionPluginContext,
) => Promise<unknown> | unknown;

function resolvePluginFactory(
  moduleNamespace: Record<string, unknown>,
  plugin: PlanningExtensionPluginConfig,
): PluginFactory {
  if (plugin.factory !== undefined) {
    const factory = moduleNamespace[plugin.factory];
    if (typeof factory !== "function") {
      throw new Error(`Planning extension plugin ${plugin.module} does not export factory ${plugin.factory}`);
    }
    return factory as PluginFactory;
  }

  for (const exportName of ["createAgentLoopPlugin", "createPlugin", "default"]) {
    const factory = moduleNamespace[exportName];
    if (typeof factory === "function") return factory as PluginFactory;
  }
  throw new Error(`Planning extension plugin ${plugin.module} does not export a plugin factory`);
}

function resolvePlanningExtension(instance: unknown, moduleSpecifier: string): PlanningExtension {
  if (isPlanningExtension(instance)) return instance;
  if (isPluginWithExtension(instance)) {
    const extension = instance.extension();
    if (isPlanningExtension(extension)) return extension;
  }
  throw new Error(`Planning extension plugin ${moduleSpecifier} did not return a PlanningExtension`);
}

function isPlanningExtension(value: unknown): value is PlanningExtension {
  return (
    value !== null
    && typeof value === "object"
    && typeof (value as { name?: unknown }).name === "string"
    && typeof (value as { beforePlanning?: unknown }).beforePlanning === "function"
  );
}

function isPluginWithExtension(value: unknown): value is { extension(): unknown } {
  return (
    value !== null
    && typeof value === "object"
    && typeof (value as { extension?: unknown }).extension === "function"
  );
}

function isCloseablePlugin(value: unknown): value is { close(): Promise<void> } {
  return (
    value !== null
    && typeof value === "object"
    && typeof (value as { close?: unknown }).close === "function"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyLoadedPlanningExtensions(): LoadedPlanningExtensions {
  return {
    extensions: [],
    close: async () => {},
  };
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
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
