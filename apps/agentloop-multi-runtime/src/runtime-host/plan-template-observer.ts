import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createPlanTemplatePlugin,
  type PlanTemplateFastPathConfig,
  type PlanTemplateMiningConfig,
  type PlanTemplatePlugin,
  type PlanTemplateStorageConfig,
} from "@zhujun/agentloop-plan-template";

export interface PlanTemplateObserverOptions {
  readonly appRoot: string;
  readonly configPath?: string;
  readonly enabled?: string;
}

/**
 * Cloud Hosts observe template evidence before any template can influence a
 * Planner. Local Runtime Agents intentionally do not use this loader.
 */
export async function loadOptionalPlanTemplateObserver(
  options: PlanTemplateObserverOptions,
): Promise<PlanTemplatePlugin | undefined> {
  if (!planTemplateEnabled(options.enabled)) return undefined;
  const configPath = resolve(options.appRoot, options.configPath ?? "./config/plan-template.observe.json");
  const config = parseConfig(JSON.parse(await fs.readFile(configPath, "utf8")), configPath);
  return createPlanTemplatePlugin({
    storage: config.storage,
    config: {
      ...(config.config ?? {}),
      enabled: true,
      observeEnabled: true,
      mode: "observe",
      allowDirectUse: false,
    },
    ...(config.mining === undefined ? {} : { mining: config.mining }),
  }, {
    configDir: dirname(configPath),
  });
}

export function planTemplateEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0 || value === "false") return false;
  if (value === "true") return true;
  throw new Error("PLAN_TEMPLATE_ENABLED must be true or false");
}

interface PlanTemplateObserverConfig {
  readonly storage: PlanTemplateStorageConfig;
  readonly config?: Partial<PlanTemplateFastPathConfig>;
  readonly mining?: Partial<PlanTemplateMiningConfig>;
}

function parseConfig(input: unknown, path: string): PlanTemplateObserverConfig {
  if (!isRecord(input)) throw new Error(`PlanTemplate observer config must be an object: ${path}`);
  if (!isRecord(input.storage) || typeof input.storage.type !== "string") {
    throw new Error(`PlanTemplate observer config requires storage: ${path}`);
  }
  if (input.config !== undefined && !isRecord(input.config)) {
    throw new Error(`PlanTemplate observer config.config must be an object: ${path}`);
  }
  if (input.mining !== undefined && !isRecord(input.mining)) {
    throw new Error(`PlanTemplate observer config.mining must be an object: ${path}`);
  }
  return {
    storage: input.storage as PlanTemplateStorageConfig,
    ...(input.config === undefined ? {} : { config: input.config as Partial<PlanTemplateFastPathConfig> }),
    ...(input.mining === undefined ? {} : { mining: input.mining as Partial<PlanTemplateMiningConfig> }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
