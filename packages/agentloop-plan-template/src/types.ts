import type {
  EvidenceKind,
  OutcomeLeafRole,
  OutcomePlanShape,
  PlanProposal,
} from "@zhujun/agentloop";
import type { PlanTemplateRiskLevel } from "./config.ts";

export type TaskSourceNeed =
  | "none"
  | "uploaded_file"
  | "visible_directory"
  | "web_research"
  | "existing_conversation_context";

export type TaskArtifactKind =
  | "none"
  | "html"
  | "pdf"
  | "pptx"
  | "docx"
  | "xlsx"
  | "image"
  | "code";

export type TaskSideEffectKind =
  | "none"
  | "write_file"
  | "send_email"
  | "external_api"
  | "browser_operation";

export interface TaskFingerprint {
  readonly schema: "agentloop.taskFingerprint/v1";
  readonly language: "zh" | "en" | "mixed";
  readonly intentHints: readonly string[];
  readonly sourceNeed: TaskSourceNeed;
  readonly sourceTypes: readonly string[];
  readonly artifactKind: TaskArtifactKind;
  readonly sideEffectKind: TaskSideEffectKind;
  readonly requiredCapabilities: readonly string[];
  readonly skillHints: readonly string[];
  readonly operationHints: readonly string[];
  readonly instructionTokens: readonly string[];
  readonly outputConstraints: readonly string[];
  readonly riskLevel: PlanTemplateRiskLevel;
  readonly textEmbeddingRef?: string;
  readonly confidence: number;
}

export interface PlanTemplate {
  readonly schema: "agentloop.planTemplate/v1";
  readonly id: string;
  readonly version: number;
  readonly status: "draft" | "candidate" | "active" | "retired";
  readonly intentFamily: string;
  readonly sourceNeed: TaskSourceNeed;
  readonly acceptedSourceTypes: readonly string[];
  readonly artifactKind: TaskArtifactKind;
  readonly sideEffectKind: TaskSideEffectKind;
  readonly requiredCapabilities: readonly string[];
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
  readonly riskCeiling: PlanTemplateRiskLevel;
  readonly planSkeleton: readonly PlanStepSkeleton[];
  readonly positiveExampleRefs: readonly string[];
  readonly negativeExampleRefs: readonly string[];
  readonly reliability: TemplateReliability;
}

export interface TemplateReliability {
  readonly completedRuns: number;
  readonly admittedRuns: number;
  readonly failedRuns: number;
  readonly planAdmissionFailureRate: number;
  readonly assessmentFailureRate: number;
  readonly repairRate: number;
  readonly avgPlannerSavedMs: number;
  readonly updatedAt: string;
}

export interface PlanStepSkeleton {
  readonly id: string;
  readonly role: OutcomeLeafRole;
  readonly operationRef: string;
  readonly dependsOn: readonly string[];
  readonly inputBindings: Readonly<Record<string, string>>;
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
  readonly producedEvidenceKinds: readonly EvidenceKind[];
  readonly requiredCapabilities: readonly string[];
  readonly skillRoleHints: readonly string[];
  readonly objective?: string;
}

export interface PlanTemplateExample {
  readonly id: string;
  readonly templateId: string;
  readonly runId: string;
  readonly exampleType: "positive" | "negative";
  readonly taskTextHash: string;
  readonly taskFingerprint: TaskFingerprint;
  readonly outcomeStatus: string;
  readonly evidenceSummary: unknown;
  readonly createdAt: string;
}

export interface PlanTemplateMatch {
  readonly id: string;
  readonly runId: string;
  readonly templateId?: string;
  readonly taskFingerprint: TaskFingerprint;
  readonly score?: number;
  readonly decision: "observed" | "direct_use" | "planner_context" | "rejected";
  readonly rejectionReasons: readonly string[];
  readonly admissionResult?: unknown;
  readonly outcomeStatus?: string;
  readonly createdAt: string;
}

export interface TemplateMiningResult {
  readonly scannedMatches: number;
  readonly eligibleExamples: number;
  readonly candidateTemplatesCreated: number;
  readonly candidateTemplatesUpdated: number;
  readonly skippedMatches: readonly {
    readonly runId: string;
    readonly reason: string;
  }[];
}

export interface PlanTemplateManagementApi {
  runMiner(): Promise<TemplateMiningResult>;
  listTemplates(filter?: { readonly status?: PlanTemplate["status"] }): Promise<readonly PlanTemplate[]>;
  getTemplate(id: string): Promise<PlanTemplate | null>;
  approveTemplate(id: string): Promise<PlanTemplate>;
  retireTemplate(id: string): Promise<PlanTemplate>;
}

export interface PlanTemplateOutcome {
  readonly runId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly planId?: string;
  readonly reasonCode?: string;
  readonly output?: string;
  readonly recordedAt: string;
}

export interface TemplateMatchCandidate {
  readonly template: PlanTemplate;
  readonly score: number;
  readonly rejectionReasons: readonly string[];
}

export type TemplateMatchDecision =
  | {
      readonly kind: "rejected";
      readonly fingerprint: TaskFingerprint;
      readonly rejectionReasons: readonly string[];
      readonly score?: number;
      readonly template?: PlanTemplate;
    }
  | {
      readonly kind: "planner_context";
      readonly fingerprint: TaskFingerprint;
      readonly template: PlanTemplate;
      readonly score: number;
    }
  | {
      readonly kind: "direct_use";
      readonly fingerprint: TaskFingerprint;
      readonly template: PlanTemplate;
      readonly score: number;
      readonly proposal: PlanProposal;
    };

export interface PlanTemplatePluginApi {
  migrate(): Promise<void>;
  close(): Promise<void>;
  managementApi(): PlanTemplateManagementApi;
}

export type PlanTemplateShape = OutcomePlanShape;
