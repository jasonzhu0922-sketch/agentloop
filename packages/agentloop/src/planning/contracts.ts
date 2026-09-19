import type { PrivateSkill } from "../skills/skill-service.ts";
import type { ModelMessage, RuntimeDeliveryCandidate, RuntimeEventSink, UploadedSourceSummary } from "../runtime/contracts.ts";
import type { SourceNeed } from "../runtime/dynamic-prompt.ts";
import type { ToolSourceDescriptor } from "../tools/tool-registry.ts";

export type PlanStatus = "pending" | "admitted" | "running" | "completed" | "failed";
export type PlanStepStatus = "pending" | "running" | "completed" | "failed";
export type PlanStepKind = "leaf" | "milestone";
export type RefinementState =
  | "not_refinable"
  | "pending_facts"
  | "ready_to_refine"
  | "refining"
  | "refined";
export type OutcomePlanShape =
  | "single_leaf"
  | "fact_then_produce"
  | "multi_deliverable"
  | "pipeline"
  | "recovery_patch";
export type SkillRole = "primary_builder" | "source_provider" | "support" | "qa";
export type OutcomeLeafRole = "fact_acquisition" | "produce" | "deliver" | "repair";
export type EvidenceKind =
  | "source_summary"
  | "source_urls"
  | "schema_summary"
  | "record_counts"
  | "table_coverage"
  | "structured_extraction_artifact"
  /** A deterministic count/group/rank/value aggregation derived from structured records. */
  | "derived_aggregation"
  | "artifact_path"
  | "artifact_non_empty"
  | "artifact_acceptance"
  | "artifact_openable"
  | "format_matches_request"
  | "basic_navigation"
  | "delivery_receipt"
  | "explicit_caveats";
export type CaveatPolicy =
  | "none"
  | "mark_unverified_facts"
  | "strict_fail_on_missing_source";
export type SourceKind =
  | "api"
  | "database"
  | "dataset"
  | "document"
  | "repository"
  | "rubric"
  | "uploaded_source"
  | "visible_directory"
  | "workspace_file"
  | "web"
  | "conversation_workset"
  | "generated_artifact";
export type CapabilitySideEffect =
  | "none"
  | "workspace_read"
  | "workspace_write"
  | "external_read"
  | "external_write";
export type CapabilityRisk = "low" | "medium" | "high";

export interface SelectedSkillRole {
  readonly skillId: string;
  readonly role: SkillRole;
  readonly reason: string;
}

export interface EvidenceContract {
  readonly requiredKinds: readonly EvidenceKind[];
  readonly caveatPolicy: CaveatPolicy;
}

export interface PlanningCapability {
  readonly id: string;
  readonly category?: string;
  readonly label?: string;
  readonly description?: string;
  readonly sourceIds?: readonly string[];
  readonly produces: readonly EvidenceKind[];
  readonly sourceKinds: readonly SourceKind[];
  readonly sideEffect: CapabilitySideEffect;
  readonly risk: CapabilityRisk;
  readonly constraints?: readonly string[];
}

export interface StepExecutionBinding {
  readonly schema: "agentloop.stepExecutionBinding/v1";
  readonly requiredCapabilities: readonly string[];
  readonly resolvedToolNames: readonly string[];
  readonly sourceKinds: readonly SourceKind[];
  readonly sideEffect: CapabilitySideEffect;
  readonly evidenceKinds: readonly EvidenceKind[];
  /** Registered ToolSource identifiers, such as an MCP provider key. */
  readonly requiredToolSourceIds?: readonly string[];
  /** Concrete uploaded source identifiers authorized for this step. */
  readonly requiredUploadedSourceIds?: readonly string[];
  /** Concrete visible-directory identifiers authorized for this step. */
  readonly requiredVisibleDirectoryIds?: readonly string[];
}

export interface TaskSpec {
  readonly runId: string;
  /** The immutable user-authored text stored on the Run for audit and transcript projection. */
  readonly input: string;
  /**
   * Runtime-owned semantic binding of the latest turn to prior canonical
   * conversation state. Downstream planning consumes effectiveGoal instead of
   * independently reinterpreting an elliptical follow-up.
   */
  readonly turnResolution?: ConversationTurnResolution;
  readonly availableSkills: readonly PrivateSkill[];
  readonly selectedSkillRoles?: readonly SelectedSkillRole[];
  /**
   * Skills bound by accepted completed steps in this conversation. They are
   * candidates for the Planner's multi-turn continuation decision, never a
   * mandate to reuse an unrelated prior capability.
   */
  readonly continuationSkillIds?: readonly string[];
  readonly availableToolNames: readonly string[];
  readonly availableTools?: readonly PlanningToolSummary[];
  readonly availableCapabilities?: readonly PlanningCapability[];
  /** ToolSource identifiers explicitly named by the user and resolved by the host registry. */
  readonly requiredToolSourceIds?: readonly string[];
  readonly workspaceFacts?: PlanningWorkspaceFacts;
  readonly visibleDirectories?: readonly PlanningVisibleDirectory[];
  readonly sources?: readonly UploadedSourceSummary[];
  /**
   * A conversational answer is still persisted through the canonical Plan
   * lifecycle, but it may neither select capabilities nor execute Tools.
   */
  readonly responseOnly?: boolean;
  /**
   * Prior user/assistant turns from the same conversation, newest last. The
   * planner sees these as real transcript messages so a follow-up instruction
   * is planned in the context of what was already requested and produced.
   */
  readonly conversationHistory?: readonly ModelMessage[];
  /**
   * Persisted cross-turn semantic state for follow-up execution requests. This
   * is built from canonical Run facts, not model prose or UI transcript text.
   */
  readonly conversationWorkingSet?: ConversationWorkingSet;
  /**
   * Compact, bounded hints supplied by optional planning extensions. These are
   * Planner inputs only; they cannot admit a Plan or claim completion.
   */
  readonly planningExtensionContexts?: readonly PlanningExtensionContext[];
  /**
   * A bounded, authorization-preserving catalog used only after Admission
   * proves that the first proposal lacks a producer for required evidence.
   * These entries are not part of the first-round relevance recommendation.
   */
  readonly capabilityRecovery?: CapabilityRecoveryCatalog;
}

export interface CapabilityRecoveryCatalog {
  /** The complete Skill catalog already authorized by the Run grant. */
  readonly availableSkills: readonly PrivateSkill[];
  /** Capabilities declared by the authorized Tools and Skills. */
  readonly availableCapabilities: readonly PlanningCapability[];
}

export type ConversationTurnMode = "reply" | "execute" | "clarify";
export type ConversationTurnRelation =
  | "new_goal"
  | "continue_prior"
  | "correct_prior"
  | "refine_prior"
  | "challenge_prior";

export interface ConversationTurnResolution {
  readonly schema: "agentloop.conversationTurnResolution/v1";
  readonly mode: ConversationTurnMode;
  readonly relation: ConversationTurnRelation;
  readonly targetRunId?: string;
  /**
   * Server-validated identity of a prior accepted work product that this turn
   * changes. A Run is provenance, not an executable file target: a follow-up
   * must bind the concrete artifact before planning a native transformation.
   */
  readonly targetArtifact?: ConversationArtifactReference;
  /**
   * Server-validated identity of a completed prior Outcome whose semantic
   * result is an input to this Run. Unlike an artifact path, this reference
   * denotes the accepted result content itself and can be materialized through
   * the Runtime's scoped result reader.
   */
  readonly targetResult?: ConversationResultReference;
  readonly effectiveGoal: string;
  readonly evidenceDemand: SourceNeed;
  readonly userConstraints: readonly string[];
  readonly source: "model" | "model_guarded" | "deterministic" | "fallback";
}

export interface ConversationArtifactReference {
  readonly runId: string;
  readonly path: string;
}

export interface ConversationResultReference {
  readonly schema: "agentloop.conversationResultRef/v1";
  readonly runId: string;
  readonly sha256: string;
  readonly characters: number;
}

/** A persisted, Plan-owned declaration that a prior accepted Outcome is input. */
export interface ConversationInputBinding {
  readonly schema: "agentloop.conversationInputBinding/v1";
  readonly result: ConversationResultReference;
  readonly relation: "continue_prior" | "refine_prior" | "correct_prior" | "challenge_prior";
}

export interface PlanningExtensionContext {
  readonly schema: "agentloop.planningExtensionContext/v1";
  readonly extensionName: string;
  readonly kind: string;
  readonly content: unknown;
}

export interface PlanningWorkspaceFacts {
  readonly schema: "planning.workspaceFacts/v1";
  readonly kind: "conversation_workspace" | "workspace_root";
  readonly rootLabel: string;
  readonly state: "empty" | "has_entries" | "unavailable";
  readonly entryCount?: number;
  readonly sampleEntries?: readonly string[];
  readonly visibleDirectoryCount: number;
  readonly sourceCount?: number;
  readonly guidance: string;
}

export interface ConversationWorkingSet {
  readonly schema: "conversation.workset/v1";
  readonly conversationId: string;
  readonly runCount: number;
  readonly activeGoal?: ConversationActiveGoal;
  readonly planCursors: readonly ConversationPlanCursor[];
  /** Canonical turn intents persisted by prior Runs, keyed by their owning Run. */
  readonly resolvedIntents?: readonly ConversationResolvedIntent[];
  /**
   * Bounded, accepted step outputs retained independently of a Run's terminal
   * output.  A failed Run can have useful completed predecessors even though
   * its own `runs.output` is empty.
   */
  readonly completedStepHandoffs?: readonly ConversationCompletedStepHandoff[];
  /**
   * Completed terminal Outcomes are semantic work products, independently of
   * whether they also emitted a workspace artifact. Their compact projection
   * is for planning; contentRef can retrieve the immutable full text on demand.
   */
  readonly reusableResults?: readonly ConversationReusableResult[];
  readonly reusableArtifacts: readonly ConversationReusableArtifact[];
  readonly failedBoundaries: readonly ConversationFailedBoundary[];
  /** Append-only semantic links; historical terminal records remain immutable. */
  readonly outcomeRelations?: readonly ConversationOutcomeRelation[];
  readonly recommendedCapabilities: ConversationRecommendedCapabilities;
  readonly evidenceLedger?: ConversationEvidenceLedger;
  readonly resumeSuggestion?: string;
}

export interface ConversationReusableResult {
  readonly result: ConversationResultReference;
  readonly planId?: string;
  readonly goal: string;
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly artifactPaths: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface ConversationResolvedIntent {
  readonly runId: string;
  readonly resolution: ConversationTurnResolution;
}

export interface ConversationOutcomeRelation {
  readonly runId: string;
  readonly targetRunId: string;
  readonly relation: "correct_prior" | "refine_prior" | "challenge_prior";
  readonly state: "disputed" | "superseded";
}

export interface ConversationEvidenceLedger {
  readonly schema: "conversation.evidenceLedger/v1";
  readonly sourceSummaries: readonly ConversationSourceSummary[];
}

export interface ConversationSourceSummary {
  readonly runId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly schema: "agentloop.sourceSummaryCandidate/v1";
  readonly coveredTopics: readonly string[];
  readonly facts: readonly ConversationSourceFact[];
  readonly missingOrUnverified: readonly string[];
  readonly recommendedNextStep?: string;
}

export interface ConversationSourceFact {
  readonly claim: string;
  readonly sourceRefs: readonly ConversationSourceReference[];
  readonly confidence?: string;
}

export interface ConversationSourceReference {
  readonly sourceRefId?: string;
  readonly url?: string;
  readonly published?: string;
  readonly accessed?: string;
}

export interface ConversationActiveGoal {
  readonly runId: string;
  readonly planId?: string;
  readonly goal: string;
  readonly status: PlanStatus | "failed" | "cancelled";
  readonly unfinished: boolean;
  readonly reasonCode?: string;
}

export interface ConversationPlanCursor {
  readonly runId: string;
  readonly planId: string;
  /** Immutable user-authored Run input; older serialized fixtures may omit it. */
  readonly input?: string;
  readonly goal: string;
  readonly status: PlanStatus;
  readonly selectedSkillIds: readonly string[];
  readonly steps: readonly ConversationPlanStepCursor[];
}

export interface ConversationPlanStepCursor {
  readonly id: string;
  readonly kind?: PlanStepKind;
  readonly position: number;
  readonly status: PlanStepStatus;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly skillIds: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly executionBinding: StepExecutionBinding;
  readonly output?: string;
  readonly error?: string;
}

export interface ConversationCompletedStepHandoff {
  readonly runId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly role?: OutcomeLeafRole;
  readonly objective: string;
  /**
   * Canonical bindings of the completed step.  A follow-up may still need the
   * same Skill even though this step is no longer unfinished.
   */
  readonly skillIds: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly output: string;
  readonly outputTruncated: boolean;
}

export interface ConversationReusableArtifact {
  readonly runId: string;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly sourceTool: string;
  readonly sourceToolCallId?: string;
  readonly sourcePlanStepId?: string;
  readonly sourceSkillIds?: readonly string[];
  readonly sourceCapabilities?: readonly string[];
  readonly reusable: boolean;
}

export interface ConversationFailedBoundary {
  readonly runId: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly reasonCode?: string;
  readonly category: "provider" | "planning" | "assessment" | "tool" | "runtime" | "cancelled" | "unknown";
}

export interface ConversationRecommendedCapabilities {
  readonly skillIds: readonly string[];
  readonly capabilityIds: readonly string[];
}

export interface PlanningVisibleDirectory {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface PlanningToolSummary {
  readonly name: string;
  readonly description: string;
  readonly dangerous?: boolean;
  readonly source?: ToolSourceDescriptor;
}

export interface SourceConstraint {
  readonly requiredToolSourceIds?: readonly string[];
  readonly requiredUploadedSourceIds?: readonly string[];
  readonly requiredVisibleDirectoryIds?: readonly string[];
}

export interface SuccessCriterion {
  readonly id: string;
  readonly description: string;
  readonly source: "task" | "planner";
}

export interface RequiredFact {
  readonly id: string;
  readonly description: string;
  readonly evidenceKinds: readonly string[];
  readonly satisfiedBy?: readonly string[];
}

export interface PlanStepProposal {
  readonly id: string;
  readonly kind?: PlanStepKind;
  readonly parentId?: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly role?: OutcomeLeafRole;
  readonly refinementState?: RefinementState;
  readonly requiredFacts?: readonly RequiredFact[];
  readonly skillIds: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly sourceConstraint?: SourceConstraint;
  readonly evidenceContract?: EvidenceContract;
  readonly successCriteria: readonly SuccessCriterion[];
}

export interface PlanProposal {
  readonly goal: string;
  readonly schema?: "agentloop.outcomePlan/v2";
  readonly shape?: OutcomePlanShape;
  readonly selectedSkillRoles?: readonly SelectedSkillRole[];
  readonly selectedSkillIds: readonly string[];
  readonly steps: readonly PlanStepProposal[];
}

export interface PlanStep extends PlanStepProposal {
  readonly kind: PlanStepKind;
  readonly position: number;
  readonly status: PlanStepStatus;
  readonly refinementState: RefinementState;
  readonly requiredFacts: readonly RequiredFact[];
  readonly requiredCapabilities: readonly string[];
  readonly executionBinding: StepExecutionBinding;
  readonly output?: string;
  readonly evidence?: StepEvidence;
  readonly error?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly retiredAt?: number;
  readonly retirementReason?: string;
}

export interface ExecutionPlan {
  readonly id: string;
  readonly runId: string;
  readonly version: number;
  readonly goal: string;
  readonly selectedSkillIds: readonly string[];
  /** Explicit, persisted prior-Outcome inputs selected for this Plan. */
  readonly inputBindings?: readonly ConversationInputBinding[];
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ToolEvidence {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly invocationStatus?: "completed" | "failed" | "rejected";
  readonly operationStatus?: "succeeded" | "failed" | "unknown";
  readonly exitCode?: number | null;
  readonly isError: boolean;
  readonly failurePhase?: "prepare" | "execute" | "operation" | "runtime";
  readonly result: string;
}

export interface StepEvidence {
  readonly candidateOutput: string;
  readonly deliveryCandidate?: RuntimeDeliveryCandidate;
  readonly toolCalls: readonly ToolEvidence[];
  readonly modelSteps: number;
  readonly completionCaveat?: CompletionCaveat;
}

export interface CompletionCaveat {
  readonly reason: "deferred_validation" | "process_caveat" | "repair_limit" | "evidence_boundary";
  readonly feedback: string;
}

export interface CriterionAssessment {
  readonly criterionId: string;
  readonly satisfied: boolean;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface SkillAssessment {
  readonly skillId: string;
  readonly status?: "followed" | "skipped_unavailable" | "process_caveat" | "not_followed" | "not_assessed";
  readonly followed: boolean;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export type SuggestedRepairShape = "repair_leaf" | "revise_plan" | "ask_user" | "fail";

export interface FailedBoundary {
  readonly stepId: string;
  readonly missingEvidenceKinds: readonly string[];
  readonly violatedSkillRequirements: readonly string[];
  readonly reusableEvidenceRefs: readonly string[];
  readonly suggestedRepairShape: SuggestedRepairShape;
}

export type AssessmentProfileId =
  | "deterministic"
  | "evidence_gate"
  | "lookup_lite"
  | "source_grounded"
  | "risk_sensitive";

export type AssessmentMethod = "rule" | "model";

export interface SkillComplianceAssessment {
  readonly id: string;
  readonly planId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly assessmentProfile?: AssessmentProfileId;
  readonly assessmentMethod?: AssessmentMethod;
  readonly approved: boolean;
  readonly criteria: readonly CriterionAssessment[];
  readonly skills: readonly SkillAssessment[];
  readonly evidenceDigest: string;
  readonly feedback: string;
  readonly failedBoundary?: FailedBoundary;
  readonly createdAt: number;
}

export interface Planner {
  plan(task: TaskSpec, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<PlanProposal>;
  refine?(task: PlanRefinementSpec, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<readonly PlanStepProposal[]>;
}

export interface PlanRefinementSpec {
  readonly runId: string;
  readonly input: string;
  readonly plan: ExecutionPlan;
  readonly milestone: PlanStep;
  readonly availableSkills: readonly PrivateSkill[];
  readonly availableToolNames: readonly string[];
  readonly availableTools?: readonly PlanningToolSummary[];
  readonly visibleDirectories?: readonly PlanningVisibleDirectory[];
  readonly conversationHistory?: readonly ModelMessage[];
}

export interface StepAssessmentInput {
  readonly runId: string;
  readonly planId: string;
  readonly step: PlanStep;
  readonly skills: readonly PrivateSkill[];
  readonly evidence: StepEvidence;
  readonly modelEvidence?: StepEvidence;
  readonly contextSummary?: string;
  readonly assessmentProfile?: AssessmentProfileId;
  /** This candidate has an artifact/source-receipt shape mismatch for holistic assessment. */
  readonly holisticSourceContractMismatch?: boolean;
  readonly attempt: number;
  readonly decisionLedger?: readonly import("../runtime/decision-ledger.ts").RuntimeDecisionCommit[];
}

export interface StepAssessor {
  assess(input: StepAssessmentInput, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<SkillComplianceAssessment>;
}

export interface PlanRevisionAssessmentInput {
  readonly runId: string;
  readonly userInput: string;
  readonly currentPlan: ExecutionPlan;
  readonly proposal: PlanProposal;
  readonly retiredStepIds: readonly string[];
  readonly recoveryAction: Readonly<{
    id: string;
    kind: string;
    replayPolicy: "safe" | "idempotent" | "unsafe";
    metadata: Readonly<Record<string, unknown>>;
  }>;
}

export interface PlanRevisionAssessment {
  readonly approved: boolean;
  readonly feedback: string;
  readonly evidenceRefs: readonly string[];
}

export interface PlanRevisionAssessor {
  assess(input: PlanRevisionAssessmentInput, signal?: AbortSignal): Promise<PlanRevisionAssessment>;
}
