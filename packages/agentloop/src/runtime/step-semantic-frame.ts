import type { ConversationWorkingSet, EvidenceKind, ExecutionPlan } from "../planning/contracts.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import type { TaskProfile } from "./dynamic-prompt.ts";
import type { OperationProfileId } from "./operation-profiles.ts";
import type { UploadedSourceSummary, VisibleDirectoryGrant } from "./contracts.ts";

export type StepPhaseRole =
  | "evidence_acquisition"
  | "analysis"
  | "artifact_production"
  | "delivery"
  | "repair";

export type StepEvidenceMode =
  | "acquire_new_evidence"
  | "reuse_dependency_evidence"
  | "reuse_conversation_evidence"
  | "verify_existing_artifact"
  | "produce_without_external_evidence";

export type StepEvidenceSourceKind =
  | "visible_directory"
  | "uploaded_source"
  | "web"
  | "dependency_step"
  | "conversation_workset"
  | "workspace_file"
  | "none";

export type StepEvidenceReusePolicy = "must_reuse_first" | "may_reuse" | "fresh_required";

export type StepFirstAction =
  | "inspect_available_sources"
  | "read_bound_source"
  | "query_web_sources"
  | "reuse_prior_summary"
  | "reuse_prior_artifact"
  | "write_artifact"
  | "verify_artifact"
  | "answer_from_context"
  | "repair_failed_boundary";

export interface StepEvidenceSource {
  readonly kind: StepEvidenceSourceKind;
  readonly required: boolean;
  readonly refs?: readonly string[];
  readonly reusePolicy?: StepEvidenceReusePolicy;
}

export interface StepSemanticFrame {
  readonly schema: "agentloop.stepSemanticFrame/v1";
  readonly stepId: string;
  readonly phaseRole: StepPhaseRole;
  readonly operation: OperationProfileId;
  readonly evidenceMode: StepEvidenceMode;
  readonly evidenceSources: readonly StepEvidenceSource[];
  readonly firstAction: StepFirstAction;
  readonly completionBoundary: readonly EvidenceKind[];
  readonly forbiddenMoves: readonly string[];
  readonly qaOwnership: {
    readonly runtimeCore: readonly EvidenceKind[];
    readonly skillRubric: readonly string[];
    readonly toolSignals: readonly string[];
  };
}

const OPERATION_PROFILE_IDS = new Set<OperationProfileId>([
  "data_analysis",
  "content_generation",
  "code_change",
  "web_research",
  "artifact_build",
  "direct_answer",
]);

const RUNTIME_CORE_EVIDENCE_KINDS = new Set<EvidenceKind>([
  "source_summary",
  "source_urls",
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
  "delivery_receipt",
  "explicit_caveats",
]);

const QA_TOOL_SIGNAL_KINDS = new Set<EvidenceKind>([
  "basic_navigation",
]);

export function deriveStepSemanticFrame(input: {
  readonly step: ExecutionPlan["steps"][number];
  readonly plan: ExecutionPlan;
  readonly skills: readonly PrivateSkill[];
  readonly visibleDirectories: readonly VisibleDirectoryGrant[];
  readonly sources: readonly UploadedSourceSummary[];
  readonly taskProfile: TaskProfile;
  readonly operationProfileId?: string;
  readonly requiresFileOutput: boolean;
  readonly conversationWorkingSet?: ConversationWorkingSet;
}): StepSemanticFrame {
  const operation = normalizeOperationProfileId(input.operationProfileId, input);
  const completionBoundary = runtimeCoreEvidenceKinds(input.step.evidenceContract?.requiredKinds ?? []);
  const phaseRole = derivePhaseRole(input.step, operation, completionBoundary, input.requiresFileOutput);
  const evidenceSources = deriveEvidenceSources(input, completionBoundary);
  const evidenceMode = deriveEvidenceMode(input.step, evidenceSources, phaseRole, input.requiresFileOutput);
  const firstAction = deriveFirstAction(input.step, evidenceSources, evidenceMode, phaseRole, operation);
  const toolSignals = toolSignalKinds(input.step.evidenceContract?.requiredKinds ?? [], input.step.successCriteria);
  const skillRubric = [...new Set(input.skills.flatMap((skill) => skill.agentLoop?.qaKinds ?? []))].sort();
  return {
    schema: "agentloop.stepSemanticFrame/v1",
    stepId: input.step.id,
    phaseRole,
    operation,
    evidenceMode,
    evidenceSources: evidenceSources.length === 0 ? [{ kind: "none", required: false }] : evidenceSources,
    firstAction,
    completionBoundary,
    forbiddenMoves: forbiddenMovesForFrame({
      phaseRole,
      evidenceMode,
      firstAction,
      evidenceSources,
      requiresFileOutput: input.requiresFileOutput,
    }),
    qaOwnership: {
      runtimeCore: completionBoundary,
      skillRubric,
      toolSignals,
    },
  };
}

function normalizeOperationProfileId(
  value: string | undefined,
  input: {
    readonly step: ExecutionPlan["steps"][number];
    readonly taskProfile: TaskProfile;
    readonly requiresFileOutput: boolean;
  },
): OperationProfileId {
  if (value !== undefined && OPERATION_PROFILE_IDS.has(value as OperationProfileId)) {
    return value as OperationProfileId;
  }
  if (input.step.recommendedToolNames.some((name) => name === "websearch" || name === "webfetch")) return "web_research";
  if (input.step.role === "fact_acquisition") return "data_analysis";
  if (input.step.recommendedToolNames.some((name) => name.startsWith("visible_") || name === "read_source")) return "data_analysis";
  if (input.requiresFileOutput || input.taskProfile.deliverySurface === "workspace_artifact") return "artifact_build";
  if (input.taskProfile.sourceNeed !== undefined && input.taskProfile.sourceNeed !== "none") return "web_research";
  if (input.step.role === "deliver") return "direct_answer";
  return "content_generation";
}

function runtimeCoreEvidenceKinds(kinds: readonly EvidenceKind[]): EvidenceKind[] {
  return kinds.filter((kind) => RUNTIME_CORE_EVIDENCE_KINDS.has(kind));
}

function toolSignalKinds(
  requiredKinds: readonly EvidenceKind[],
  criteria: readonly { readonly id: string; readonly description: string }[],
): string[] {
  const signals = new Set<string>();
  for (const kind of requiredKinds) {
    if (QA_TOOL_SIGNAL_KINDS.has(kind)) signals.add(kind);
  }
  const criteriaText = criteria.map((criterion) => `${criterion.id} ${criterion.description}`).join("\n");
  if (/(?:basic[_\s-]?navigation|\bnavigation\b|导航|翻页|分页)/iu.test(criteriaText)) {
    signals.add("basic_navigation");
  }
  return [...signals].sort();
}

function derivePhaseRole(
  step: ExecutionPlan["steps"][number],
  operation: OperationProfileId,
  completionBoundary: readonly EvidenceKind[],
  requiresFileOutput: boolean,
): StepPhaseRole {
  if (step.role === "repair") return "repair";
  if (step.role === "fact_acquisition") return "evidence_acquisition";
  if (requiresFileOutput || completionBoundary.some((kind) => kind.startsWith("artifact_") || kind === "format_matches_request")) {
    return "artifact_production";
  }
  if (step.role === "deliver") return "delivery";
  if (operation === "data_analysis" || completionBoundary.includes("source_summary")) return "analysis";
  return "artifact_production";
}

function deriveEvidenceSources(
  input: {
    readonly step: ExecutionPlan["steps"][number];
    readonly plan: ExecutionPlan;
    readonly visibleDirectories: readonly VisibleDirectoryGrant[];
    readonly sources: readonly UploadedSourceSummary[];
    readonly conversationWorkingSet?: ConversationWorkingSet;
  },
  completionBoundary: readonly EvidenceKind[],
): StepEvidenceSource[] {
  const result: StepEvidenceSource[] = [];
  const needsSource = completionBoundary.some((kind) => kind === "source_summary" || kind === "source_urls" || kind === "explicit_caveats");
  if (input.step.dependencies.length > 0) {
    result.push({
      kind: "dependency_step",
      required: true,
      refs: input.step.dependencies,
      reusePolicy: "must_reuse_first",
    });
  }
  if (input.step.recommendedToolNames.some((name) => name.startsWith("visible_")) || (needsSource && input.visibleDirectories.length > 0)) {
    result.push({
      kind: "visible_directory",
      required: needsSource || input.step.role === "fact_acquisition",
      refs: input.visibleDirectories.map((directory) => directory.id),
      reusePolicy: input.step.dependencies.length === 0 ? "fresh_required" : "may_reuse",
    });
  }
  if (input.step.recommendedToolNames.includes("read_source") || (needsSource && input.sources.length > 0)) {
    result.push({
      kind: "uploaded_source",
      required: needsSource || input.step.role === "fact_acquisition",
      refs: input.sources.map((source) => source.id),
      reusePolicy: input.step.dependencies.length === 0 ? "fresh_required" : "may_reuse",
    });
  }
  if (input.step.recommendedToolNames.some((name) => name === "websearch" || name === "webfetch")) {
    result.push({
      kind: "web",
      required: needsSource || input.step.role === "fact_acquisition",
      reusePolicy: input.step.dependencies.length === 0 ? "fresh_required" : "may_reuse",
    });
  }
  if (input.conversationWorkingSet?.evidenceLedger !== undefined || (input.conversationWorkingSet?.reusableArtifacts.length ?? 0) > 0) {
    result.push({
      kind: "conversation_workset",
      required: input.step.dependencies.length === 0 && (needsSource || completionBoundary.length > 0),
      refs: conversationWorksetRefs(input.conversationWorkingSet),
      reusePolicy: "must_reuse_first",
    });
  }
  if (input.step.recommendedToolNames.some((name) => /^computer_(?:read|find|search|run)/u.test(name))) {
    result.push({
      kind: "workspace_file",
      required: needsSource || input.step.role === "fact_acquisition",
      reusePolicy: "may_reuse",
    });
  }
  return dedupeEvidenceSources(result);
}

function conversationWorksetRefs(workset: ConversationWorkingSet | undefined): string[] {
  if (workset === undefined) return [];
  return [
    ...workset.reusableArtifacts.map((artifact) => artifact.path),
    ...(workset.evidenceLedger?.sourceSummaries.map((summary) => `${summary.runId}:${summary.stepId}`) ?? []),
  ].slice(0, 20);
}

function dedupeEvidenceSources(sources: readonly StepEvidenceSource[]): StepEvidenceSource[] {
  const merged = new Map<StepEvidenceSourceKind, StepEvidenceSource>();
  for (const source of sources) {
    const prior = merged.get(source.kind);
    if (prior === undefined) {
      merged.set(source.kind, source);
      continue;
    }
    merged.set(source.kind, {
      kind: source.kind,
      required: prior.required || source.required,
      refs: [...new Set([...(prior.refs ?? []), ...(source.refs ?? [])])],
      reusePolicy: mergeReusePolicy(prior.reusePolicy, source.reusePolicy),
    });
  }
  return [...merged.values()];
}

function mergeReusePolicy(
  left: StepEvidenceReusePolicy | undefined,
  right: StepEvidenceReusePolicy | undefined,
): StepEvidenceReusePolicy | undefined {
  if (left === "must_reuse_first" || right === "must_reuse_first") return "must_reuse_first";
  if (left === "fresh_required" || right === "fresh_required") return "fresh_required";
  return left ?? right;
}

function deriveEvidenceMode(
  step: ExecutionPlan["steps"][number],
  evidenceSources: readonly StepEvidenceSource[],
  phaseRole: StepPhaseRole,
  requiresFileOutput: boolean,
): StepEvidenceMode {
  if (phaseRole === "repair") return "verify_existing_artifact";
  if (evidenceSources.some((source) => source.kind === "dependency_step" && source.reusePolicy === "must_reuse_first")) {
    return "reuse_dependency_evidence";
  }
  if (evidenceSources.some((source) => source.kind === "conversation_workset" && source.reusePolicy === "must_reuse_first")) {
    return "reuse_conversation_evidence";
  }
  if (!requiresFileOutput && step.recommendedToolNames.includes("verify_artifact_acceptance")) return "verify_existing_artifact";
  if (evidenceSources.some((source) => source.kind !== "none" && source.required)) return "acquire_new_evidence";
  return "produce_without_external_evidence";
}

function deriveFirstAction(
  step: ExecutionPlan["steps"][number],
  evidenceSources: readonly StepEvidenceSource[],
  evidenceMode: StepEvidenceMode,
  phaseRole: StepPhaseRole,
  operation: OperationProfileId,
): StepFirstAction {
  if (phaseRole === "repair") return "repair_failed_boundary";
  if (evidenceMode === "reuse_dependency_evidence") {
    return dependencyLikelyHasSourceSummary(step, evidenceSources) ? "reuse_prior_summary" : "reuse_prior_artifact";
  }
  if (evidenceMode === "reuse_conversation_evidence") {
    return conversationLikelyHasSourceSummary(evidenceSources) ? "reuse_prior_summary" : "reuse_prior_artifact";
  }
  if (evidenceMode === "verify_existing_artifact") return "verify_artifact";
  if (evidenceSources.some((source) => source.kind === "web")) return "query_web_sources";
  if (evidenceSources.some((source) => source.kind === "uploaded_source")) return "read_bound_source";
  if (evidenceSources.some((source) => source.kind === "visible_directory" || source.kind === "workspace_file")) {
    return "inspect_available_sources";
  }
  if (phaseRole === "artifact_production" || operation === "artifact_build") return "write_artifact";
  return "answer_from_context";
}

function dependencyLikelyHasSourceSummary(
  step: ExecutionPlan["steps"][number],
  evidenceSources: readonly StepEvidenceSource[],
): boolean {
  if (!evidenceSources.some((source) => source.kind === "dependency_step")) return false;
  return /(?:summary|source|evidence|analysis|extract|inspect|profile|分析|取证|证据|摘要|提取|读取|检查)/iu.test(
    `${step.objective}\n${step.successCriteria.map((criterion) => criterion.description).join("\n")}`,
  );
}

function conversationLikelyHasSourceSummary(evidenceSources: readonly StepEvidenceSource[]): boolean {
  return evidenceSources.some((source) =>
    source.kind === "conversation_workset"
    && source.refs?.some((ref) => ref.includes(":")) === true
  );
}

function forbiddenMovesForFrame(input: {
  readonly phaseRole: StepPhaseRole;
  readonly evidenceMode: StepEvidenceMode;
  readonly firstAction: StepFirstAction;
  readonly evidenceSources: readonly StepEvidenceSource[];
  readonly requiresFileOutput: boolean;
}): string[] {
  const moves = new Set<string>();
  if (input.phaseRole === "evidence_acquisition" || input.firstAction === "inspect_available_sources") {
    moves.add("do not answer from assumptions when authorized source material is available");
  }
  if (input.phaseRole === "evidence_acquisition") {
    moves.add("do not write the downstream final artifact before source evidence is captured");
  }
  if (input.evidenceMode === "reuse_dependency_evidence" || input.evidenceMode === "reuse_conversation_evidence") {
    moves.add("do not reacquire source data solely to recreate already satisfied prior evidence");
  }
  if (input.evidenceSources.some((source) => source.kind === "visible_directory")) {
    moves.add("do not bypass visible_* source refs with workspace-root reads for visible directory material");
  }
  if (input.requiresFileOutput) {
    moves.add("do not treat command stdout that only mentions a path as artifact delivery evidence");
  }
  moves.add("do not make Skill-owned QA or optional tool signals a Runtime completion blocker");
  return [...moves];
}
