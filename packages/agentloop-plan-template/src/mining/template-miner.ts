import { createHash } from "node:crypto";
import type { EvidenceKind, PlanProposal, PlanStepProposal } from "@zhujun/agentloop";
import { normalizePlanTemplateMiningConfig, type PlanTemplateMiningConfig, type PlanTemplateRiskLevel } from "../config.ts";
import type {
  PlanStepSkeleton,
  PlanTemplate,
  PlanTemplateExample,
  PlanTemplateMatch,
  TaskFingerprint,
  TemplateMiningResult,
  TemplateReliability,
} from "../types.ts";
import type { SqlPlanTemplateStore } from "../storage/plan-template-store.ts";

export interface TemplateMiner {
  runOnce(): Promise<TemplateMiningResult>;
}

export interface CandidateTemplateMinerOptions {
  readonly store: SqlPlanTemplateStore;
  readonly config?: Partial<PlanTemplateMiningConfig>;
  readonly now?: () => Date;
}

interface EligibleExample {
  readonly match: PlanTemplateMatch;
  readonly proposal: PlanProposal;
  readonly shapeKey: string;
}

export class CandidateTemplateMiner implements TemplateMiner {
  private readonly store: SqlPlanTemplateStore;
  private readonly config: PlanTemplateMiningConfig;
  private readonly now: () => Date;

  constructor(options: CandidateTemplateMinerOptions) {
    this.store = options.store;
    this.config = normalizePlanTemplateMiningConfig(options.config);
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<TemplateMiningResult> {
    const matches = await this.store.listObservedMatchesForMining(this.config.maxObservedMatchesPerRun);
    const skippedMatches: Array<{ runId: string; reason: string }> = [];
    const clusters = new Map<string, EligibleExample[]>();

    for (const match of matches) {
      const eligible = this.toEligibleExample(match);
      if (eligible.kind === "skip") {
        skippedMatches.push({ runId: match.runId, reason: eligible.reason });
        continue;
      }
      const examples = clusters.get(eligible.example.shapeKey) ?? [];
      examples.push(eligible.example);
      clusters.set(eligible.example.shapeKey, examples);
    }

    let candidateTemplatesCreated = 0;
    let candidateTemplatesUpdated = 0;
    let eligibleExamples = 0;
    for (const examples of clusters.values()) {
      eligibleExamples += examples.length;
      if (examples.length < this.config.minCompletedRunsForCandidate) continue;
      const template = this.templateFromExamples(examples);
      const existing = await this.store.getTemplate(template.id);
      await this.store.upsertTemplate({
        ...template,
        version: existing === null ? 1 : existing.version + 1,
        status: existing?.status === "active" ? "active" : "candidate",
      });
      if (existing === null) candidateTemplatesCreated += 1;
      else candidateTemplatesUpdated += 1;

      for (const example of examples) {
        await this.store.recordExample(exampleForTemplate(template.id, example, this.now));
      }
    }

    return {
      scannedMatches: matches.length,
      eligibleExamples,
      candidateTemplatesCreated,
      candidateTemplatesUpdated,
      skippedMatches,
    };
  }

  private toEligibleExample(
    match: PlanTemplateMatch,
  ): { readonly kind: "example"; readonly example: EligibleExample } | { readonly kind: "skip"; readonly reason: string } {
    if (match.outcomeStatus !== "completed") return { kind: "skip", reason: "outcome_not_completed" };
    if (riskRank(match.taskFingerprint.riskLevel) > riskRank(this.config.allowedRiskCeiling)) {
      return { kind: "skip", reason: "risk_above_mining_ceiling" };
    }
    if (this.config.excludedSideEffectKinds.includes(match.taskFingerprint.sideEffectKind)) {
      return { kind: "skip", reason: "side_effect_excluded" };
    }
    const admission = admissionResult(match);
    if (admission === null || admission.admitted !== true) return { kind: "skip", reason: "plan_not_admitted" };
    const outcome = admission.outcome;
    if (outcome?.reasonCode !== "plan_assessed_and_completed") {
      return { kind: "skip", reason: "missing_canonical_completed_outcome" };
    }
    if (!isPlanProposal(admission.proposal)) return { kind: "skip", reason: "missing_plan_proposal_snapshot" };
    if (admission.proposal.shape === "recovery_patch") return { kind: "skip", reason: "recovery_patch_plan" };
    if (admission.proposal.steps.length === 0) return { kind: "skip", reason: "empty_plan" };
    return {
      kind: "example",
      example: {
        match,
        proposal: admission.proposal,
        shapeKey: shapeKey(match.taskFingerprint, admission.proposal),
      },
    };
  }

  private templateFromExamples(examples: readonly EligibleExample[]): PlanTemplate {
    const first = examples[0];
    if (first === undefined) throw new Error("Cannot create a PlanTemplate from an empty example cluster");
    const fingerprint = first.match.taskFingerprint;
    const proposal = first.proposal;
    const now = this.now().toISOString();
    const templateId = `template_${first.shapeKey.slice(0, 16)}`;
    const completedRuns = examples.length;
    return {
      schema: "agentloop.planTemplate/v1",
      id: templateId,
      version: 1,
      status: "candidate",
      intentFamily: fingerprint.intentHints[0] ?? "direct_answer",
      sourceNeed: fingerprint.sourceNeed,
      acceptedSourceTypes: unique(examples.flatMap((example) => example.match.taskFingerprint.sourceTypes)),
      artifactKind: fingerprint.artifactKind,
      sideEffectKind: fingerprint.sideEffectKind,
      requiredCapabilities: unique(examples.flatMap((example) => example.match.taskFingerprint.requiredCapabilities)),
      requiredEvidenceKinds: evidenceKindsFromProposal(proposal),
      riskCeiling: maxRisk(examples.map((example) => example.match.taskFingerprint.riskLevel)),
      planSkeleton: skeletonFromProposal(proposal),
      positiveExampleRefs: examples.map((example) => example.match.runId),
      negativeExampleRefs: [],
      reliability: {
        completedRuns,
        admittedRuns: completedRuns,
        failedRuns: 0,
        planAdmissionFailureRate: 0,
        assessmentFailureRate: 0,
        repairRate: 0,
        avgPlannerSavedMs: 0,
        updatedAt: now,
      },
    };
  }
}

export class NoopTemplateMiner implements TemplateMiner {
  async runOnce(): Promise<TemplateMiningResult> {
    return {
      scannedMatches: 0,
      eligibleExamples: 0,
      candidateTemplatesCreated: 0,
      candidateTemplatesUpdated: 0,
      skippedMatches: [],
    };
  }
}

function admissionResult(match: PlanTemplateMatch): {
  readonly admitted?: boolean;
  readonly proposal?: unknown;
  readonly outcome?: { readonly reasonCode?: string };
} | null {
  const value = match.admissionResult;
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as {
    readonly admitted?: boolean;
    readonly proposal?: unknown;
    readonly outcome?: { readonly reasonCode?: string };
  };
}

function isPlanProposal(value: unknown): value is PlanProposal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { goal?: unknown; selectedSkillIds?: unknown; steps?: unknown };
  return typeof record.goal === "string" && Array.isArray(record.selectedSkillIds) && Array.isArray(record.steps);
}

function shapeKey(fingerprint: TaskFingerprint, proposal: PlanProposal): string {
  return hashJson({
    fingerprint: {
      intentHints: fingerprint.intentHints,
      sourceNeed: fingerprint.sourceNeed,
      sourceTypes: fingerprint.sourceTypes,
      artifactKind: fingerprint.artifactKind,
      sideEffectKind: fingerprint.sideEffectKind,
      requiredCapabilities: fingerprint.requiredCapabilities,
      skillHints: fingerprint.skillHints,
      instructionTokens: fingerprint.instructionTokens,
      outputConstraints: fingerprint.outputConstraints,
      riskLevel: fingerprint.riskLevel,
    },
    plan: {
      shape: proposal.shape ?? inferShape(proposal),
      selectedSkillIds: proposal.selectedSkillIds,
      steps: proposal.steps.map((step) => ({
        role: normalizedRole(proposal, step),
        dependencies: dependencyPositions(proposal.steps, step),
        skillIds: step.skillIds,
        evidenceKinds: step.evidenceContract?.requiredKinds ?? [],
      })),
    },
  });
}

function skeletonFromProposal(proposal: PlanProposal): readonly PlanStepSkeleton[] {
  const ids = new Map(proposal.steps.map((step, index) => [step.id, `step_${index + 1}`]));
  return proposal.steps.map((step, index) => {
    const id = ids.get(step.id) ?? `step_${index + 1}`;
    const requiredEvidenceKinds = step.evidenceContract?.requiredKinds ?? [];
    return {
      id,
      role: step.role ?? "produce",
      operationRef: operationRef(step, index),
      dependsOn: step.dependencies.map((dependency) => ids.get(dependency)).filter((dependency): dependency is string => dependency !== undefined),
      inputBindings: {},
      requiredEvidenceKinds,
      producedEvidenceKinds: requiredEvidenceKinds,
      requiredCapabilities: [],
      skillRoleHints: selectedSkillRoleHints(step),
    };
  });
}

function dependencyPositions(steps: readonly PlanStepProposal[], step: PlanStepProposal): readonly number[] {
  const indexById = new Map(steps.map((item, index) => [item.id, index]));
  return step.dependencies
    .map((dependency) => indexById.get(dependency))
    .filter((index): index is number => index !== undefined);
}

function operationRef(step: PlanStepProposal, index: number): string {
  const role = step.role === "fact_acquisition" || step.role === "repair" ? step.role : "produce";
  const skill = step.skillIds[0];
  if (skill !== undefined) return `${role}:${skill}`;
  const tool = step.recommendedToolNames[0];
  if (tool !== undefined) return `${role}:${tool}`;
  return `${role}:step_${index + 1}`;
}

function normalizedRole(proposal: PlanProposal, step: PlanStepProposal): string {
  const role = step.role ?? "produce";
  if (proposal.steps.length === 1 && (role === "produce" || role === "deliver")) return "produce";
  return role;
}

function selectedSkillRoleHints(step: PlanStepProposal): readonly string[] {
  if (step.skillIds.length === 0) return [];
  if (step.role === "fact_acquisition") return ["source_provider"];
  if (step.role === "produce") return ["primary_builder", "source_provider"];
  if (step.role === "deliver") return ["primary_builder"];
  return [];
}

function evidenceKindsFromProposal(proposal: PlanProposal): readonly EvidenceKind[] {
  return unique(proposal.steps.flatMap((step) => step.evidenceContract?.requiredKinds ?? [])) as readonly EvidenceKind[];
}

function exampleForTemplate(
  templateId: string,
  example: EligibleExample,
  now: () => Date,
): PlanTemplateExample {
  return {
    id: `${templateId}:${example.match.runId}:positive`,
    templateId,
    runId: example.match.runId,
    exampleType: "positive",
    taskTextHash: hashJson(example.match.taskFingerprint),
    taskFingerprint: example.match.taskFingerprint,
    outcomeStatus: example.match.outcomeStatus ?? "completed",
    evidenceSummary: {
      planShape: example.proposal.shape ?? inferShape(example.proposal),
      stepCount: example.proposal.steps.length,
      requiredEvidenceKinds: evidenceKindsFromProposal(example.proposal),
    },
    createdAt: now().toISOString(),
  };
}

function inferShape(proposal: PlanProposal): PlanProposal["shape"] {
  if (proposal.steps.length === 1) return "single_leaf";
  if (proposal.steps.some((step) => step.role === "fact_acquisition")) return "fact_then_produce";
  return "pipeline";
}

function maxRisk(values: readonly PlanTemplateRiskLevel[]): PlanTemplateRiskLevel {
  if (values.includes("high")) return "high";
  if (values.includes("medium")) return "medium";
  return "low";
}

function riskRank(value: PlanTemplateRiskLevel): number {
  if (value === "low") return 0;
  if (value === "medium") return 1;
  return 2;
}

function unique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
