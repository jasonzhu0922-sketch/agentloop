import { createHash } from "node:crypto";
import { parseJsonRecord, runtimeEvidenceRecordsFromToolResult } from "./tool-result-evidence.ts";
import type { AgentLoopToolEvidence } from "./contracts.ts";
import type { DecisionBindingAssessment, SkillComplianceAssessment, ToolEvidence } from "../planning/contracts.ts";

export interface RuntimeDecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly identityRefs?: readonly string[];
}

export interface RuntimeDecisionCommit {
  readonly schema: "agentloop.runtimeDecisionCommit/v1";
  readonly id: string;
  readonly requestId: string;
  readonly requestRevision: number;
  readonly planId?: string;
  readonly stepId?: string;
  readonly mode: "exact" | "advisory";
  readonly satisfaction: "required" | "optional";
  readonly selectedOptions: readonly RuntimeDecisionOption[];
  readonly hash: string;
}

export interface RuntimeDecisionClaim {
  readonly schema: "agentloop.runtimeDecisionClaim/v1";
  readonly status: "satisfied" | "conflict" | "unresolved";
  readonly identityRefs?: readonly string[];
  readonly selectedOptionIds?: readonly string[];
}

export function createDecisionCommit(input: {
  readonly requestId: string;
  readonly requestRevision: number;
  readonly planId?: string;
  readonly stepId?: string;
  readonly mode?: "exact" | "advisory";
  readonly satisfaction?: "required" | "optional";
  readonly selectedOptions: readonly RuntimeDecisionOption[];
}): RuntimeDecisionCommit {
  const canonical = JSON.stringify({
    requestId: input.requestId,
    requestRevision: input.requestRevision,
    planId: input.planId,
    stepId: input.stepId,
    mode: input.mode ?? "exact",
    satisfaction: input.satisfaction ?? "required",
    selectedOptions: input.selectedOptions,
  });
  return {
    schema: "agentloop.runtimeDecisionCommit/v1",
    id: `decision:${input.requestId}:${input.requestRevision}`,
    requestId: input.requestId,
    requestRevision: input.requestRevision,
    ...(input.planId === undefined ? {} : { planId: input.planId }),
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    mode: input.mode ?? "exact",
    satisfaction: input.satisfaction ?? "required",
    selectedOptions: input.selectedOptions,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function decisionCommitsFromEvents(events: readonly { readonly type: string; readonly data: Record<string, unknown> }[]): RuntimeDecisionCommit[] {
  return events.flatMap((event) => event.type === "decision.committed" && isCommit(event.data.commit)
    ? [event.data.commit]
    : []);
}

export function decisionClaimsFromEvidence(evidence: readonly AgentLoopToolEvidence[]): RuntimeDecisionClaim[] {
  const claims: RuntimeDecisionClaim[] = [];
  for (const item of evidence) {
    if (item.isError) continue;
    for (const record of runtimeEvidenceRecordsFromToolResult(item.result)) {
      const direct = parseJsonRecord(record.decisionClaim);
      if (direct !== undefined && isClaim(direct)) claims.push(direct);
      const claimsValue = record.decisionClaims;
      if (Array.isArray(claimsValue)) {
        for (const value of claimsValue) {
          const claim = parseJsonRecord(value);
          if (claim !== undefined && isClaim(claim)) claims.push(claim);
        }
      }
    }
  }
  return claims;
}

export function decisionSatisfied(commit: RuntimeDecisionCommit, claims: readonly RuntimeDecisionClaim[]): boolean {
  if (commit.mode !== "exact" || commit.satisfaction !== "required") return true;
  const selectedIds = new Set(commit.selectedOptions.map((option) => option.id));
  const selectedRefs = new Set(commit.selectedOptions.flatMap((option) => option.identityRefs ?? []));
  return claims.some((claim) => {
    if (claim.status !== "satisfied") return false;
    if (claim.selectedOptionIds?.some((id) => selectedIds.has(id))) return true;
    return claim.identityRefs?.some((ref) => selectedRefs.has(ref)) === true;
  });
}

/**
 * Decision commitments are assessment input, not a second TerminalCommitter
 * policy.  Missing provenance is an honest `unverified` observation; only a
 * demonstrated conflict can block a risk-sensitive step.
 */
export function assessDecisionBindings(input: {
  readonly assessment: SkillComplianceAssessment;
  readonly planId: string;
  readonly stepId: string;
  readonly ledger: readonly RuntimeDecisionCommit[];
  readonly evidence: readonly ToolEvidence[];
}): SkillComplianceAssessment {
  const required = input.ledger.filter((commit) =>
    commit.mode === "exact"
    && commit.satisfaction === "required"
    && (commit.planId === undefined || commit.planId === input.planId)
    && (commit.stepId === undefined || commit.stepId === input.stepId),
  );
  if (required.length === 0) return input.assessment;
  const claims = decisionClaimsFromEvidence(input.evidence);
  const bindings = required.map((commit) => assessBinding(commit, claims, input.assessment.assessmentProfile));
  const blockingConflict = bindings.some((binding) => binding.blocking && binding.status === "conflict");
  const observations = bindings
    .filter((binding) => binding.status !== "satisfied")
    .map((binding) => `${binding.decisionId}: ${binding.rationale}`);
  return {
    ...input.assessment,
    decisionBindings: bindings,
    approved: input.assessment.approved && !blockingConflict,
    evidenceDigest: createHash("sha256")
      .update(`${input.assessment.evidenceDigest}:${bindings.map((binding) => `${binding.decisionId}:${binding.status}`).join(",")}`)
      .digest("hex"),
    feedback: observations.length === 0
      ? input.assessment.feedback
      : [input.assessment.feedback, `Decision-binding observations: ${observations.join(" ")}`].filter(Boolean).join("\n"),
    ...(blockingConflict
      ? {
        failedBoundary: {
          stepId: input.stepId,
          missingEvidenceKinds: [],
          violatedSkillRequirements: ["decision_binding_conflict"],
          reusableEvidenceRefs: bindings.flatMap((binding) => binding.evidenceRefs),
          suggestedRepairShape: "ask_user" as const,
        },
      }
      : {}),
  };
}

function assessBinding(
  commit: RuntimeDecisionCommit,
  claims: readonly RuntimeDecisionClaim[],
  profile: SkillComplianceAssessment["assessmentProfile"],
): DecisionBindingAssessment {
  const blocking = profile === "risk_sensitive";
  if (decisionSatisfied(commit, claims)) {
    return {
      decisionId: commit.id, status: "satisfied", blocking,
      rationale: "Observable evidence matches the committed user decision.", evidenceRefs: [commit.id],
    };
  }
  const selectedIds = new Set(commit.selectedOptions.map((option) => option.id));
  const selectedRefs = new Set(commit.selectedOptions.flatMap((option) => option.identityRefs ?? []));
  const conflicting = claims.some((claim) => {
    if (claim.status === "conflict") return true;
    if (claim.status !== "satisfied") return false;
    const claimedIds = claim.selectedOptionIds ?? [];
    const claimedRefs = claim.identityRefs ?? [];
    return (claimedIds.length > 0 && !claimedIds.some((id) => selectedIds.has(id)))
      || (claimedRefs.length > 0 && !claimedRefs.some((ref) => selectedRefs.has(ref)));
  });
  return {
    decisionId: commit.id,
    status: conflicting ? "conflict" : "unverified",
    blocking,
    rationale: conflicting
      ? "Observable evidence conflicts with the committed user decision."
      : "No observable evidence independently confirms the committed user decision.",
    evidenceRefs: [commit.id],
  };
}

function isCommit(value: unknown): value is RuntimeDecisionCommit {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === "agentloop.runtimeDecisionCommit/v1";
}

function isClaim(value: unknown): value is RuntimeDecisionClaim {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === "agentloop.runtimeDecisionClaim/v1"
    && (["satisfied", "conflict", "unresolved"] as const).includes((value as Record<string, unknown>).status as "satisfied" | "conflict" | "unresolved");
}
