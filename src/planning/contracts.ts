import type { PrivateSkill } from "../skills/skill-service.ts";
import type { ModelMessage, RuntimeEventSink, UploadedSourceSummary } from "../runtime/contracts.ts";

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

export interface SelectedSkillRole {
  readonly skillId: string;
  readonly role: SkillRole;
  readonly reason: string;
}

export interface EvidenceContract {
  readonly requiredKinds: readonly EvidenceKind[];
  readonly caveatPolicy: CaveatPolicy;
}

export interface TaskSpec {
  readonly runId: string;
  readonly input: string;
  readonly availableSkills: readonly PrivateSkill[];
  readonly selectedSkillRoles?: readonly SelectedSkillRole[];
  readonly availableToolNames: readonly string[];
  readonly availableTools?: readonly PlanningToolSummary[];
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
  readonly reusableArtifacts: readonly ConversationReusableArtifact[];
  readonly failedBoundaries: readonly ConversationFailedBoundary[];
  readonly recommendedCapabilities: ConversationRecommendedCapabilities;
  readonly resumeSuggestion?: string;
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
  readonly recommendedToolNames: readonly string[];
  readonly output?: string;
  readonly error?: string;
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
  readonly sourceToolNames?: readonly string[];
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
  readonly toolNames: readonly string[];
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
  readonly recommendedToolNames: readonly string[];
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
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ToolEvidence {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly result: string;
}

export interface StepEvidence {
  readonly candidateOutput: string;
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
  readonly status?: "followed" | "skipped_unavailable" | "process_caveat" | "not_followed";
  readonly followed: boolean;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export type SuggestedRepairShape = "repair_leaf" | "ask_user" | "fail";

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
  readonly attempt: number;
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
