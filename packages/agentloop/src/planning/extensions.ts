import type { PrivateSkill } from "../skills/skill-service.ts";
import type { UploadedSourceSummary, VisibleDirectoryGrant } from "../runtime/contracts.ts";
import type {
  ConversationWorkingSet,
  PlanProposal,
  PlanningExtensionContext,
  PlanningToolSummary,
  PlanningWorkspaceFacts,
  SelectedSkillRole,
} from "./contracts.ts";

export interface PlanningExtensionInput {
  readonly runId: string;
  readonly actorUserId: string;
  readonly input: string;
  readonly responseOnly: boolean;
  readonly modelKey?: string;
  readonly conversationId?: string;
  readonly availableSkills: readonly PrivateSkill[];
  readonly selectedSkillRoles: readonly SelectedSkillRole[];
  readonly availableToolNames: readonly string[];
  readonly availableTools: readonly PlanningToolSummary[];
  readonly workspaceFacts?: PlanningWorkspaceFacts;
  readonly visibleDirectories: readonly VisibleDirectoryGrant[];
  readonly sources: readonly UploadedSourceSummary[];
  readonly conversationWorkingSet?: ConversationWorkingSet;
}

export interface PlanningExtensionProposalSource {
  readonly kind: "planning_extension";
  readonly extensionName: string;
  readonly templateId?: string;
  readonly score?: number;
}

export type PlanningExtensionDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "planner_context";
      readonly context: PlanningExtensionContext;
    }
  | {
      readonly kind: "plan_proposal";
      readonly proposal: PlanProposal;
      readonly source: PlanningExtensionProposalSource;
    };

export interface PlanAdmissionObservation {
  readonly runId: string;
  readonly proposal: PlanProposal;
  readonly admitted: boolean;
  readonly planId?: string;
  readonly source?: PlanningExtensionProposalSource;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface RuntimeOutcomeObservation {
  readonly runId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly planId?: string;
  readonly output?: string;
  readonly reasonCode?: string;
  readonly source?: PlanningExtensionProposalSource;
}

export interface PlanningExtension {
  readonly name: string;
  beforePlanning(input: PlanningExtensionInput): Promise<PlanningExtensionDecision>;
  afterPlanAdmission?(input: PlanAdmissionObservation): Promise<void>;
  afterOutcome?(input: RuntimeOutcomeObservation): Promise<void>;
}
