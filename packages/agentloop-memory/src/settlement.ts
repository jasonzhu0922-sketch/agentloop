import { createHash } from "node:crypto";
import type {
  ExperienceFailureLesson,
  ExperienceLearningValue,
  ExperienceKeyStep,
  ExperiencePreferenceSignal,
  ExperienceReusableKnowledge,
  ExperienceSettlementPattern,
  ExperienceToolUsage,
  MemoryCandidate,
  MemorySettlementEvidence,
  MemorySettlementJob,
  MemorySettlementModel,
  MemoryRevision,
  MemoryScope,
  MemoryStore,
} from "./types.ts";
import { searchTaskGroupCandidates, taskGroupPatternFromRevision } from "./task-group.ts";
import { SETTLEMENT_V2, SettlementV2Error, settleV2, settleV2Batch } from "./semantic-v2.ts";

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, nested) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  })).digest("hex");
}

function boundedText(value: string, max = 600): string {
  const compact = value.trim().replace(/\s+/gu, " ");
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function sourceRefsForEvidence(evidence: MemorySettlementEvidence) {
  // Settlement never copies raw assistant/user text into Memory. These refs
  // point back to canonical Run/Outcome records which remain the authority.
  return [
    { type: "run" as const, runId: evidence.runId, sourceHash: stableHash(evidence.taskFingerprint) },
    { type: "outcome" as const, runId: evidence.runId, sourceHash: evidence.terminalCommitRef },
  ];
}

function taskGroupKey(evidence: MemorySettlementEvidence): string {
  return stableHash({
    taskKind: evidence.taskFingerprint.taskKind ?? null,
    domain: evidence.taskFingerprint.domain ?? null,
    artifactKind: evidence.taskFingerprint.artifactKind ?? null,
    sourceKind: evidence.taskFingerprint.sourceKind ?? null,
  }).slice(0, 24);
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function stringArrayField(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  return Array.isArray(value[key]) ? value[key].filter((item): item is string => typeof item === "string").slice(0, 12) : [];
}

function uniqueSourceRefs(refs: readonly MemorySettlementEvidence["sourceRefs"][number][]): readonly MemorySettlementEvidence["sourceRefs"][number][] {
  return [...new Map(refs.map((ref) => [stableHash(ref), ref] as const)).values()];
}

function entriesWithinAllowedRuns(
  entries: readonly Awaited<ReturnType<MemoryStore["active"]>>[number][],
  allowedRunIds: readonly string[],
): readonly Awaited<ReturnType<MemoryStore["active"]>>[number][] {
  const allowedRuns = new Set(allowedRunIds);
  const allowedEpisodeRevisionIds = new Set(entries.filter(({ item, revision }) =>
    item.subtype === "experience.episode" && onlyReferencesAllowedRuns(revision.sourceRefs, allowedRuns),
  ).map(({ revision }) => revision.id));
  return entries.filter(({ item, revision }) => {
    if (!onlyReferencesAllowedRuns(revision.sourceRefs, allowedRuns)) return false;
    if (item.subtype !== "experience.procedure") return true;
    const episodeIds = [
      ...stringArrayField(revision.value, "supportingEpisodeRevisionIds"),
      ...stringArrayField(revision.value, "successfulEpisodeRevisionIds"),
    ];
    return episodeIds.length > 0 && episodeIds.every((id) => allowedEpisodeRevisionIds.has(id));
  });
}

function onlyReferencesAllowedRuns(refs: readonly MemorySettlementEvidence["sourceRefs"][number][], allowedRuns: ReadonlySet<string>): boolean {
  const runIds = refs.filter((ref) => ref.type === "run").map((ref) => ref.runId).filter((id): id is string => typeof id === "string");
  return runIds.length > 0 && runIds.every((id) => allowedRuns.has(id));
}

function applicabilityConditions(fingerprint: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.entries(fingerprint)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `${key}=${value as string}`)
    .slice(0, 12);
}

function keyStepsForEvidence(evidence: MemorySettlementEvidence): readonly ExperienceKeyStep[] {
  if (evidence.keySteps !== undefined && evidence.keySteps.length > 0) return evidence.keySteps.slice(0, 24);
  const skeleton = evidence.planSkeleton ?? [];
  if (skeleton.length > 0) {
    return skeleton.slice(0, 24).map((step, index) => ({
      order: index + 1,
      objective: boundedText(stringField(step, "objective") ?? stringField(step, "role") ?? `执行步骤 ${index + 1}`, 300),
      ...(stringField(step, "role") === undefined ? {} : { role: boundedText(stringField(step, "role")!, 120) }),
      ...(stringArrayField(step, "toolNames").length === 0 ? {} : { toolNames: stringArrayField(step, "toolNames") }),
      ...(stringArrayField(step, "skillIds").length === 0 ? {} : { skillIds: stringArrayField(step, "skillIds") }),
      ...(stringArrayField(step, "requiredCapabilities").length === 0 ? {} : { capabilityIds: stringArrayField(step, "requiredCapabilities") }),
      requiredEvidenceKinds: stringArrayField(step, "requiredEvidenceKinds"),
      producedEvidenceKinds: stringArrayField(step, "producedEvidenceKinds"),
      ...(stringArrayField(step, "successCriteria").length === 0 ? {} : { successCriteria: stringArrayField(step, "successCriteria") }),
      ...(stringArrayField(step, "cautions").length === 0 ? {} : { cautions: stringArrayField(step, "cautions") }),
    }));
  }
  return (evidence.keyDecisions ?? []).slice(0, 12).map((decision, index) => ({
    order: index + 1,
    objective: boundedText(decision, 300),
    requiredEvidenceKinds: [],
    producedEvidenceKinds: [],
  }));
}

function toolUsageForEvidence(evidence: MemorySettlementEvidence, refs: readonly MemorySettlementEvidence["sourceRefs"][number][]): readonly ExperienceToolUsage[] {
  if (evidence.toolUsage !== undefined && evidence.toolUsage.length > 0) return evidence.toolUsage.slice(0, 24);
  const byTool = new Map<string, { purpose?: string; stepOrders: number[] }>();
  for (const [index, step] of (evidence.planSkeleton ?? []).entries()) {
    const order = index + 1;
    for (const toolName of stringArrayField(step, "toolNames")) {
      const existing = byTool.get(toolName) ?? { stepOrders: [] };
      if (!existing.stepOrders.includes(order)) existing.stepOrders.push(order);
      if (existing.purpose === undefined && stringField(step, "objective") !== undefined) existing.purpose = boundedText(stringField(step, "objective")!, 240);
      byTool.set(toolName, existing);
    }
  }
  return [...byTool.entries()].slice(0, 24).map(([toolName, value]) => ({ toolName, ...(value.purpose === undefined ? {} : { purpose: value.purpose }), stepOrders: value.stepOrders, sourceRefs: refs }));
}

function cautionsForEvidence(evidence: MemorySettlementEvidence): readonly string[] {
  const fromSteps = (evidence.planSkeleton ?? []).flatMap((step) => stringArrayField(step, "cautions"));
  return [...new Set([...(evidence.cautions ?? []), ...fromSteps].map((value) => boundedText(value, 300)).filter(Boolean))].slice(0, 24);
}

function reusableKnowledgeForEvidence(evidence: MemorySettlementEvidence, refs: readonly MemorySettlementEvidence["sourceRefs"][number][]): readonly ExperienceReusableKnowledge[] {
  const explicit = (evidence.reusableKnowledge ?? []).slice(0, 12).map((knowledge) => ({
    rule: boundedText(knowledge.rule, 400),
    conditions: [...(knowledge.conditions ?? [])].slice(0, 8),
    exclusions: [...(knowledge.exclusions ?? [])].slice(0, 8),
    ...(typeof knowledge.trigger === "string" ? { trigger: boundedText(knowledge.trigger, 300) } : {}),
    ...(typeof knowledge.decision === "string" ? { decision: boundedText(knowledge.decision, 300) } : {}),
    ...(typeof knowledge.rationale === "string" ? { rationale: boundedText(knowledge.rationale, 300) } : {}),
    ...(typeof knowledge.action === "string" ? { action: boundedText(knowledge.action, 300) } : {}),
    ...(knowledge.expectedEvidence === undefined ? {} : { expectedEvidence: knowledge.expectedEvidence.slice(0, 8) }),
    sourceRefs: refs,
  }));
  const derived = [
    ...(evidence.successfulRecoveries ?? []).slice(0, 8).map((recovery) => ({ rule: boundedText(recovery, 400), conditions: ["发生同类恢复场景"], exclusions: [] })),
  ];
  const all = [...explicit, ...derived];
  return [...new Map(all.map((item) => [item.rule, { ...item, sourceRefs: refs }] as const)).values()].slice(0, 16);
}

function failureLessonsForEvidence(evidence: MemorySettlementEvidence, refs: readonly MemorySettlementEvidence["sourceRefs"][number][]): readonly ExperienceFailureLesson[] {
  const remediations = new Map((evidence.failureRemediations ?? []).map((item) => [item.lesson, item.doDifferently]));
  return (evidence.failureLessons ?? []).slice(0, 12).map((lesson) => ({
    lesson: boundedText(lesson, 400),
    ...(remediations.get(lesson) === undefined ? {} : { doDifferently: boundedText(remediations.get(lesson)!, 400) }),
    ...(() => {
      const remediation = (evidence.failureRemediations ?? []).find((item) => item.lesson === lesson);
      return remediation === undefined ? {} : {
        ...(typeof remediation.trigger === "string" ? { trigger: boundedText(remediation.trigger, 300) } : {}),
        ...(typeof remediation.symptom === "string" ? { symptom: boundedText(remediation.symptom, 300) } : {}),
        ...(typeof remediation.rootCause === "string" ? { rootCause: boundedText(remediation.rootCause, 300) } : {}),
        ...(remediation.causeStatus === undefined ? {} : { causeStatus: remediation.causeStatus }),
        ...(typeof remediation.nextAction === "string" ? { nextAction: boundedText(remediation.nextAction, 300) } : {}),
        ...(typeof remediation.verification === "string" ? { verification: boundedText(remediation.verification, 300) } : {}),
        ...(remediation.applicability === undefined ? {} : { applicability: remediation.applicability.slice(0, 8) }),
        ...(remediation.exclusions === undefined ? {} : { exclusions: remediation.exclusions.slice(0, 8) }),
      };
    })(),
    sourceRefs: refs,
  }));
}

function hasActionableKnowledge(pattern: ExperienceSettlementPattern): boolean {
  return pattern.reusableKnowledge.some((item) =>
    [item.trigger, item.decision, item.rationale, item.action].every((value) => typeof value === "string" && value.trim().length > 0)
    && (item.expectedEvidence?.length ?? 0) > 0
    && item.conditions.length > 0,
  );
}

function hasActionableFailureLesson(pattern: ExperienceSettlementPattern): boolean {
  return pattern.failureLessons.some((item) =>
    item.causeStatus === "confirmed"
    && typeof item.trigger === "string" && item.trigger.trim().length > 0
    && typeof item.symptom === "string" && item.symptom.trim().length > 0
    && typeof item.rootCause === "string" && item.rootCause.trim().length > 0
    && typeof item.nextAction === "string" && item.nextAction.trim().length > 0
    && typeof item.verification === "string" && item.verification.trim().length > 0
    && (item.applicability?.length ?? 0) > 0,
  );
}

function learningValueForPattern(pattern: ExperienceSettlementPattern): ExperienceLearningValue {
  if (hasActionableKnowledge(pattern) || hasActionableFailureLesson(pattern)) {
    return {
      status: "actionable",
      novelty: "new",
      transferability: "task_family",
      actionChange: "按触发条件执行明确动作，并检查预期证据",
      verification: "以记录的预期证据确认动作有效",
    };
  }
  return { status: "insufficient", novelty: "none", transferability: "unknown" };
}

/** Build the stable, sectioned experience shape before it becomes a Memory candidate. */
export function experienceSettlementPatternFromEvidence(evidence: MemorySettlementEvidence): ExperienceSettlementPattern {
  const canonicalRefs = uniqueSourceRefs([
    ...evidence.sourceRefs,
    ...sourceRefsForEvidence(evidence),
  ]);
  const isVerifiedSuccess = evidence.terminalStatus === "completed"
    && evidence.quality.terminalCommitted
    && evidence.quality.assessmentApproved
    && evidence.quality.laterCorrected === false
    && evidence.quality.laterDisputed === false;
  const outcome = isVerifiedSuccess ? "verified_success" as const : "failure" as const;
  const keySteps = keyStepsForEvidence(evidence);
  const pattern: ExperienceSettlementPattern = {
    schema: "agentloop.experienceSettlement/v1",
    phase: "episode",
    outcome,
    outcomeReason: isVerifiedSuccess ? "canonical_outcome_assessment_and_delivery_verified" : "canonical_failure_lesson_or_unverified_outcome",
    applicability: {
      taskFingerprint: { ...evidence.taskFingerprint },
      conditions: applicabilityConditions(evidence.taskFingerprint),
      exclusions: evidence.quality.laterCorrected || evidence.quality.laterDisputed ? ["已被后续纠正或争议的结果"] : [],
    },
    preferenceSignals: [...(evidence.preferenceSignals ?? [])].slice(0, 12),
    classicPath: keySteps,
    keySteps,
    toolUsage: toolUsageForEvidence(evidence, canonicalRefs),
    cautions: cautionsForEvidence(evidence),
    reusableKnowledge: reusableKnowledgeForEvidence(evidence, canonicalRefs),
    failureLessons: failureLessonsForEvidence(evidence, canonicalRefs),
    learningValue: { status: "insufficient", novelty: "none", transferability: "unknown" },
    verification: { ...evidence.quality },
    references: canonicalRefs,
  };
  return { ...pattern, learningValue: learningValueForPattern(pattern) };
}

function renderSettlementMarkdown(pattern: ExperienceSettlementPattern): string {
  const taskGroup = [
    pattern.title === undefined ? undefined : `# Task Group: ${pattern.title}`,
    pattern.goalSummary === undefined ? undefined : `scope: ${pattern.goalSummary}`,
    pattern.applicability.conditions.length === 0 ? undefined : `applies_to: ${pattern.applicability.conditions.join(", ")}`,
    pattern.reuseRule === undefined ? undefined : `reuse_rule: ${pattern.reuseRule}`,
    pattern.keywords === undefined || pattern.keywords.length === 0 ? undefined : `keywords: ${pattern.keywords.join(", ")}`,
    pattern.conflicts === undefined || pattern.conflicts.length === 0 ? undefined : `conflicts:\n${pattern.conflicts.map((item) => `- ${item}`).join("\n")}`,
    pattern.generalizationWarnings === undefined || pattern.generalizationWarnings.length === 0 ? undefined : `泛化边界：\n${pattern.generalizationWarnings.map((item) => `- ${item}`).join("\n")}`,
  ].filter((section): section is string => section !== undefined);
  const sections = [
    ...taskGroup,
    `结果：${pattern.outcome}`,
    pattern.classicPath.length === 0 ? undefined : `经典路径：\n${pattern.classicPath.map((step) => `${step.order}. ${step.objective}`).join("\n")}`,
    pattern.toolUsage.length === 0 ? undefined : `工具建议：\n${pattern.toolUsage.map((item) => `- ${item.toolName}${item.purpose === undefined ? "" : `：${item.purpose}`}`).join("\n")}`,
    pattern.cautions.length === 0 ? undefined : `注意事项：\n${pattern.cautions.map((item) => `- ${item}`).join("\n")}`,
    pattern.reusableKnowledge.length === 0 ? undefined : `可复用知识：\n${pattern.reusableKnowledge.map((item) => `- ${item.rule}`).join("\n")}`,
    pattern.failureLessons.length === 0 ? undefined : `失败及改进：\n${pattern.failureLessons.map((item) => `- ${item.lesson}${item.doDifferently === undefined ? "" : `；下次：${item.doDifferently}`}`).join("\n")}`,
    pattern.recheckRules === undefined || pattern.recheckRules.length === 0 ? undefined : `复查规则：\n${pattern.recheckRules.map((item) => `- ${item}`).join("\n")}`,
    pattern.preferenceSignals.length === 0 ? undefined : `用户偏好信号：\n${pattern.preferenceSignals.map((item) => `- ${item.signal}`).join("\n")}`,
    `验证：terminal=${pattern.verification.terminalCommitted}, assessment=${pattern.verification.assessmentApproved}, artifact=${pattern.verification.artifactVerified ?? false}`,
  ].filter((section): section is string => section !== undefined);
  return sections.join("\n");
}

/** Render the current Task Group revision in the Codex-compatible human-readable shape. */
export function renderTaskGroupMarkdown(pattern: ExperienceSettlementPattern): string {
  if (pattern.phase !== "procedure") return "";
  return renderSettlementMarkdown(pattern);
}

/**
 * Convert canonical outcome evidence into one episode candidate. A completed
 * Run without an approved Assessment is retained only when canonical evidence
 * supplies an explicit failure lesson; it can never become a success episode.
 */
export function experienceCandidateFromEvidence(
  evidence: MemorySettlementEvidence,
): MemoryCandidate | undefined {
  if (!evidence.quality.terminalCommitted) return undefined;
  const isCompleted = evidence.terminalStatus === "completed";
  const isFailed = evidence.terminalStatus === "failed";
  if (!isCompleted && !isFailed) return undefined;
  const hasFailureLesson = (evidence.failureLessons?.length ?? 0) > 0;
  if (evidence.quality.laterCorrected || evidence.quality.laterDisputed) return undefined;
  if (isCompleted && !evidence.quality.assessmentApproved && !hasFailureLesson) return undefined;
  if (isFailed && !hasFailureLesson) return undefined;

  const settlementPattern = experienceSettlementPatternFromEvidence(evidence);
  const value = {
    taskFingerprint: { ...evidence.taskFingerprint },
    taskGroupKey: taskGroupKey(evidence),
    terminalStatus: evidence.terminalStatus,
    keyDecisions: [...(evidence.keyDecisions ?? [])].slice(0, 5),
    successfulRecoveries: [...(evidence.successfulRecoveries ?? [])].slice(0, 5),
    failureLessons: [...(evidence.failureLessons ?? [])].slice(0, 5),
    quality: { ...evidence.quality },
    settlementPattern,
  } satisfies Record<string, unknown>;
  return {
    schema: "agentloop.userMemoryCandidate/v1",
    id: `memcand_episode_${stableHash({ tenantId: evidence.scope.tenantId, ownerUserId: evidence.scope.ownerUserId, runId: evidence.runId, terminalCommitRef: evidence.terminalCommitRef }).slice(0, 24)}`,
    tenantId: evidence.scope.tenantId,
    ownerUserId: evidence.scope.ownerUserId,
    proposedKind: "experience",
    proposedSubtype: "experience.episode",
    proposedCanonicalKey: `experience.episode:${evidence.runId}:${evidence.terminalCommitRef}`,
    proposedValue: value,
    proposedContentMarkdown: renderSettlementMarkdown(settlementPattern),
    persistenceIntent: "future_oriented",
    authority: "verified_run",
    sensitivity: "normal",
    proposedExperienceMaturity: "episode",
    activation: { mode: "task_match", taskKinds: typeof evidence.taskFingerprint.taskKind === "string" ? [evidence.taskFingerprint.taskKind] : undefined, domains: typeof evidence.taskFingerprint.domain === "string" ? [evidence.taskFingerprint.domain] : undefined },
    applicationTargets: ["planner"],
    sourceRefs: sourceRefsForEvidence(evidence),
    confidence: isCompleted ? Math.max(0, Math.min(1, evidence.quality.evidenceCoverage ?? 0.8)) : 0.55,
    reason: settlementPattern.outcome === "verified_success" ? "canonical_outcome_and_assessment_verified" : "canonical_outcome_lesson",
    decision: "pending",
  };
}

export interface MemorySettlementWorkerOptions {
  readonly store: MemoryStore;
  readonly reader: MemorySettlementReaderLike;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  /** Run planner-only procedure consolidation after a successful episode settlement. */
  readonly consolidate?: boolean;
  /** Optional local model used only for semantic generalization. */
  readonly settlementModel?: MemorySettlementModel;
  /** Local Agent enables this. Without it, semantic settlement cannot fall back. */
  readonly requireSettlementModel?: boolean;
  readonly settlementPromptSchemaVersion?: string;
  /** Optional explicit scope for operator-authorized historical replay. */
  readonly allowedRunIds?: readonly string[];
  /** Optional exact outbox jobs for bounded replay or diagnostics. */
  readonly allowedSettlementJobIds?: readonly string[];
  /** Number of experience cases required before one semantic batch call. */
  readonly experienceBatchSize?: number;
}

export interface MemorySettlementReaderLike {
  read(input: { readonly tenantId: string; readonly ownerUserId: string; readonly runId: string; readonly terminalCommitRef: string }): Promise<MemorySettlementEvidence | undefined>;
}

export interface MemorySettlementRunResult {
  readonly status: "succeeded" | "retrying" | "dead_letter" | "empty";
  readonly settlementJobId?: string;
  readonly episodeRevisionId?: string;
  readonly reason?: string;
}

/** Claims and settles one durable job. It is safe to call from a local timer. */
export class MemorySettlementWorker {
  private readonly store: MemoryStore;
  private readonly reader: MemorySettlementReaderLike;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly shouldConsolidate: boolean;
  private readonly settlementModel?: MemorySettlementModel;
  private readonly requireSettlementModel: boolean;
  private readonly settlementPromptSchemaVersion: string;
  private readonly allowedRunIds?: readonly string[];
  private readonly allowedSettlementJobIds?: readonly string[];
  private readonly experienceBatchSize: number;

  constructor(options: MemorySettlementWorkerOptions) {
    this.store = options.store;
    this.reader = options.reader;
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.shouldConsolidate = options.consolidate === true;
    this.settlementModel = options.settlementModel;
    this.requireSettlementModel = options.requireSettlementModel === true;
    this.settlementPromptSchemaVersion = options.settlementPromptSchemaVersion ?? SETTLEMENT_V2;
    this.allowedRunIds = options.allowedRunIds === undefined ? undefined : [...new Set(options.allowedRunIds)];
    this.allowedSettlementJobIds = options.allowedSettlementJobIds === undefined ? undefined : [...new Set(options.allowedSettlementJobIds)];
    this.experienceBatchSize = Math.max(1, Math.floor(options.experienceBatchSize ?? 1));
  }

  async runOnce(): Promise<MemorySettlementRunResult> {
    if (this.settlementPromptSchemaVersion === SETTLEMENT_V2 && this.experienceBatchSize > 1) return this.runBatchOnce();
    const job = await this.store.claimSettlement({
      now: this.now(), maxAttempts: this.maxAttempts,
      allowedRunIds: this.allowedRunIds,
      allowedSettlementJobIds: this.allowedSettlementJobIds,
    });
    if (job === undefined) return { status: "empty" };
    try {
      const evidence = await this.reader.read({
        tenantId: job.tenantId,
        ownerUserId: job.ownerUserId,
        runId: job.runId,
        terminalCommitRef: job.terminalCommitRef,
      });
      if (evidence === undefined) throw new Error("settlement_evidence_not_available");
      assertJobEvidenceScope(job, evidence);
      if (this.settlementPromptSchemaVersion === SETTLEMENT_V2 && this.settlementModel !== undefined) {
        const result = await settleV2({ store: this.store, job, model: this.settlementModel, evidence,
          consolidate: this.shouldConsolidate, now: this.now(), allowedRunIds: this.allowedRunIds });
        await this.store.finishSettlement({ job, now: this.now(), maxAttempts: this.maxAttempts, outcome: "succeeded" });
        return { status: "succeeded", settlementJobId: job.settlementJobId, ...result };
      }
      if (this.settlementPromptSchemaVersion === SETTLEMENT_V2 && this.requireSettlementModel) throw new Error("settlement_model_required");
      const candidate = experienceCandidateFromEvidence(evidence);
      if (candidate === undefined) {
        const finished = await this.store.finishSettlement({ job, now: this.now(), maxAttempts: this.maxAttempts, outcome: "succeeded" });
        return { status: finished.status === "dead_letter" ? "dead_letter" : "succeeded", settlementJobId: job.settlementJobId, reason: "evidence_not_eligible_for_episode" };
      }
      const active = await this.store.active(evidence.scope);
      const scopedActive = this.allowedRunIds === undefined ? active : entriesWithinAllowedRuns(active, this.allowedRunIds);
      const existing = active.find(({ item, revision }) =>
        item.kind === "experience" && item.subtype === "experience.episode"
        && (item.canonicalKey === candidate.proposedCanonicalKey
          || revision.sourceRefs.some((ref) => ref.type === "outcome" && ref.runId === job.runId && ref.sourceHash === job.terminalCommitRef)),
      );
      // Always preserve one deterministic episode for audit. Semantic
      // settlement is a separate gate and may fail the durable job.
      const baseCommitted = existing === undefined
        ? await this.store.commit(evidence.scope, { ...candidate, decision: "accepted" }, this.now())
        : undefined;
      const semantic = await this.semanticSettlement(evidence, candidate, scopedActive);
      const settledCandidate = semantic === undefined ? undefined : {
        ...candidate,
        proposedValue: {
          ...candidate.proposedValue,
          settlementPattern: semantic.pattern,
          semanticSettlement: semantic.metadata,
          ...(semantic.metadata.modelKey === undefined ? {} : { settlementModelKey: semantic.metadata.modelKey }),
          ...(semantic.metadata.promptSchemaVersion === undefined ? {} : { settlementPromptSchemaVersion: semantic.metadata.promptSchemaVersion }),
          ...(semantic.metadata.outputHash === undefined ? {} : { settlementOutputHash: semantic.metadata.outputHash }),
          ...(semantic.metadata.validationResult === undefined ? {} : { settlementValidationResult: semantic.metadata.validationResult }),
        },
        proposedContentMarkdown: renderSettlementMarkdown(semantic.pattern),
      };
      const semanticCommitted = settledCandidate === undefined
        ? undefined
        : await this.store.commit(evidence.scope, { ...settledCandidate, decision: "accepted" }, this.now());
      if (this.shouldConsolidate) {
        await consolidateProcedures(this.store, evidence.scope, this.now(), semantic?.metadata, this.settlementModel, this.requireSettlementModel, this.allowedRunIds);
      }
      const finished = await this.store.finishSettlement({ job, now: this.now(), maxAttempts: this.maxAttempts, outcome: "succeeded" });
      return {
        status: finished.status === "dead_letter" ? "dead_letter" : "succeeded",
        settlementJobId: job.settlementJobId,
        ...(semanticCommitted?.revision.id === undefined
          ? baseCommitted?.revision.id === undefined ? {} : { episodeRevisionId: baseCommitted.revision.id }
          : { episodeRevisionId: semanticCommitted.revision.id }),
        reason: baseCommitted === undefined ? "episode_already_exists" : "episode_committed",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finished = await this.store.finishSettlement({ job, now: this.now(), maxAttempts: error instanceof SettlementV2Error && !error.transient ? job.attempts : this.maxAttempts, outcome: "failed", error: message });
      return { status: finished.status === "dead_letter" ? "dead_letter" : "retrying", settlementJobId: job.settlementJobId, reason: message };
    }
  }

  private async runBatchOnce(): Promise<MemorySettlementRunResult> {
    const candidates = await this.store.settlementBatchCandidates({ minimum: this.experienceBatchSize, maxAttempts: this.maxAttempts });
    const candidate = candidates[0];
    if (candidate === undefined) return { status: "empty", reason: "waiting_for_experience_batch" };
    const jobs = await this.store.claimSettlementBatch({
      scope: candidate.scope, now: this.now(), maxAttempts: this.maxAttempts, limit: this.experienceBatchSize,
      ...(this.allowedRunIds === undefined ? {} : { allowedRunIds: this.allowedRunIds }),
      ...(this.allowedSettlementJobIds === undefined ? {} : { allowedSettlementJobIds: this.allowedSettlementJobIds }),
    });
    if (jobs.length < this.experienceBatchSize) return { status: "empty", reason: "waiting_for_experience_batch" };
    try {
      const evidences: MemorySettlementEvidence[] = [];
      for (const job of jobs) {
        const evidence = await this.reader.read({ tenantId: job.tenantId, ownerUserId: job.ownerUserId, runId: job.runId, terminalCommitRef: job.terminalCommitRef });
        if (evidence === undefined) throw new Error(`settlement_evidence_not_available:${job.runId}`);
        assertJobEvidenceScope(job, evidence);
        evidences.push(evidence);
      }
      if (this.settlementModel === undefined) throw new Error("settlement_model_required");
      const result = await settleV2Batch({ store: this.store, jobs, model: this.settlementModel, evidences, consolidate: this.shouldConsolidate, now: this.now() });
      for (const job of jobs) await this.store.finishSettlement({ job, now: this.now(), maxAttempts: this.maxAttempts, outcome: "succeeded" });
      return { status: "succeeded", settlementJobId: jobs[0]!.settlementJobId, episodeRevisionId: result.episodeRevisionIds[0], reason: result.reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const job of jobs) await this.store.finishSettlement({ job, now: this.now(), maxAttempts: error instanceof SettlementV2Error && !error.transient ? job.attempts : this.maxAttempts, outcome: "failed", error: message });
      return { status: jobs.some((job) => job.attempts >= this.maxAttempts) ? "dead_letter" : "retrying", settlementJobId: jobs[0]!.settlementJobId, reason: message };
    }
  }

  private async semanticSettlement(
    evidence: MemorySettlementEvidence,
    candidate: MemoryCandidate,
    active: readonly Awaited<ReturnType<MemoryStore["active"]>>[number][],
  ): Promise<{ readonly pattern: ExperienceSettlementPattern; readonly metadata: Readonly<Record<string, unknown>> } | undefined> {
    if (this.settlementModel === undefined) {
      if (this.requireSettlementModel) throw new Error("settlement_model_required");
      return undefined;
    }
    const base = candidate.proposedValue.settlementPattern;
    if (base === null || typeof base !== "object" || Array.isArray(base)) return undefined;
    const pattern = base as ExperienceSettlementPattern;
    const similarEpisodeEntries = active
      .filter(({ item, revision }) => item.kind === "experience" && item.subtype === "experience.episode" && revision.id !== candidate.id)
      .map((entry) => ({ ...entry, pattern: entry.revision.value.settlementPattern }))
      .filter((entry): entry is typeof entry & { readonly pattern: ExperienceSettlementPattern } => entry.pattern !== null && typeof entry.pattern === "object" && !Array.isArray(entry.pattern) && (entry.pattern as Record<string, unknown>).schema === "agentloop.experienceSettlement/v1")
      .filter((entry) => fingerprintSimilarity(pattern.applicability.taskFingerprint, entry.pattern.applicability.taskFingerprint) > 0)
      .slice(0, 8);
    const similarEpisodes = similarEpisodeEntries.map(({ pattern: similarPattern }) => similarPattern);
    const taskGroupCandidates = await searchTaskGroupCandidates(this.store, evidence.scope, {
      taskFingerprint: pattern.applicability.taskFingerprint,
      query: [evidence.strategy ?? "", ...(evidence.keyDecisions ?? [])],
      limit: 4,
    });
    const scopedRevisionIds = new Set(active.map(({ revision }) => revision.id));
    const scopedTaskGroupCandidates = taskGroupCandidates.filter(({ revision }) => scopedRevisionIds.has(revision.id));
    const similarTaskGroups = scopedTaskGroupCandidates
      .map(({ revision }) => taskGroupPatternFromRevision(revision))
      .filter((candidate): candidate is ExperienceSettlementPattern => candidate !== undefined);
    const input = semanticSettlementInput(evidence, pattern, similarEpisodes, similarTaskGroups);
    let raw: string;
    try {
      raw = (await this.settlementModel.complete({
        runId: evidence.runId,
        systemPrompt: semanticSettlementSystemPrompt(),
        input,
      })).content;
    } catch {
      if (this.requireSettlementModel) throw new Error("semantic_model_unavailable");
      return { pattern, metadata: { modelKey: this.settlementModel.modelKey, promptSchemaVersion: this.settlementPromptSchemaVersion, status: "fallback_model_unavailable", validationResult: "not_run" } };
    }
    const parsed = parseSemanticSettlement(raw);
    const validation = parsed.output === undefined
      ? { reason: parsed.reason }
      : validateSemanticSettlement(parsed.output, pattern);
    if (validation.output === undefined) {
      if (this.requireSettlementModel) throw new Error(`semantic_model_invalid_output:${validation.reason}`);
      return { pattern, metadata: { modelKey: this.settlementModel.modelKey, promptSchemaVersion: this.settlementPromptSchemaVersion, outputHash: stableHash(raw), status: "fallback_invalid_output", validationResult: "rejected" } };
    }
    const validated = validation.output;
    const merged = mergeSemanticPattern(pattern, validated);
    if (merged.learningValue?.status === "actionable" && !hasActionableKnowledge(merged) && !hasActionableFailureLesson(merged)) {
      if (this.requireSettlementModel) throw new Error("semantic_model_missing_actionable_knowledge");
      return { pattern, metadata: { modelKey: this.settlementModel.modelKey, promptSchemaVersion: this.settlementPromptSchemaVersion, outputHash: stableHash(validated), status: "fallback_missing_actionable_knowledge", validationResult: "rejected" } };
    }
    return { pattern: merged, metadata: {
      modelKey: this.settlementModel.modelKey,
      promptSchemaVersion: this.settlementPromptSchemaVersion,
      inputEpisodeRevisionIds: similarEpisodeEntries.map(({ revision }) => revision.id),
      outputHash: stableHash(validated),
      status: "accepted",
      validationResult: "accepted",
      inputTaskGroupRevisionIds: taskGroupCandidates.map(({ revision }) => revision.id),
    } };
  }
}

const SEMANTIC_SETTLEMENT_SCHEMA = "agentloop.semanticSettlement/v1" as const;

function modelSafeStep(step: ExperienceKeyStep): Readonly<Record<string, unknown>> {
  return {
    order: step.order,
    objective: step.role === "fact_acquisition"
      ? "Collect authoritative source facts through the bound capability; retain source, scope, and limitations."
      : step.role === "deliver"
        ? "Synthesize verified facts into the requested user-facing output; distinguish unsupported details."
        : step.role === "produce"
          ? "Produce the requested output from verified inputs and preserve its acceptance evidence."
          : step.role === "repair"
            ? "Repair the identified execution boundary and verify the relevant evidence."
            : "Complete the step using admitted capabilities and evidence contracts.",
    ...(step.role === undefined ? {} : { role: step.role }),
    ...(step.toolNames === undefined ? {} : { toolNames: step.toolNames }),
    ...(step.skillIds === undefined ? {} : { skillIds: step.skillIds }),
    ...(step.capabilityIds === undefined ? {} : { capabilityIds: step.capabilityIds }),
    requiredEvidenceKinds: step.requiredEvidenceKinds,
    producedEvidenceKinds: step.producedEvidenceKinds,
  };
}

function modelSafePattern(item: ExperienceSettlementPattern): Readonly<Record<string, unknown>> {
  return {
    outcome: item.outcome,
    classicPath: item.classicPath.map(modelSafeStep),
    toolUsage: item.toolUsage.map(({ toolName, stepOrders }) => ({ toolName, stepOrders })),
    verification: item.verification,
  };
}

function modelSafeFailureLesson(item: ExperienceFailureLesson): Readonly<Record<string, unknown>> {
  return {
    causeStatus: item.causeStatus ?? "unknown",
    hasTrigger: typeof item.trigger === "string" && item.trigger.length > 0,
    hasSymptom: typeof item.symptom === "string" && item.symptom.length > 0,
    hasRootCause: typeof item.rootCause === "string" && item.rootCause.length > 0,
    hasNextAction: typeof item.nextAction === "string" && item.nextAction.length > 0,
    hasVerification: typeof item.verification === "string" && item.verification.length > 0,
    applicabilityCount: item.applicability?.length ?? 0,
  };
}

interface SemanticSettlementOutput {
  readonly schema: typeof SEMANTIC_SETTLEMENT_SCHEMA;
  readonly sameGoalFamily?: boolean;
  readonly title?: string;
  readonly goalSummary?: string;
  readonly keywords?: readonly string[];
  readonly reuseRule?: string;
  readonly recheckRules?: readonly string[];
  readonly learningValue?: Readonly<{
    readonly status: "actionable" | "insufficient" | "unknown";
    readonly novelty: "new" | "reinforcement" | "none";
    readonly transferability: "task_family" | "run_specific" | "unknown";
    readonly actionChange?: string;
    readonly verification?: string;
  }>;
  readonly classicPath?: readonly Readonly<Record<string, unknown>>[];
  readonly toolUsage?: readonly Readonly<Record<string, unknown>>[];
  readonly reusableKnowledge?: readonly Readonly<Record<string, unknown>>[];
  readonly cautions?: readonly string[];
  readonly failureLessons?: readonly Readonly<Record<string, unknown>>[];
  readonly conflicts?: readonly string[];
  readonly generalizationWarnings?: readonly string[];
}

function semanticSettlementSystemPrompt(): string {
  return [
    "You are the Local Agent memory settlement model.",
    "Return exactly one JSON object using schema agentloop.semanticSettlement/v1.",
    "The top-level object must contain learningValue. It may also contain sameGoalFamily, title, goalSummary, keywords, reuseRule, recheckRules, classicPath, toolUsage, reusableKnowledge, cautions, failureLessons, conflicts, and generalizationWarnings.",
    "Do not wrap the result in episode, taskGroup, learnings, result, or any other container; those wrapper-only shapes are invalid.",
    "learningValue must be an object with status (actionable|insufficient|unknown), novelty (new|reinforcement|none), and transferability (task_family|run_specific|unknown). If status is actionable, include non-empty actionChange and verification and use transferability=task_family.",
    "For actionable knowledge, reusableKnowledge entries need a concrete rule, conditions, trigger, decision or action, and expectedEvidence; failureLessons need a concrete rootCause, nextAction, verification, and applicability when applicable.",
    "Summarize a reusable goal path and lessons from bounded structured evidence.",
    "Do not decide whether the Run succeeded; do not invent tools, Skills, capabilities, evidence kinds, or facts.",
    "Do not include names, secrets, raw user text, file contents, tokens, URLs, or other task entities.",
    "Only generalize strings and records already represented in the input. Procedure memory is planner prior only.",
    "Set learningValue=insufficient when there is no concrete next action, applicability boundary, and observable verification.",
    "A vague reminder such as improve quality, validate more, or complete acceptance is insufficient.",
    "For a Task Group, provide a de-identified title, goalSummary, keywords, and reuseRule when the goal family is clear.",
    'Minimal valid example: {"schema":"agentloop.semanticSettlement/v1","learningValue":{"status":"insufficient","novelty":"none","transferability":"unknown"},"classicPath":[],"toolUsage":[],"reusableKnowledge":[],"failureLessons":[]}.',
  ].join(" ");
}

function semanticSettlementInput(
  evidence: MemorySettlementEvidence,
  pattern: ExperienceSettlementPattern,
  similarEpisodes: readonly ExperienceSettlementPattern[],
  similarTaskGroups: readonly ExperienceSettlementPattern[] = [],
): Readonly<Record<string, unknown>> {
  return {
    schema: SEMANTIC_SETTLEMENT_SCHEMA,
    taskFingerprint: evidence.taskFingerprint,
    episode: modelSafePattern(pattern),
    similarEpisodes: similarEpisodes.map(modelSafePattern),
    similarTaskGroups: similarTaskGroups.map((item) => ({
      ...modelSafePattern(item),
      ...(item.reusableKnowledge.length === 0 ? {} : { learningSections: ["reusable knowledge exists"] }),
      ...(item.failureLessons.length === 0 ? {} : { learningSections: ["failure lessons exist"] }),
    })),
    allowedTools: [...new Set(pattern.toolUsage.map((item) => item.toolName))],
    allowedSkills: [...new Set(pattern.classicPath.flatMap((step) => step.skillIds ?? []))],
    allowedCapabilities: [...new Set(pattern.classicPath.flatMap((step) => step.capabilityIds ?? []))],
    allowedEvidenceKinds: [...new Set(pattern.classicPath.flatMap((step) => [...step.requiredEvidenceKinds, ...step.producedEvidenceKinds]))],
  };
}

type SemanticSettlementParseResult =
  | { readonly output: SemanticSettlementOutput; readonly reason?: never }
  | { readonly output?: never; readonly reason: string };

function parseSemanticSettlement(content: string): SemanticSettlementParseResult {
  const trimmed = content.trim();
  const json = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/u)?.[0];
  if (json === undefined) return { reason: "json_not_found" };
  try {
    const value = JSON.parse(json) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { reason: "top_level_not_object" };
    const record = value as Record<string, unknown>;
    if (record.schema !== SEMANTIC_SETTLEMENT_SCHEMA) return { reason: "schema_mismatch" };
    return { output: record as unknown as SemanticSettlementOutput };
  } catch {
    return { reason: "json_invalid" };
  }
}

type SemanticSettlementValidationResult =
  | { readonly output: SemanticSettlementOutput; readonly reason?: never }
  | { readonly output?: never; readonly reason: string };

function validateSemanticSettlement(output: SemanticSettlementOutput, pattern: ExperienceSettlementPattern): SemanticSettlementValidationResult {
  const reject = (reason: string): SemanticSettlementValidationResult => ({ reason });
  const allowedTools = new Set(pattern.toolUsage.map((item) => item.toolName));
  const allowedSkills = new Set(pattern.classicPath.flatMap((step) => step.skillIds ?? []));
  const allowedCapabilities = new Set(pattern.classicPath.flatMap((step) => step.capabilityIds ?? []));
  const allowedEvidenceKinds = new Set(pattern.classicPath.flatMap((step) => [...step.requiredEvidenceKinds, ...step.producedEvidenceKinds]));
  if (output.learningValue === undefined || output.learningValue === null || typeof output.learningValue !== "object") return reject("learning_value_missing_or_invalid");
  if (output.learningValue !== undefined) {
    const value = output.learningValue;
    if (!["actionable", "insufficient", "unknown"].includes(value.status)
      || !["new", "reinforcement", "none"].includes(value.novelty)
      || !["task_family", "run_specific", "unknown"].includes(value.transferability)) return reject("learning_value_enum_invalid");
    if (value.status === "actionable"
      && (typeof value.actionChange !== "string" || value.actionChange.trim().length === 0
        || typeof value.verification !== "string" || value.verification.trim().length === 0
        || value.transferability !== "task_family")) return reject("actionable_learning_value_incomplete");
    if (value.status === "insufficient" && (value.actionChange !== undefined || value.verification !== undefined)) return reject("insufficient_learning_value_has_action");
  }
  for (const field of ["title", "goalSummary", "reuseRule"] as const) {
    if (output[field] !== undefined && (typeof output[field] !== "string" || output[field]!.trim().length === 0)) return reject(`${field}_invalid`);
  }
  if (output.keywords !== undefined && (!Array.isArray(output.keywords) || output.keywords.some((item) => typeof item !== "string"))) return reject("keywords_invalid");
  if (output.recheckRules !== undefined && (!Array.isArray(output.recheckRules) || output.recheckRules.some((item) => typeof item !== "string"))) return reject("recheck_rules_invalid");
  if (output.classicPath !== undefined) {
    if (!Array.isArray(output.classicPath) || output.classicPath.length > 24) return reject("classic_path_invalid");
    for (const step of output.classicPath) {
      if (step === null || typeof step !== "object" || typeof step.objective !== "string" || step.objective.trim().length === 0) return reject("classic_path_step_invalid");
      for (const tool of arrayStrings(step.toolNames)) if (!allowedTools.has(tool)) return reject("classic_path_tool_not_admitted");
      for (const skill of arrayStrings(step.skillIds)) if (!allowedSkills.has(skill)) return reject("classic_path_skill_not_admitted");
      for (const capability of arrayStrings(step.capabilityIds)) if (!allowedCapabilities.has(capability)) return reject("classic_path_capability_not_admitted");
      for (const evidenceKind of [...arrayStrings(step.requiredEvidenceKinds), ...arrayStrings(step.producedEvidenceKinds)]) {
        if (!allowedEvidenceKinds.has(evidenceKind)) return reject("classic_path_evidence_not_admitted");
      }
    }
  }
  if (output.toolUsage !== undefined) {
    if (!Array.isArray(output.toolUsage) || output.toolUsage.length > 24) return reject("tool_usage_invalid");
    for (const tool of output.toolUsage) if (tool === null || typeof tool !== "object" || typeof tool.toolName !== "string" || !allowedTools.has(tool.toolName)) return reject("tool_usage_tool_not_admitted");
  }
  if (output.cautions !== undefined && (!Array.isArray(output.cautions) || output.cautions.some((item) => typeof item !== "string"))) return reject("cautions_invalid");
  if (output.reusableKnowledge !== undefined && (!Array.isArray(output.reusableKnowledge) || output.reusableKnowledge.some((item) => item === null || typeof item !== "object" || typeof item.rule !== "string"))) return reject("reusable_knowledge_invalid");
  if (output.reusableKnowledge !== undefined) {
    for (const item of output.reusableKnowledge) {
      for (const key of ["trigger", "decision", "rationale", "action"] as const) {
        if (item[key] !== undefined && typeof item[key] !== "string") return reject(`reusable_knowledge_${key}_invalid`);
      }
      if (item.expectedEvidence !== undefined && (!Array.isArray(item.expectedEvidence) || item.expectedEvidence.some((value) => typeof value !== "string" || !allowedEvidenceKinds.has(value)))) return reject("reusable_knowledge_evidence_not_admitted");
      if (item.conditions !== undefined && (!Array.isArray(item.conditions) || item.conditions.some((value) => typeof value !== "string"))) return reject("reusable_knowledge_conditions_invalid");
      if (item.exclusions !== undefined && (!Array.isArray(item.exclusions) || item.exclusions.some((value) => typeof value !== "string"))) return reject("reusable_knowledge_exclusions_invalid");
    }
  }
  if (output.failureLessons !== undefined && (!Array.isArray(output.failureLessons) || output.failureLessons.some((item) => item === null || typeof item !== "object" || typeof item.lesson !== "string"))) return reject("failure_lessons_invalid");
  if (output.failureLessons !== undefined) {
    for (const item of output.failureLessons) {
      if (item.causeStatus !== undefined && !["confirmed", "inferred", "unknown"].includes(String(item.causeStatus))) return reject("failure_lesson_cause_status_invalid");
      for (const key of ["doDifferently", "trigger", "symptom", "rootCause", "nextAction", "verification"] as const) {
        if (item[key] !== undefined && typeof item[key] !== "string") return reject(`failure_lesson_${key}_invalid`);
      }
      for (const key of ["applicability", "exclusions"] as const) {
        if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].some((value) => typeof value !== "string"))) return reject(`failure_lesson_${key}_invalid`);
      }
    }
  }
  for (const field of ["conflicts", "generalizationWarnings"] as const) {
    if (output[field] !== undefined && (!Array.isArray(output[field]) || output[field].some((item) => typeof item !== "string"))) return reject(`${field}_invalid`);
  }
  return { output };
}

function arrayStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mergeSemanticPattern(pattern: ExperienceSettlementPattern, output: SemanticSettlementOutput): ExperienceSettlementPattern {
  const sourceRefs = pattern.references;
  const classicPath = output.classicPath === undefined ? pattern.classicPath : output.classicPath.map((step, index) => {
    const order = typeof step.order === "number" && Number.isSafeInteger(step.order) ? step.order : index + 1;
    const base = pattern.classicPath.find((candidate) => candidate.order === order) ?? pattern.classicPath[index];
    return {
      order,
      objective: String(step.objective).trim().slice(0, 400),
      ...(typeof step.role === "string" ? { role: step.role.slice(0, 120) } : base?.role === undefined ? {} : { role: base.role }),
      toolNames: [...new Set([...(base?.toolNames ?? []), ...arrayStrings(step.toolNames)])],
      skillIds: [...new Set([...(base?.skillIds ?? []), ...arrayStrings(step.skillIds)])],
      capabilityIds: [...new Set([...(base?.capabilityIds ?? []), ...arrayStrings(step.capabilityIds)])],
      requiredEvidenceKinds: [...new Set([...(base?.requiredEvidenceKinds ?? []), ...arrayStrings(step.requiredEvidenceKinds)])],
      producedEvidenceKinds: [...new Set([...(base?.producedEvidenceKinds ?? []), ...arrayStrings(step.producedEvidenceKinds)])],
      successCriteria: [...new Set([...(base?.successCriteria ?? []), ...arrayStrings(step.successCriteria)])],
      cautions: [...new Set([...(base?.cautions ?? []), ...arrayStrings(step.cautions)])],
    };
  });
  const toolUsage = output.toolUsage === undefined ? pattern.toolUsage : output.toolUsage.map((item) => ({
    toolName: String(item.toolName),
    ...(typeof item.purpose === "string" ? { purpose: item.purpose.slice(0, 300) } : {}),
    stepOrders: arrayNumbers(item.stepOrders),
    sourceRefs,
  }));
  const reusableKnowledge = output.reusableKnowledge === undefined ? pattern.reusableKnowledge : output.reusableKnowledge.map((item) => ({
    rule: String(item.rule).slice(0, 400), conditions: arrayStrings(item.conditions).slice(0, 8), exclusions: arrayStrings(item.exclusions).slice(0, 8),
    ...(typeof item.trigger === "string" ? { trigger: item.trigger.slice(0, 300) } : {}),
    ...(typeof item.decision === "string" ? { decision: item.decision.slice(0, 300) } : {}),
    ...(typeof item.rationale === "string" ? { rationale: item.rationale.slice(0, 300) } : {}),
    ...(typeof item.action === "string" ? { action: item.action.slice(0, 300) } : {}),
    ...(Array.isArray(item.expectedEvidence) ? { expectedEvidence: arrayStrings(item.expectedEvidence).slice(0, 8) } : {}),
    sourceRefs,
  }));
  const failureLessons: readonly ExperienceFailureLesson[] = output.failureLessons === undefined ? pattern.failureLessons : output.failureLessons.map((item): ExperienceFailureLesson => ({
    lesson: String(item.lesson).slice(0, 400), ...(typeof item.doDifferently === "string" ? { doDifferently: item.doDifferently.slice(0, 400) } : {}),
    ...(typeof item.trigger === "string" ? { trigger: item.trigger.slice(0, 300) } : {}),
    ...(typeof item.symptom === "string" ? { symptom: item.symptom.slice(0, 300) } : {}),
    ...(typeof item.rootCause === "string" ? { rootCause: item.rootCause.slice(0, 300) } : {}),
    ...(item.causeStatus === "confirmed" || item.causeStatus === "inferred" || item.causeStatus === "unknown" ? { causeStatus: item.causeStatus as "confirmed" | "inferred" | "unknown" } : {}),
    ...(typeof item.nextAction === "string" ? { nextAction: item.nextAction.slice(0, 300) } : {}),
    ...(typeof item.verification === "string" ? { verification: item.verification.slice(0, 300) } : {}),
    ...(Array.isArray(item.applicability) ? { applicability: arrayStrings(item.applicability).slice(0, 8) } : {}),
    ...(Array.isArray(item.exclusions) ? { exclusions: arrayStrings(item.exclusions).slice(0, 8) } : {}),
    sourceRefs,
  }));
  const learningValue = output.learningValue;
  if (learningValue === undefined) return pattern;
  const insufficient = learningValue?.status === "insufficient";
  return {
    ...pattern,
    ...(output.title === undefined ? {} : { title: output.title.trim().slice(0, 200) }),
    ...(output.goalSummary === undefined ? {} : { goalSummary: output.goalSummary.trim().slice(0, 500) }),
    ...(output.keywords === undefined ? {} : { keywords: [...new Set(output.keywords.map((item) => item.trim()).filter(Boolean))].slice(0, 24) }),
    ...(output.reuseRule === undefined ? {} : { reuseRule: output.reuseRule.trim().slice(0, 500) }),
    ...(output.recheckRules === undefined ? {} : { recheckRules: [...new Set(output.recheckRules.map((item) => item.trim()).filter(Boolean))].slice(0, 24) }),
    ...(output.conflicts === undefined ? {} : { conflicts: [...new Set(output.conflicts.map((item) => item.trim()).filter(Boolean))].slice(0, 16) }),
    ...(output.generalizationWarnings === undefined ? {} : { generalizationWarnings: [...new Set(output.generalizationWarnings.map((item) => item.trim()).filter(Boolean))].slice(0, 16) }),
    classicPath,
    keySteps: classicPath,
    toolUsage,
    cautions: output.cautions === undefined ? pattern.cautions : output.cautions.map((item) => item.trim().slice(0, 300)).filter(Boolean).slice(0, 24),
    reusableKnowledge: insufficient ? [] : reusableKnowledge,
    failureLessons: insufficient ? [] : failureLessons,
    learningValue: {
      status: learningValue.status,
      novelty: learningValue.novelty,
      transferability: learningValue.transferability,
      ...(learningValue.actionChange === undefined ? {} : { actionChange: learningValue.actionChange.slice(0, 400) }),
      ...(learningValue.verification === undefined ? {} : { verification: learningValue.verification.slice(0, 400) }),
    },
  };
}

function arrayNumbers(value: unknown): readonly number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item)) : [];
}

function assertJobEvidenceScope(job: MemorySettlementJob, evidence: MemorySettlementEvidence): void {
  if (
    evidence.scope.tenantId !== job.tenantId
    || evidence.scope.ownerUserId !== job.ownerUserId
    || evidence.scope.runId !== job.runId
    || evidence.runId !== job.runId
    || evidence.terminalCommitRef !== job.terminalCommitRef
  ) throw new Error("settlement_evidence_scope_mismatch");
}

export interface ProcedureConsolidationResult {
  readonly status: "created" | "skipped";
  readonly procedureRevisionId?: string;
  readonly sourceEpisodeRevisionIds: readonly string[];
  readonly reason: string;
}

function settlementPatternFromRevision(revision: MemoryRevision): ExperienceSettlementPattern | undefined {
  const value = revision.value.settlementPattern;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pattern = value as Partial<ExperienceSettlementPattern>;
  return pattern.schema === "agentloop.experienceSettlement/v1" ? pattern as ExperienceSettlementPattern : undefined;
}

function dedupeKnowledge(values: readonly ExperienceReusableKnowledge[], limit = 16): readonly ExperienceReusableKnowledge[] {
  return [...new Map(values.map((value) => [value.rule, value] as const)).values()].slice(0, limit);
}

function dedupeFailureLessons(values: readonly ExperienceFailureLesson[], limit = 16): readonly ExperienceFailureLesson[] {
  return [...new Map(values.map((value) => [value.lesson, value] as const)).values()].slice(0, limit);
}

function mergeKeySteps(patterns: readonly ExperienceSettlementPattern[]): readonly ExperienceKeyStep[] {
  const byOrder = new Map<number, ExperienceKeyStep>();
  for (const pattern of patterns) {
    for (const step of (pattern.classicPath ?? pattern.keySteps)) {
      const current = byOrder.get(step.order);
      if (current === undefined) {
        byOrder.set(step.order, { ...step });
        continue;
      }
      byOrder.set(step.order, {
        ...current,
        ...(current.role === undefined && step.role !== undefined ? { role: step.role } : {}),
        toolNames: [...new Set([...(current.toolNames ?? []), ...(step.toolNames ?? [])])],
        skillIds: [...new Set([...(current.skillIds ?? []), ...(step.skillIds ?? [])])],
        capabilityIds: [...new Set([...(current.capabilityIds ?? []), ...(step.capabilityIds ?? [])])],
        requiredEvidenceKinds: [...new Set([...current.requiredEvidenceKinds, ...step.requiredEvidenceKinds])],
        producedEvidenceKinds: [...new Set([...current.producedEvidenceKinds, ...step.producedEvidenceKinds])],
        successCriteria: [...new Set([...(current.successCriteria ?? []), ...(step.successCriteria ?? [])])],
        cautions: [...new Set([...(current.cautions ?? []), ...(step.cautions ?? [])])],
      });
    }
  }
  return [...byOrder.values()].sort((left, right) => left.order - right.order).slice(0, 24);
}

function mergeTaskGroupMetadata(patterns: readonly ExperienceSettlementPattern[]): Pick<ExperienceSettlementPattern, "title" | "goalSummary" | "keywords" | "reuseRule" | "recheckRules" | "conflicts" | "generalizationWarnings"> {
  const first = patterns.find((pattern) => pattern.title !== undefined || pattern.goalSummary !== undefined || pattern.reuseRule !== undefined);
  const unique = (values: readonly (string | undefined)[]): readonly string[] => [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].slice(0, 24);
  const keywords = unique(patterns.flatMap((pattern) => pattern.keywords ?? []));
  const recheckRules = unique(patterns.flatMap((pattern) => pattern.recheckRules ?? []));
  const conflicts = unique(patterns.flatMap((pattern) => pattern.conflicts ?? []));
  const generalizationWarnings = unique(patterns.flatMap((pattern) => pattern.generalizationWarnings ?? []));
  return {
    ...(first?.title === undefined ? {} : { title: first.title }),
    ...(first?.goalSummary === undefined ? {} : { goalSummary: first.goalSummary }),
    ...(keywords.length === 0 ? {} : { keywords }),
    ...(first?.reuseRule === undefined ? {} : { reuseRule: first.reuseRule }),
    ...(recheckRules.length === 0 ? {} : { recheckRules }),
    ...(conflicts.length === 0 ? {} : { conflicts }),
    ...(generalizationWarnings.length === 0 ? {} : { generalizationWarnings }),
  };
}

function dedupeToolUsage(values: readonly ExperienceToolUsage[], limit = 24): readonly ExperienceToolUsage[] {
  const byTool = new Map<string, ExperienceToolUsage>();
  for (const value of values) {
    const current = byTool.get(value.toolName);
    if (current === undefined) { byTool.set(value.toolName, value); continue; }
    byTool.set(value.toolName, {
      toolName: value.toolName,
      ...(current.purpose === undefined && value.purpose === undefined ? {} : { purpose: current.purpose ?? value.purpose }),
      stepOrders: [...new Set([...current.stepOrders, ...value.stepOrders])].sort((a, b) => a - b),
      sourceRefs: uniqueSourceRefs([...current.sourceRefs, ...value.sourceRefs]),
    });
  }
  return [...byTool.values()].slice(0, limit);
}

const FINGERPRINT_KEYS = ["taskKind", "domain", "artifactKind", "sourceKind", "capabilityIds"] as const;

function taskFingerprintFromRevision(revision: MemoryRevision): Readonly<Record<string, unknown>> {
  const value = revision.value.taskFingerprint;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function fingerprintSimilarity(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): number {
  const capabilities = (value: Readonly<Record<string, unknown>>): readonly string[] => Array.isArray(value.capabilityIds)
    ? value.capabilityIds.filter((item): item is string => typeof item === "string")
    : [];
  const leftCapabilities = new Set(capabilities(left));
  const rightCapabilities = new Set(capabilities(right));
  const capabilityOverlap = [...leftCapabilities].some((value) => rightCapabilities.has(value));
  // An operation label can vary with plan shape (lookup vs composite). A
  // shared canonical capability can bridge that label only when another
  // stable fingerprint dimension also agrees; it cannot merge on capability
  // alone.
  if (typeof left.taskKind === "string" && typeof right.taskKind === "string" && left.taskKind !== right.taskKind && !capabilityOverlap) return 0;
  const comparable = FINGERPRINT_KEYS.filter((key) => key === "capabilityIds"
    ? leftCapabilities.size > 0 || rightCapabilities.size > 0
    : typeof left[key] === "string" || typeof right[key] === "string");
  if (comparable.length === 0) return 0;
  const matching = comparable.filter((key) => key === "capabilityIds"
    ? capabilityOverlap
    : typeof left[key] === "string" && left[key] === right[key]).length;
  // Two matching dimensions are required when there are several dimensions;
  // this prevents unrelated tasks that happen to share only `taskKind` from
  // being promoted together.
  const minimumMatches = comparable.length === 1 ? 1 : 2;
  return matching >= minimumMatches && matching / comparable.length >= 0.5 ? matching / comparable.length : 0;
}

interface SimilarEpisodeGroup {
  readonly key: string;
  readonly representative: Readonly<Record<string, unknown>>;
  readonly entries: readonly Awaited<ReturnType<MemoryStore["active"]>>[number][];
}

async function semanticProcedureSettlement(
  model: MemorySettlementModel,
  pattern: ExperienceSettlementPattern,
  successPatterns: readonly ExperienceSettlementPattern[],
  failurePatterns: readonly ExperienceSettlementPattern[],
  similarTaskGroups: readonly ExperienceSettlementPattern[] = [],
  similarTaskGroupRevisionIds: readonly string[] = [],
  requireSettlementModel = false,
): Promise<{ readonly status: "accepted"; readonly pattern: ExperienceSettlementPattern; readonly metadata: Readonly<Record<string, unknown>> } | { readonly status: "rejected_goal_family" } | undefined> {
  const input = {
    schema: SEMANTIC_SETTLEMENT_SCHEMA,
    phase: "procedure",
    taskFingerprint: pattern.applicability.taskFingerprint,
    successfulEpisodes: successPatterns.map(modelSafePattern),
    failureLessons: failurePatterns.flatMap((item) => item.failureLessons.map(modelSafeFailureLesson)),
    similarTaskGroups: similarTaskGroups.map((item) => ({
      ...modelSafePattern(item),
      hasReusableKnowledge: item.reusableKnowledge.length > 0,
      hasFailureLessons: item.failureLessons.length > 0,
    })),
    allowedTools: [...new Set(pattern.toolUsage.map((item) => item.toolName))],
    allowedSkills: [...new Set(pattern.classicPath.flatMap((step) => step.skillIds ?? []))],
    allowedCapabilities: [...new Set(pattern.classicPath.flatMap((step) => step.capabilityIds ?? []))],
  };
  let content: string;
  try {
    content = (await model.complete({ runId: pattern.references.find((ref) => ref.type === "run")?.runId ?? "memory-procedure", systemPrompt: semanticSettlementSystemPrompt(), input })).content;
  } catch {
    if (requireSettlementModel) throw new Error("semantic_model_unavailable");
    return undefined;
  }
  const parsed = parseSemanticSettlement(content);
  if (parsed.output !== undefined && parsed.output.sameGoalFamily === false) return { status: "rejected_goal_family" };
  const validation = parsed.output === undefined
    ? { reason: parsed.reason }
    : validateSemanticSettlement(parsed.output, pattern);
  if (validation.output === undefined) {
    if (requireSettlementModel) throw new Error(`semantic_model_invalid_output:${validation.reason}`);
    return undefined;
  }
  const validated = validation.output;
  const merged = mergeSemanticPattern(pattern, validated);
  if (merged.learningValue?.status === "actionable" && !hasActionableKnowledge(merged) && !hasActionableFailureLesson(merged)) {
    if (requireSettlementModel) throw new Error("semantic_model_missing_actionable_knowledge");
    return undefined;
  }
  return {
    status: "accepted",
    pattern: merged,
    metadata: {
      modelKey: model.modelKey,
      promptSchemaVersion: "agentloop.semanticSettlement/v1",
      outputHash: stableHash(validated),
      status: "accepted",
      validationResult: "accepted",
      inputTaskGroupRevisionIds: [...similarTaskGroupRevisionIds],
    },
  };
}

function groupSimilarEpisodes(
  episodes: readonly Awaited<ReturnType<MemoryStore["active"]>>[number][],
): readonly SimilarEpisodeGroup[] {
  const groups: Array<{ key: string; representative: Readonly<Record<string, unknown>>; entries: Awaited<ReturnType<MemoryStore["active"]>>[number][] }> = [];
  for (const episode of episodes) {
    const fingerprint = taskFingerprintFromRevision(episode.revision);
    const match = groups.find((group) => fingerprintSimilarity(group.representative, fingerprint) > 0);
    if (match === undefined) {
      groups.push({
        key: `experience.similar:${stableHash(FINGERPRINT_KEYS.reduce<Record<string, unknown>>((result, key) => {
          if (typeof fingerprint[key] === "string") result[key] = fingerprint[key];
          return result;
        }, {})).slice(0, 24)}`,
        representative: fingerprint,
        entries: [episode],
      });
    } else {
      match.entries.push(episode);
    }
  }
  return groups;
}

/** Consolidate two independent episodes into one planner-only procedure. */
export async function consolidateProcedures(
  store: MemoryStore,
  scope: MemoryScope,
  now = Date.now(),
  settlementMetadata?: Readonly<Record<string, unknown>>,
  settlementModel?: MemorySettlementModel,
  requireSettlementModel = false,
  allowedRunIds?: readonly string[],
): Promise<ProcedureConsolidationResult[]> {
  if (requireSettlementModel && settlementModel === undefined) {
    return [{ status: "skipped", sourceEpisodeRevisionIds: [], reason: "settlement_model_required" }];
  }
  const allowed = allowedRunIds === undefined ? undefined : new Set(allowedRunIds);
  const active = await store.active(scope);
  const scopedActive = allowedRunIds === undefined ? active : entriesWithinAllowedRuns(active, allowedRunIds);
  // Failed lessons can enrich a procedure's warnings, but can never
  // independently promote one. Only verified-success episodes enter the
  // promotion groups below.
  const allEpisodes = scopedActive.filter(({ item, revision }) => {
    if (item.kind !== "experience" || item.subtype !== "experience.episode" || revision.experienceMaturity !== "episode") return false;
    return settlementPatternFromRevision(revision) !== undefined;
  });
  const episodes = allEpisodes.filter(({ revision }) => {
    const pattern = settlementPatternFromRevision(revision);
    return pattern?.outcome === "verified_success" && pattern.learningValue?.status === "actionable";
  });
  const groups = groupSimilarEpisodes(episodes);
  const results: ProcedureConsolidationResult[] = [];
  for (const { key: group, representative, entries: candidates } of groups) {
    const distinct = [...new Map(candidates.map((entry) => {
      const runId = entry.revision.sourceRefs.find((ref) => ref.type === "run")?.runId ?? entry.revision.id;
      return [runId, entry] as const;
    })).values()];
    if (distinct.length < 2) {
      results.push({ status: "skipped", sourceEpisodeRevisionIds: distinct.map(({ revision }) => revision.id), reason: "requires_two_independent_episodes" });
      continue;
    }
    const successRunIds = new Set(distinct.map(({ revision }) => revision.sourceRefs.find((ref) => ref.type === "run")?.runId));
    const relatedFailures = [...new Map(allEpisodes
      .filter(({ revision }) => {
        const pattern = settlementPatternFromRevision(revision);
        if (pattern === undefined) return false;
        return pattern.outcome !== "verified_success" && pattern.learningValue?.status === "actionable" && hasActionableFailureLesson(pattern);
      })
      .filter(({ revision }) => fingerprintSimilarity(representative, taskFingerprintFromRevision(revision)) > 0)
      .map((entry) => [entry.revision.sourceRefs.find((ref) => ref.type === "run")?.runId ?? entry.revision.id, entry] as const))
      .values()]
      .filter((entry) => !successRunIds.has(entry.revision.sourceRefs.find((ref) => ref.type === "run")?.runId));
    const allRelevant = [...distinct, ...relatedFailures];
    const canonicalKey = `experience.procedure:${group}`;
    const existing = scopedActive.find(({ item, revision }) => {
      if (item.kind !== "experience" || item.subtype !== "experience.procedure" || item.canonicalKey !== canonicalKey) return false;
      const pattern = settlementPatternFromRevision(revision);
      return pattern !== undefined && Array.isArray(pattern.classicPath);
    });
    const patterns = distinct.map(({ revision }) => settlementPatternFromRevision(revision)).filter((pattern): pattern is ExperienceSettlementPattern => pattern !== undefined);
    const failurePatterns = relatedFailures.map(({ revision }) => settlementPatternFromRevision(revision)).filter((pattern): pattern is ExperienceSettlementPattern => pattern !== undefined);
    const keySteps = mergeKeySteps(patterns);
    const toolUsage = dedupeToolUsage(patterns.flatMap((pattern) => pattern.toolUsage ?? []));
    const cautions = [...new Set(patterns.flatMap((pattern) => pattern.cautions ?? []))].slice(0, 24);
    const reusableKnowledgeRecords = dedupeKnowledge(patterns.flatMap((pattern) => pattern.reusableKnowledge));
    const failureLessonRecords = dedupeFailureLessons([...patterns, ...failurePatterns].flatMap((pattern) => pattern.failureLessons));
    const reusableKnowledge = reusableKnowledgeRecords.map((item) => item.rule);
    const failureLessons = failureLessonRecords.map((item) => item.lesson);
    const preferenceSignals = [...new Map(patterns.flatMap((pattern) => pattern.preferenceSignals).map((signal) => [stableHash(signal), signal] as const)).values()].slice(0, 16);
    const sourceRefs = allRelevant.flatMap(({ revision }) => revision.sourceRefs.filter((ref) => ref.type === "run" || ref.type === "outcome")).slice(0, 12);
    const fingerprint = distinct[0]?.revision.value.taskFingerprint;
    const taskKind = fingerprint !== null && typeof fingerprint === "object" && !Array.isArray(fingerprint) && typeof (fingerprint as Record<string, unknown>).taskKind === "string"
      ? (fingerprint as Record<string, unknown>).taskKind as string
      : undefined;
    const domain = fingerprint !== null && typeof fingerprint === "object" && !Array.isArray(fingerprint) && typeof (fingerprint as Record<string, unknown>).domain === "string"
      ? (fingerprint as Record<string, unknown>).domain as string
      : undefined;
    const deterministicProcedurePattern: ExperienceSettlementPattern = {
      schema: "agentloop.experienceSettlement/v1",
      phase: "procedure",
      outcome: "verified_success",
      outcomeReason: "promoted_from_independent_verified_success_episodes",
      applicability: {
        taskFingerprint: fingerprint !== null && typeof fingerprint === "object" && !Array.isArray(fingerprint) ? fingerprint as Readonly<Record<string, unknown>> : {},
        conditions: [...new Set(patterns.flatMap((pattern) => pattern.applicability.conditions))].slice(0, 16),
        exclusions: [...new Set(patterns.flatMap((pattern) => pattern.applicability.exclusions))].slice(0, 16),
      },
      preferenceSignals,
      classicPath: keySteps,
      keySteps,
      toolUsage,
      cautions,
      reusableKnowledge: reusableKnowledgeRecords,
      failureLessons: failureLessonRecords,
      verification: {
        terminalCommitted: patterns.every((pattern) => pattern.verification.terminalCommitted),
        assessmentApproved: patterns.every((pattern) => pattern.verification.assessmentApproved),
        artifactVerified: patterns.every((pattern) => pattern.verification.artifactVerified !== false),
        laterCorrected: patterns.some((pattern) => pattern.verification.laterCorrected),
        laterDisputed: patterns.some((pattern) => pattern.verification.laterDisputed),
        evidenceCoverage: patterns.length === 0 ? undefined : patterns.reduce((sum, pattern) => sum + (pattern.verification.evidenceCoverage ?? 0), 0) / patterns.length,
      },
      references: sourceRefs,
      ...mergeTaskGroupMetadata(patterns),
    };
    const taskGroupCandidates = settlementModel === undefined ? [] : await searchTaskGroupCandidates(store, scope, {
      taskFingerprint: representative,
      query: patterns.flatMap((item) => [item.title ?? "", item.goalSummary ?? "", ...(item.keywords ?? [])]),
      limit: 4,
    });
    const scopedRevisionIds = new Set(scopedActive.map(({ revision }) => revision.id));
    const scopedTaskGroupCandidates = taskGroupCandidates.filter(({ revision }) => scopedRevisionIds.has(revision.id));
    const similarTaskGroups = scopedTaskGroupCandidates
      .map(({ revision }) => taskGroupPatternFromRevision(revision))
      .filter((candidate): candidate is ExperienceSettlementPattern => candidate !== undefined);
    const semanticProcedure = settlementModel === undefined
      ? undefined
      : await semanticProcedureSettlement(
        settlementModel,
        deterministicProcedurePattern,
        patterns,
        failurePatterns,
        similarTaskGroups,
        scopedTaskGroupCandidates.map(({ revision }) => revision.id),
        requireSettlementModel,
      );
    if (semanticProcedure?.status === "rejected_goal_family") {
      results.push({ status: "skipped", sourceEpisodeRevisionIds: allRelevant.map(({ revision }) => revision.id), reason: "semantic_model_rejected_goal_family" });
      continue;
    }
    const procedurePattern = semanticProcedure?.pattern ?? deterministicProcedurePattern;
    if (!hasActionableKnowledge(procedurePattern) && !hasActionableFailureLesson(procedurePattern)) {
      results.push({ status: "skipped", sourceEpisodeRevisionIds: allRelevant.map(({ revision }) => revision.id), reason: "no_actionable_learning" });
      continue;
    }
    const procedureMetadata = semanticProcedure === undefined ? settlementMetadata : {
      ...(settlementMetadata ?? {}),
      ...semanticProcedure.metadata,
    };
    const candidate: MemoryCandidate = {
      schema: "agentloop.userMemoryCandidate/v1",
      id: `memcand_procedure_${stableHash({ scope, group }).slice(0, 24)}`,
      tenantId: scope.tenantId,
      ownerUserId: scope.ownerUserId,
      proposedKind: "experience",
      proposedSubtype: "experience.procedure",
      proposedCanonicalKey: canonicalKey,
      proposedValue: {
        taskGroupKey: group,
        supportingEpisodeRevisionIds: allRelevant.map(({ revision }) => revision.id),
        successfulEpisodeRevisionIds: distinct.map(({ revision }) => revision.id),
        keySteps,
        classicPath: keySteps,
        toolUsage,
        cautions,
        reusableKnowledge,
        failureLessons,
        settlementPattern: procedurePattern,
        reliability: {
          successfulEpisodes: distinct.length,
          failedEpisodes: relatedFailures.length,
          positiveFeedbackCount: patterns.filter((pattern) => pattern.preferenceSignals.some((signal) => signal.kind === "explicit_preference")).length,
          correctionCount: patterns.filter((pattern) => pattern.verification.laterCorrected).length,
        },
        ...(procedureMetadata === undefined ? {} : {
          semanticSettlement: {
            ...procedureMetadata,
            inputEpisodeRevisionIds: allRelevant.map(({ revision }) => revision.id),
          },
          ...(procedureMetadata.modelKey === undefined ? {} : { settlementModelKey: procedureMetadata.modelKey }),
          ...(procedureMetadata.promptSchemaVersion === undefined ? {} : { settlementPromptSchemaVersion: procedureMetadata.promptSchemaVersion }),
          ...(procedureMetadata.outputHash === undefined ? {} : { settlementOutputHash: procedureMetadata.outputHash }),
          ...(procedureMetadata.validationResult === undefined ? {} : { settlementValidationResult: procedureMetadata.validationResult }),
        }),
      },
      proposedContentMarkdown: `可复用流程（来自 ${distinct.length} 次独立验证）：\n${renderSettlementMarkdown(procedurePattern)}`,
      persistenceIntent: "future_oriented",
      authority: "verified_run",
      sensitivity: "normal",
      proposedExperienceMaturity: "procedure",
      activation: { mode: "task_match", ...(taskKind === undefined ? {} : { taskKinds: [taskKind] }), ...(domain === undefined ? {} : { domains: [domain] }) },
      applicationTargets: ["planner"],
      sourceRefs,
      confidence: Math.min(1, Number((0.65 + distinct.length * 0.1).toFixed(3))),
      reason: "consolidated_from_independent_verified_episodes",
      decision: "pending",
    };
    const sourceEpisodeRevisionIds = allRelevant.map(({ revision }) => revision.id);
    const previousSourceIds = existing === undefined ? [] : Array.isArray(existing.revision.value.supportingEpisodeRevisionIds)
      ? existing.revision.value.supportingEpisodeRevisionIds.filter((value): value is string => typeof value === "string")
      : [];
    const hasNewEvidence = sourceEpisodeRevisionIds.length !== previousSourceIds.length
      || sourceEpisodeRevisionIds.some((revisionId) => !previousSourceIds.includes(revisionId));
    if (existing !== undefined && !hasNewEvidence) {
      results.push({ status: "skipped", procedureRevisionId: existing.revision.id, sourceEpisodeRevisionIds, reason: "procedure_already_exists" });
      continue;
    }
    const committed = await store.commit(scope, { ...candidate, decision: "accepted" }, now);
    results.push({ status: "created", procedureRevisionId: committed.revision.id, sourceEpisodeRevisionIds, reason: existing === undefined ? "procedure_committed" : "procedure_revised_with_new_episode" });
  }
  return results;
}
