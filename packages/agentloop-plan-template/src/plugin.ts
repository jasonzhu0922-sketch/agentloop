import { createHash } from "node:crypto";
import type {
  PlanningExtension,
  PlanningExtensionContext,
  PlanningExtensionDecision,
  PlanningExtensionInput,
} from "@zhujun/agentloop";
import {
  normalizePlanTemplateConfig,
  normalizePlanTemplateStorageConfig,
  storageMigratesOnStart,
  type PlanTemplateFastPathConfig,
  type PlanTemplateMiningConfig,
  type PlanTemplateStorageConfig,
} from "./config.ts";
import { CandidateTemplateMiner } from "./mining/template-miner.ts";
import { profileTask } from "./profiler/task-profiler.ts";
import { routePlanTemplate } from "./planning/planner-template-router.ts";
import { createPlanTemplateConnection } from "./storage/connection-factory.ts";
import { SqlPlanTemplateStore } from "./storage/plan-template-store.ts";
import type { PlanTemplate, PlanTemplateManagementApi, PlanTemplateMatch, PlanTemplatePluginApi } from "./types.ts";

export interface PlanTemplatePluginOptions {
  readonly storage: PlanTemplateStorageConfig;
  readonly config?: Partial<PlanTemplateFastPathConfig>;
  readonly mining?: Partial<PlanTemplateMiningConfig>;
  readonly now?: () => Date;
}

export interface PlanTemplatePluginContext {
  readonly configDir?: string;
}

export interface PlanTemplatePlugin extends PlanTemplatePluginApi {
  extension(): PlanningExtension;
  store(): Promise<SqlPlanTemplateStore>;
}

export function createPlanTemplatePlugin(
  options: PlanTemplatePluginOptions,
  context?: PlanTemplatePluginContext,
): PlanTemplatePlugin {
  const config = normalizePlanTemplateConfig(options.config);
  const storage = normalizePlanTemplateStorageConfig(options.storage, { configBaseDir: context?.configDir });
  const now = options.now ?? (() => new Date());
  let storePromise: Promise<SqlPlanTemplateStore> | undefined;
  let managementApi: PlanTemplateManagementApi | undefined;
  let migrated = false;
  const pendingMatches = new Map<string, PlanTemplateMatch[]>();

  const ensureStore = async (): Promise<SqlPlanTemplateStore> => {
    if (storePromise === undefined) {
      storePromise = createPlanTemplateConnection(storage).then((connection) =>
        new SqlPlanTemplateStore({
          connection,
          ...(storage.type === "postgres" && storage.schemaName !== undefined
            ? { schemaName: storage.schemaName }
            : {}),
        })
      );
    }
    return storePromise;
  };

  const migrate = async (): Promise<void> => {
    const store = await ensureStore();
    await store.migrate();
    migrated = true;
  };

  const ensureMigratedIfConfigured = async (): Promise<void> => {
    if (!migrated && storageMigratesOnStart(storage)) await migrate();
  };

  const extension: PlanningExtension = {
    name: "agentloop-plan-template",
    beforePlanning: async (input: PlanningExtensionInput): Promise<PlanningExtensionDecision> => {
      if (!config.enabled) return { kind: "none" };
      await ensureMigratedIfConfigured();
      const store = await ensureStore();
      const fingerprint = profileTask(input);
      if (config.observeEnabled) {
        const match = newMatchRecord({
          runId: input.runId,
          fingerprint,
          decision: "observed",
          now,
          rejectionReasons: [],
        });
        appendPendingMatch(pendingMatches, input.runId, match);
        await store.recordMatch(match);
      }

      if (config.mode === "observe") return { kind: "none" };
      if (config.mode === "off") return { kind: "none" };

      const templates = await store.listCandidates(fingerprint);
      const decision = routePlanTemplate({
        task: input,
        fingerprint,
        templates,
        config,
      });
      const match = newMatchRecord({
        runId: input.runId,
        fingerprint,
        decision: decision.kind,
        now,
        ...(decision.kind === "rejected" ? { rejectionReasons: decision.rejectionReasons } : { rejectionReasons: [] }),
        ...(decision.kind === "rejected" ? {} : { templateId: decision.template.id, score: decision.score }),
      });
      appendPendingMatch(pendingMatches, input.runId, match);
      await store.recordMatch(match);
      if (decision.kind === "planner_context") {
        return {
          kind: "planner_context",
          context: templatePlanningContext(decision),
        };
      }
      if (decision.kind === "direct_use") {
        return {
          kind: "plan_proposal",
          proposal: decision.proposal,
          source: {
            kind: "planning_extension",
            extensionName: extension.name,
            templateId: decision.template.id,
            score: decision.score,
          },
        };
      }
      return { kind: "none" };
    },
    afterPlanAdmission: async (input) => {
      const matches = pendingMatches.get(input.runId);
      if (matches === undefined) return;
      const store = await ensureStore();
      const updatedMatches = matches.map((match) => ({
        ...match,
        admissionResult: {
          admitted: input.admitted,
          proposal: input.proposal,
          ...(input.planId === undefined ? {} : { planId: input.planId }),
          ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        },
      }));
      pendingMatches.set(input.runId, updatedMatches);
      for (const match of updatedMatches) {
        await store.recordMatch(match);
      }
    },
    afterOutcome: async (input) => {
      if ((!config.enabled || config.mode === "off") && !pendingMatches.has(input.runId)) return;
      await ensureMigratedIfConfigured();
      const store = await ensureStore();
      const matches = pendingMatches.get(input.runId);
      if (matches !== undefined) {
        const updatedMatches = matches.map((match) => ({
          ...match,
          outcomeStatus: input.status,
          admissionResult: mergeAdmissionOutcome(match.admissionResult, input),
        }));
        for (const match of updatedMatches) {
          await store.recordMatch(match);
        }
      } else {
        await store.recordOutcome({
          runId: input.runId,
          status: input.status,
          ...(input.planId === undefined ? {} : { planId: input.planId }),
          ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
          ...(input.output === undefined ? {} : { output: input.output }),
          recordedAt: now().toISOString(),
        });
      }
      pendingMatches.delete(input.runId);
    },
  };

  const createManagementApi = (): PlanTemplateManagementApi => ({
    runMiner: async () => {
      await ensureMigratedIfConfigured();
      const store = await ensureStore();
      return await new CandidateTemplateMiner({
        store,
        config: options.mining,
        now,
      }).runOnce();
    },
    listTemplates: async (filter) => {
      await ensureMigratedIfConfigured();
      const store = await ensureStore();
      return await store.listTemplates(filter);
    },
    getTemplate: async (id: string): Promise<PlanTemplate | null> => {
      await ensureMigratedIfConfigured();
      const store = await ensureStore();
      return await store.getTemplate(id);
    },
    approveTemplate: async (id: string): Promise<PlanTemplate> => {
      await ensureMigratedIfConfigured();
      const store = await ensureStore();
      return await store.updateTemplateStatus(id, "active");
    },
    retireTemplate: async (id: string): Promise<PlanTemplate> => {
      await ensureMigratedIfConfigured();
      const store = await ensureStore();
      return await store.updateTemplateStatus(id, "retired");
    },
  });

  return {
    migrate,
    close: async () => {
      if (storePromise === undefined) return;
      const store = await storePromise;
      await store.close();
    },
    extension: () => extension,
    store: ensureStore,
    managementApi: () => {
      managementApi ??= createManagementApi();
      return managementApi;
    },
  };
}

function mergeAdmissionOutcome(
  admissionResult: unknown,
  input: {
    readonly status: string;
    readonly planId?: string;
    readonly reasonCode?: string;
  },
): unknown {
  const admission = admissionResult !== null && typeof admissionResult === "object" && !Array.isArray(admissionResult)
    ? admissionResult as Record<string, unknown>
    : {};
  return {
    ...admission,
    outcome: {
      status: input.status,
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    },
  };
}

function appendPendingMatch(
  pendingMatches: Map<string, PlanTemplateMatch[]>,
  runId: string,
  match: PlanTemplateMatch,
): void {
  const current = pendingMatches.get(runId) ?? [];
  pendingMatches.set(runId, [...current, match]);
}

function newMatchRecord(input: {
  readonly runId: string;
  readonly fingerprint: PlanTemplateMatch["taskFingerprint"];
  readonly decision: PlanTemplateMatch["decision"];
  readonly now: () => Date;
  readonly rejectionReasons: readonly string[];
  readonly templateId?: string;
  readonly score?: number;
}): PlanTemplateMatch {
  return {
    id: `${input.runId}:${input.decision}:${hashJson(input.fingerprint).slice(0, 12)}`,
    runId: input.runId,
    taskFingerprint: input.fingerprint,
    decision: input.decision,
    rejectionReasons: input.rejectionReasons,
    ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
    ...(input.score === undefined ? {} : { score: input.score }),
    createdAt: input.now().toISOString(),
  };
}

function templatePlanningContext(input: {
  readonly template: { readonly id: string; readonly intentFamily: string; readonly planSkeleton: readonly { role: string }[]; readonly requiredEvidenceKinds: readonly string[] };
  readonly score: number;
}): PlanningExtensionContext {
  return {
    schema: "agentloop.planningExtensionContext/v1",
    extensionName: "agentloop-plan-template",
    kind: "template_hint",
    content: {
      templateId: input.template.id,
      intentFamily: input.template.intentFamily,
      score: input.score,
      stepRoles: input.template.planSkeleton.map((step) => step.role),
      requiredEvidenceKinds: input.template.requiredEvidenceKinds,
    },
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
