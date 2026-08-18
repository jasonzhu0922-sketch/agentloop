import type { AgentDefinition } from "../agents/agent-service.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import type { RuntimeEventSink } from "../runtime/contracts.ts";

export type PlanStatus = "pending" | "admitted" | "running" | "completed" | "failed";
export type PlanStepStatus = "pending" | "running" | "completed" | "failed";

export interface TaskSpec {
  readonly runId: string;
  readonly input: string;
  readonly agent: AgentDefinition;
  readonly availableSkills: readonly PrivateSkill[];
  readonly availableToolNames: readonly string[];
}

export interface SuccessCriterion {
  readonly id: string;
  readonly description: string;
  readonly source: "task" | "planner";
}

export interface PlanStepProposal {
  readonly id: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly skillIds: readonly string[];
  readonly requiredToolNames: readonly string[];
  readonly successCriteria: readonly SuccessCriterion[];
}

export interface PlanProposal {
  readonly goal: string;
  readonly selectedSkillIds: readonly string[];
  readonly steps: readonly PlanStepProposal[];
}

export interface PlanStep extends PlanStepProposal {
  readonly position: number;
  readonly status: PlanStepStatus;
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
}

export interface CriterionAssessment {
  readonly criterionId: string;
  readonly satisfied: boolean;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface SkillAssessment {
  readonly skillId: string;
  readonly followed: boolean;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface SkillComplianceAssessment {
  readonly id: string;
  readonly planId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly approved: boolean;
  readonly criteria: readonly CriterionAssessment[];
  readonly skills: readonly SkillAssessment[];
  readonly evidenceDigest: string;
  readonly feedback: string;
  readonly createdAt: number;
}

export interface Planner {
  plan(task: TaskSpec, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<PlanProposal>;
}

export interface StepAssessmentInput {
  readonly runId: string;
  readonly planId: string;
  readonly step: PlanStep;
  readonly skills: readonly PrivateSkill[];
  readonly evidence: StepEvidence;
  readonly modelEvidence?: StepEvidence;
  readonly contextSummary?: string;
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
