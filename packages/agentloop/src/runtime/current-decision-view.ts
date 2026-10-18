import { createHash } from "node:crypto";
import type { CanonicalRunStateRef } from "./canonical-run-state.ts";
import type { ContentReference } from "./content-reference.ts";
import type { AgentLoopToolEvidence } from "./contracts.ts";
import type { StepSemanticFrame } from "./step-semantic-frame.ts";
import type { RuntimeStepEvidenceState } from "./tool-progress-policy.ts";
import type { WorkProductObservationState } from "./work-product-observations.ts";
import type { WorkProductSemantics } from "./work-product-semantics.ts";
import type { WorkProductDeliveryTarget } from "./work-product-semantics.ts";
import { parseJsonRecord } from "./tool-result-evidence.ts";

/**
 * The immutable context needed to identify one admitted Step. It deliberately
 * references CanonicalRunState; it is not a second mutable Run state.
 */
export interface CurrentDecisionContext {
  readonly canonicalState: CanonicalRunStateRef;
  readonly plan: { readonly id: string; readonly version: number };
  readonly stepId: string;
}

export interface WorkProductDiagnosticFact {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly diagnosticPreview: string;
}

/** Complete facts, derived from committed events before any prompt truncation. */
export interface CurrentDecisionWorkProductFacts {
  readonly observations: WorkProductObservationState;
  readonly semantics: WorkProductSemantics;
  readonly diagnostics: readonly WorkProductDiagnosticFact[];
  readonly admittedDeliveryTargets?: readonly WorkProductDeliveryTarget[];
  readonly fullStateRef?: ContentReference;
}

export type CurrentDiagnosticApplicability = "current" | "historical" | "unknown";

export interface CurrentDecisionView {
  readonly schema: "agentloop.currentDecisionView/v1";
  readonly identity: {
    readonly runId: string;
    readonly stepId: string;
    readonly planId?: string;
    readonly planVersion?: number;
    readonly canonicalState?: CanonicalRunStateRef;
    readonly eventWatermark: number | null;
    readonly reducerVersion: "v1";
    /** Includes audit revisions and event watermark; useful for traceability. */
    readonly viewId: string;
    /** Excludes assessment bookkeeping and irrelevant event order. */
    readonly decisionBasisDigest: string;
  };
  readonly contract: {
    readonly phaseRole?: StepSemanticFrame["phaseRole"];
    readonly evidenceMode?: StepSemanticFrame["evidenceMode"];
    readonly completionBoundary: readonly string[];
  };
  readonly evidence?: RuntimeStepEvidenceState;
  readonly workProducts: {
    readonly objects: readonly {
      readonly path: string;
      readonly presence: "present" | "deleted" | "unknown";
      readonly currentVersionId?: string;
      readonly bytes?: number;
      readonly sha256?: string;
      readonly observedBy?: string;
      readonly role: string;
      readonly checks: readonly { readonly id: string; readonly status: string; readonly binding: "current" | "historical" | "unknown" }[];
    }[];
    readonly issues: readonly {
      readonly issueId?: string;
      readonly path: string;
      readonly versionId: string;
      readonly applicability: "current" | "historical";
      readonly claimedStatus?: "open" | "resolved";
      readonly resolutionSupport: "none" | "successful_operation" | "version_scoped_check";
      readonly pendingActions: readonly string[];
      readonly evidenceToolCallIds: readonly string[];
    }[];
    readonly diagnostics: readonly (WorkProductDiagnosticFact & {
      readonly applicability: CurrentDiagnosticApplicability;
      readonly binding: "declared_version" | "unbound";
    })[];
    readonly deliveryTargets: readonly {
      readonly targetId: string;
      readonly deliveryTargetId: string;
      readonly purpose: string;
      readonly kind: string;
      readonly format?: string;
      readonly path: string;
      readonly versionId: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly observedByToolCallId: string;
    }[];
    readonly rejectedDeclarationCount: number;
    readonly fullStateRef?: ContentReference;
  };
  readonly currentGap: {
    readonly missingRequiredEvidenceKinds: readonly string[];
    readonly missingToolEvidenceKinds: readonly string[];
    readonly failedEvidenceKinds: readonly string[];
  };
  /** Semantic direction only; it never narrows the Run capability grant. */
  readonly nextAction: string;
}

/** Model-safe projection. Its truncation never changes the full view or basis digest. */
export interface CurrentDecisionViewProjection {
  readonly schema: "agentloop.currentDecisionViewProjection/v1";
  readonly identity: CurrentDecisionView["identity"];
  readonly contract: CurrentDecisionView["contract"];
  readonly evidence?: {
    readonly requiredEvidenceKinds: readonly string[];
    readonly satisfiedEvidenceKinds: readonly string[];
    readonly caveatedEvidenceKinds: readonly string[];
    readonly failedEvidenceKinds: readonly string[];
    readonly missingRequiredEvidenceKinds: readonly string[];
    readonly pendingCandidateEvidenceKinds: readonly string[];
    readonly missingToolEvidenceKinds: readonly string[];
    readonly workProduct: RuntimeStepEvidenceState["workProduct"];
    readonly nextAction: RuntimeStepEvidenceState["nextAction"];
    readonly evidenceProducingToolNames: readonly string[];
    readonly exploratoryToolNames: readonly string[];
    readonly requiredWorkflowAction?: RuntimeStepEvidenceState["requiredWorkflowAction"];
  };
  readonly workProducts: {
    readonly currentObjects: readonly CurrentDecisionView["workProducts"]["objects"][number][];
    readonly currentIssues: readonly CurrentDecisionView["workProducts"]["issues"][number][];
    readonly diagnostics: readonly CurrentDecisionView["workProducts"]["diagnostics"][number][];
    readonly deliveryTargets: readonly CurrentDecisionView["workProducts"]["deliveryTargets"][number][];
    readonly counts: { readonly objects: number; readonly issues: number; readonly diagnostics: number; readonly rejectedDeclarations: number };
    readonly omitted: { readonly objects: number; readonly issues: number; readonly diagnostics: number };
    readonly fullStateRef?: ContentReference;
  };
  readonly currentGap: CurrentDecisionView["currentGap"];
  readonly nextAction: string;
  readonly instruction: string;
}

export function deriveCurrentDecisionView(input: {
  readonly runId: string;
  readonly context?: CurrentDecisionContext;
  readonly stepSemanticFrame?: Pick<StepSemanticFrame, "phaseRole" | "evidenceMode" | "completionBoundary">;
  readonly evidence?: RuntimeStepEvidenceState;
  /**
   * Committed Tool facts are part of the decision basis even when no progress
   * policy currently classifies them. This is a set of facts, not a call
   * counter: an identical repeated observation does not manufacture progress.
   */
  readonly toolEvidence?: readonly AgentLoopToolEvidence[];
  readonly workProducts?: CurrentDecisionWorkProductFacts;
}): CurrentDecisionView {
  const objects = input.workProducts === undefined ? [] : currentObjects(input.workProducts);
  const issues = input.workProducts?.semantics.issues ?? [];
  const issueByEvidence = new Map<string, (typeof issues)[number]>();
  for (const issue of issues) {
    for (const toolCallId of issue.evidenceToolCallIds) issueByEvidence.set(toolCallId, issue);
  }
  const diagnostics = (input.workProducts?.diagnostics ?? []).map((diagnostic) => {
    const issue = issueByEvidence.get(diagnostic.toolCallId);
    return {
      ...diagnostic,
      applicability: issue?.applicability ?? "unknown" as CurrentDiagnosticApplicability,
      binding: issue === undefined ? "unbound" as const : "declared_version" as const,
    };
  });
  const contract = {
    ...(input.stepSemanticFrame?.phaseRole === undefined ? {} : { phaseRole: input.stepSemanticFrame.phaseRole }),
    ...(input.stepSemanticFrame?.evidenceMode === undefined ? {} : { evidenceMode: input.stepSemanticFrame.evidenceMode }),
    completionBoundary: input.stepSemanticFrame?.completionBoundary ?? [],
  };
  const basis = {
    runId: input.runId,
    stepId: input.context?.stepId ?? "unknown",
    plan: input.context?.plan,
    contract,
    evidence: evidenceBasis(input.evidence),
    toolFacts: decisionToolFacts(input.toolEvidence),
    objects: objects.map((object) => ({ path: object.path, presence: object.presence, currentVersionId: object.currentVersionId,
      sha256: object.sha256, checks: object.checks })),
    issues: issues.map((issue) => ({ id: issue.issueId, path: issue.path, versionId: issue.versionId,
      applicability: issue.applicability, claimedStatus: issue.claimedStatus, resolutionSupport: issue.resolutionSupport,
      pendingActions: issue.pendingActions, evidenceToolCallIds: issue.evidenceToolCallIds })),
    diagnostics: diagnostics.map(({ toolCallId, applicability, binding }) => ({ toolCallId, applicability, binding })),
    deliveryTargets: deliveryTargetView(input.workProducts),
  };
  const decisionBasisDigest = digest(basis);
  const eventWatermark = input.workProducts?.observations.throughSeq ?? null;
  const identity = {
    runId: input.runId,
    stepId: basis.stepId,
    ...(input.context === undefined ? {} : { planId: input.context.plan.id, planVersion: input.context.plan.version,
      canonicalState: input.context.canonicalState }),
    eventWatermark,
    reducerVersion: "v1" as const,
    decisionBasisDigest,
    viewId: digest({ decisionBasisDigest, eventWatermark, canonicalState: input.context?.canonicalState }),
  };
  const evidence = input.evidence;
  return {
    schema: "agentloop.currentDecisionView/v1",
    identity,
    contract,
    ...(evidence === undefined ? {} : { evidence }),
    workProducts: {
      objects,
      issues: issues.map((issue) => ({ issueId: issue.issueId, path: issue.path, versionId: issue.versionId,
        applicability: issue.applicability, claimedStatus: issue.claimedStatus, resolutionSupport: issue.resolutionSupport,
        pendingActions: issue.pendingActions, evidenceToolCallIds: issue.evidenceToolCallIds })),
      diagnostics,
      deliveryTargets: deliveryTargetView(input.workProducts),
      rejectedDeclarationCount: input.workProducts?.semantics.rejected.length ?? 0,
      ...(input.workProducts?.fullStateRef === undefined ? {} : { fullStateRef: input.workProducts.fullStateRef }),
    },
    currentGap: {
      missingRequiredEvidenceKinds: evidence?.missingRequiredEvidenceKinds ?? [],
      missingToolEvidenceKinds: evidence?.missingToolEvidenceKinds ?? [],
      failedEvidenceKinds: evidence?.failedEvidenceKinds ?? [],
    },
    nextAction: evidence?.nextAction ?? input.stepSemanticFrame?.phaseRole ?? "inspect_current_state",
  };
}

export function projectCurrentDecisionView(view: CurrentDecisionView): CurrentDecisionViewProjection {
  const currentObjects = view.workProducts.objects.filter((object) => object.presence === "present");
  const currentIssues = view.workProducts.issues.filter((issue) => issue.applicability === "current");
  const diagnostics = view.workProducts.diagnostics.filter((diagnostic) => diagnostic.applicability !== "historical");
  const objects = currentObjects.slice(0, 12);
  const issues = currentIssues.slice(0, 6);
  const displayedDiagnostics = diagnostics.slice(0, 6);
  return {
    schema: "agentloop.currentDecisionViewProjection/v1",
    identity: view.identity,
    contract: view.contract,
    ...(view.evidence === undefined ? {} : { evidence: {
      requiredEvidenceKinds: view.evidence.requiredEvidenceKinds,
      satisfiedEvidenceKinds: view.evidence.satisfiedEvidenceKinds,
      caveatedEvidenceKinds: view.evidence.caveatedEvidenceKinds,
      failedEvidenceKinds: view.evidence.failedEvidenceKinds,
      missingRequiredEvidenceKinds: view.evidence.missingRequiredEvidenceKinds,
      pendingCandidateEvidenceKinds: view.evidence.pendingCandidateEvidenceKinds,
      missingToolEvidenceKinds: view.evidence.missingToolEvidenceKinds,
      workProduct: view.evidence.workProduct,
      nextAction: view.evidence.nextAction,
      evidenceProducingToolNames: view.evidence.evidenceProducingToolNames,
      exploratoryToolNames: view.evidence.exploratoryToolNames,
      ...(view.evidence.requiredWorkflowAction === undefined ? {} : { requiredWorkflowAction: view.evidence.requiredWorkflowAction }),
    } }),
    workProducts: {
      currentObjects: objects,
      currentIssues: issues,
      diagnostics: displayedDiagnostics,
      deliveryTargets: view.workProducts.deliveryTargets,
      counts: { objects: currentObjects.length, issues: currentIssues.length, diagnostics: diagnostics.length,
        rejectedDeclarations: view.workProducts.rejectedDeclarationCount },
      omitted: { objects: currentObjects.length - objects.length, issues: currentIssues.length - issues.length,
        diagnostics: diagnostics.length - displayedDiagnostics.length },
      ...(view.workProducts.fullStateRef === undefined ? {} : { fullStateRef: view.workProducts.fullStateRef }),
    },
    currentGap: view.currentGap,
    nextAction: view.nextAction,
    instruction: "Treat nextAction and currentGap as Runtime-derived state. Historical diagnostics are audit material, not current blockers; an unbound diagnostic is not proof that the current object version is faulty.",
  };
}

function currentObjects(facts: CurrentDecisionWorkProductFacts): CurrentDecisionView["workProducts"]["objects"] {
  const roles = new Map(facts.semantics.roles.map((role) => [role.path, role]));
  return facts.observations.objects.map((object) => {
    const version = object.versions.find((candidate) => candidate.id === object.currentVersionId);
    const observation = facts.observations.observations.find((candidate) => candidate.id === version?.observationIds.at(-1));
    return {
      path: object.path,
      presence: object.presence,
      ...(object.currentVersionId === undefined ? {} : { currentVersionId: object.currentVersionId }),
      ...(version?.bytes === undefined ? {} : { bytes: version.bytes }),
      ...(version?.sha256 === undefined ? {} : { sha256: version.sha256 }),
      ...(observation === undefined ? {} : { observedBy: observation.source.toolCallId }),
      role: roles.get(object.path)?.role ?? "unknown",
      checks: object.checks.map((check) => ({ id: check.id, status: check.status, binding: check.binding })),
    };
  }).sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function deliveryTargetView(facts: CurrentDecisionWorkProductFacts | undefined): CurrentDecisionView["workProducts"]["deliveryTargets"] {
  if (facts === undefined) return [];
  const bindings = new Map((facts.semantics.deliveryTargets ?? []).map((binding) => [binding.targetId, binding]));
  return (facts.admittedDeliveryTargets ?? []).map((target) => {
    const binding = bindings.get(target.targetId);
    return {
      targetId: target.targetId,
      deliveryTargetId: target.deliveryTargetId ?? target.targetId,
      purpose: target.purpose,
      kind: target.kind,
      ...(target.format === undefined ? {} : { format: target.format }),
      path: binding?.path ?? "",
      versionId: binding?.versionId ?? "",
      bytes: binding?.bytes ?? 0,
      sha256: binding?.sha256 ?? "",
      observedByToolCallId: binding?.observedByToolCallId ?? "",
    };
  });
}

function evidenceBasis(evidence: RuntimeStepEvidenceState | undefined): unknown {
  if (evidence === undefined) return undefined;
  return {
    required: evidence.requiredEvidenceKinds,
    satisfied: evidence.satisfiedEvidenceKinds,
    caveated: evidence.caveatedEvidenceKinds,
    failed: evidence.failedEvidenceKinds,
    missing: evidence.missingRequiredEvidenceKinds,
    missingTool: evidence.missingToolEvidenceKinds,
    nextAction: evidence.nextAction,
    workProduct: evidence.workProduct,
  };
}

/**
 * Reduce committed operations to their semantic outcome. Deliberately omit the
 * call id and retain unique normalized facts: retrying the exact same result
 * is not a decision-basis transition, while a new observed result is.
 */
function decisionToolFacts(evidence: readonly AgentLoopToolEvidence[] | undefined): readonly Record<string, unknown>[] {
  if (evidence === undefined) return [];
  const facts = evidence.map((item) => ({
    toolName: item.toolName,
    invocationStatus: item.invocationStatus ?? "completed",
    operationStatus: item.operationStatus ?? "unknown",
    isError: item.isError,
    ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    ...(item.failurePhase === undefined ? {} : { failurePhase: item.failurePhase }),
    resultSha256: digest(decisionResultContent(item.result)),
  }));
  const unique = new Map(facts.map((fact) => [JSON.stringify(fact), fact]));
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, fact]) => fact);
}

function decisionResultContent(result: string): unknown {
  const value = parseJsonRecord(result);
  if (value === undefined) return result;
  // The result envelope gets a fresh publication id on replay. That id is
  // audit identity, not new source content. sourceResultRef stays intact:
  // consuming a different immutable dependency is a real decision change.
  const { resultRef: _publicationIdentity, ...content } = value;
  return content;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
