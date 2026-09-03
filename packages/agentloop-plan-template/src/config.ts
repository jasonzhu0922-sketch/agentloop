import { isAbsolute, resolve } from "node:path";

export type PlanTemplateFastPathMode = "off" | "observe" | "planner_context" | "direct_use";
export type PlanTemplateRiskLevel = "low" | "medium" | "high";

export interface PlanTemplateFastPathConfig {
  readonly schema: "agentloop.planTemplateFastPathConfig/v1";
  readonly enabled: boolean;
  readonly observeEnabled: boolean;
  readonly mode: PlanTemplateFastPathMode;
  readonly allowDirectUse: boolean;
  readonly minDirectUseScore: number;
  readonly minPlannerContextScore: number;
  readonly allowedRiskCeiling: PlanTemplateRiskLevel;
  readonly allowedIntentFamilies?: readonly string[];
  readonly disabledIntentFamilies?: readonly string[];
  readonly requireActiveTemplateForDirectUse: boolean;
}

export interface PlanTemplateMiningConfig {
  readonly minCompletedRunsForCandidate: number;
  readonly maxObservedMatchesPerRun: number;
  readonly allowedRiskCeiling: PlanTemplateRiskLevel;
  readonly excludedSideEffectKinds: readonly string[];
}

export type PlanTemplateStorageConfig =
  | {
      readonly type: "sqlite";
      readonly databasePath: string;
      readonly busyTimeoutMs?: number;
      readonly migrateOnStart?: boolean;
    }
  | {
      readonly type: "postgres";
      readonly connectionString: string;
      readonly schemaName?: string;
      readonly poolSize?: number;
      readonly migrateOnStart?: boolean;
    };

export const DEFAULT_PLAN_TEMPLATE_FAST_PATH_CONFIG: PlanTemplateFastPathConfig = {
  schema: "agentloop.planTemplateFastPathConfig/v1",
  enabled: false,
  observeEnabled: false,
  mode: "off",
  allowDirectUse: false,
  minDirectUseScore: 0.9,
  minPlannerContextScore: 0.7,
  allowedRiskCeiling: "low",
  requireActiveTemplateForDirectUse: true,
};

export const DEFAULT_PLAN_TEMPLATE_MINING_CONFIG: PlanTemplateMiningConfig = {
  minCompletedRunsForCandidate: 3,
  maxObservedMatchesPerRun: 500,
  allowedRiskCeiling: "low",
  excludedSideEffectKinds: ["send_email", "external_api", "browser_operation"],
};

export function normalizePlanTemplateConfig(
  input?: Partial<PlanTemplateFastPathConfig>,
): PlanTemplateFastPathConfig {
  return {
    ...DEFAULT_PLAN_TEMPLATE_FAST_PATH_CONFIG,
    ...(input ?? {}),
    schema: "agentloop.planTemplateFastPathConfig/v1",
  };
}

export function normalizePlanTemplateMiningConfig(
  input?: Partial<PlanTemplateMiningConfig>,
): PlanTemplateMiningConfig {
  return {
    ...DEFAULT_PLAN_TEMPLATE_MINING_CONFIG,
    ...(input ?? {}),
    excludedSideEffectKinds: input?.excludedSideEffectKinds ?? DEFAULT_PLAN_TEMPLATE_MINING_CONFIG.excludedSideEffectKinds,
  };
}

export function normalizePlanTemplateStorageConfig(
  input: PlanTemplateStorageConfig,
  context?: { readonly configBaseDir?: string },
): PlanTemplateStorageConfig {
  if (input.type !== "sqlite") return input;
  if (input.databasePath === ":memory:" || isAbsolute(input.databasePath)) return input;
  return {
    ...input,
    databasePath: resolve(context?.configBaseDir ?? process.cwd(), input.databasePath),
  };
}

export function storageMigratesOnStart(config: PlanTemplateStorageConfig): boolean {
  return config.migrateOnStart === true;
}
