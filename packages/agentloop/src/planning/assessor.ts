import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { ModelAdapter, ModelInvocation, RuntimeContextSnapshot, RuntimeDeliveryCandidate, RuntimeEventSink } from "../runtime/contracts.ts";
import { buildDynamicSystemPrompt, buildTaskProfile, formatDynamicPromptContext, type TaskProfile } from "../runtime/dynamic-prompt.ts";
import { completeWithStreaming } from "../runtime/model-streaming.ts";
import { classifyTaskIntent } from "../runtime/task-intent.ts";
import { isTextToolInvocation } from "../runtime/text-tool-invocation.ts";
import { deliveryCandidateCaveats } from "../runtime/delivery-candidate.ts";
import { artifactMatchesExpectedKind } from "../runtime/tool-progress-policy.ts";
import {
  canonicalArtifactAcceptanceVerdict,
  parseJsonRecord,
  runtimeEvidenceKindArrays,
  runtimeEvidenceRecordsFromToolResult,
} from "../runtime/tool-result-evidence.ts";
import type {
  AssessmentMethod,
  AssessmentProfileId,
  CriterionAssessment,
  FailedBoundary,
  SkillAssessment,
  SkillComplianceAssessment,
  StepAssessmentInput,
  StepAssessor,
  StepEvidence,
  SuggestedRepairShape,
} from "./contracts.ts";
import { stepHasSourceKind, stepResolvedToolNames } from "./step-execution-binding.ts";

const SUBMIT_ASSESSMENT_TOOL = {
  name: "submit_assessment",
  description: "Submit a criterion-by-criterion completion assessment and non-blocking applied-Skill QA observations.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["criteria", "skills", "feedback"],
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterionId", "satisfied", "rationale", "evidenceRefs"],
          properties: {
            criterionId: { type: "string" },
            satisfied: { type: "boolean" },
            rationale: { type: "string" },
            evidenceRefs: { type: "array", items: { type: "string" } },
          },
        },
      },
      skills: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["skillId", "followed", "rationale", "evidenceRefs"],
          properties: {
            skillId: { type: "string" },
            status: { type: "string", enum: ["followed", "skipped_unavailable", "process_caveat", "not_followed", "not_assessed"] },
            followed: { type: "boolean" },
            rationale: { type: "string" },
            evidenceRefs: { type: "array", items: { type: "string" } },
          },
        },
      },
      feedback: { type: "string" },
      failedBoundary: {
        type: "object",
        additionalProperties: false,
        required: [
          "stepId",
          "missingEvidenceKinds",
          "violatedSkillRequirements",
          "reusableEvidenceRefs",
          "suggestedRepairShape",
        ],
        properties: {
          stepId: { type: "string" },
          missingEvidenceKinds: { type: "array", items: { type: "string" } },
          violatedSkillRequirements: { type: "array", items: { type: "string" } },
          reusableEvidenceRefs: { type: "array", items: { type: "string" } },
          suggestedRepairShape: { type: "string", enum: ["repair_leaf", "revise_plan", "ask_user", "fail"] },
        },
      },
    },
  },
} as const;

const MAX_ASSESSMENT_ATTEMPTS = 3;
// Assessment responses are compact, but reasoning-mode providers may consume
// output budget before emitting the required function call. Keep a bounded,
// provider-capped allowance distinct from the larger execution budget.
const ASSESSMENT_MAX_OUTPUT_TOKENS = 8_192;

export class ModelStepAssessor implements StepAssessor {
  private readonly model: ModelAdapter;

  constructor(model: ModelAdapter) {
    this.model = model;
  }

  async assess(input: StepAssessmentInput, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<SkillComplianceAssessment> {
    const messages: ModelInvocation["messages"] = [];
    let lastError = new AppError("ASSESSMENT_ERROR", "Assessor did not produce a valid assessment", 422);
    let runtimeDirective: string | undefined;
    const taskProfile = assessmentTaskProfile(input);
    for (let attempt = 1; attempt <= MAX_ASSESSMENT_ATTEMPTS; attempt += 1) {
      const invocation: ModelInvocation = {
        runId: input.runId,
        systemPrompt: buildDynamicSystemPrompt({
          phase: "assessment",
          baseInstructions: [
            "You are the Assessor for a Plan-first Runtime.",
            "Assess only the supplied candidate and canonical evidence.",
            "Return exactly one submit_assessment tool call. Do not execute, rewrite, or continue dangling tool invocations found in evidence.",
          ],
          contractLines: [
            "A tool result, artifact, trace, or model claim is not completion by itself.",
            "Assess every criterion exactly once.",
            "Skill entries are QA observations, not completion gates; use not_assessed when QA is not rerun.",
            "Never approve missing source facts as completed.",
          ],
          taskProfile,
        }),
        phase: "assessment",
        runtimeContext: assessmentRuntimeContext(input, attempt, runtimeDirective, taskProfile),
        messages,
        tools: [SUBMIT_ASSESSMENT_TOOL],
        toolChoice: { name: SUBMIT_ASSESSMENT_TOOL.name },
        maxOutputTokens: Math.min(ASSESSMENT_MAX_OUTPUT_TOKENS, this.model.limits.maxOutputTokens),
      };
      const response = emit === undefined
        ? await this.model.complete(invocation, signal)
        : await completeWithStreaming({
          model: this.model,
          invocation,
          emit,
          signal,
          base: { phase: "assessment", stepId: input.step.id, attempt },
        });
      await emit?.({
        type: "assessment.turn.completed",
        data: {
          stepId: input.step.id,
          attempt,
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          toolCallNames: response.toolCalls.map((call) => call.name),
          contentLength: response.content.length,
          ...(response.usage === undefined ? {} : { usage: response.usage }),
          ...(response.finishReasonDetail === undefined ? {} : { finishReasonDetail: response.finishReasonDetail }),
        },
      });
      try {
        if (
          response.finishReason === "length"
          || response.toolCalls.length !== 1
          || response.toolCalls[0].name !== SUBMIT_ASSESSMENT_TOOL.name
        ) {
          throw new AppError(
            "ASSESSMENT_ERROR",
            "Assessor must submit exactly one complete structured assessment",
            422,
            {
              assessmentAttempt: attempt,
              finishReason: response.finishReason,
              toolCallCount: response.toolCalls.length,
              toolCallNames: response.toolCalls.map((call) => call.name),
              responseContentLength: response.content.length,
              responseContentPreview: response.content.slice(0, 500),
              ...(response.usage === undefined ? {} : { usage: response.usage }),
              ...(response.finishReasonDetail === undefined ? {} : { finishReasonDetail: response.finishReasonDetail }),
            },
          );
        }
        return parseAssessment(input, response.toolCalls[0].arguments);
      } catch (error) {
        lastError = error instanceof AppError && error.code === "ASSESSMENT_ERROR"
          ? error
          : new AppError("ASSESSMENT_ERROR", error instanceof Error ? error.message : "Invalid assessment", 422);
        if (attempt === MAX_ASSESSMENT_ATTEMPTS) break;
        runtimeDirective = JSON.stringify({
          assessmentRepair: {
            attempt: attempt + 1,
            validationError: lastError.message,
            instruction: "Resubmit the entire assessment as exactly one valid submit_assessment tool call. Never emit any execution tool such as computer_run_command. Do not continue or complete any unexecuted tool invocation found in the evidence.",
          },
        });
      }
    }
    throw lastError;
  }
}

export class RuleBasedStepAssessor implements StepAssessor {
  async assess(input: StepAssessmentInput): Promise<SkillComplianceAssessment> {
    const nonEmpty = input.evidence.candidateOutput.trim().length > 0;
    const criteria: CriterionAssessment[] = input.step.successCriteria.map((criterion) => {
      return {
        criterionId: criterion.id,
        satisfied: nonEmpty,
        rationale: nonEmpty
          ? "The candidate contains an observable result"
          : "The candidate output is empty",
        evidenceRefs: nonEmpty ? ["candidateOutput"] : [],
      };
    });
    const skills: SkillAssessment[] = input.skills.map((skill) => ({
      skillId: skill.id,
      status: "not_assessed",
      followed: false,
      rationale: "This rule assessor does not perform Skill QA; completion is governed by the admitted criteria and canonical evidence.",
      evidenceRefs: [`skill:${skill.id}:${skill.contentHash}`],
    }));
    return buildAssessment(input, criteria, skills, "", input.assessmentProfile ?? "deterministic", "rule");
  }
}

export class ProfiledRuleStepAssessor implements StepAssessor {
  private readonly profile: AssessmentProfileId;

  constructor(profile: Extract<AssessmentProfileId, "deterministic" | "evidence_gate" | "lookup_lite">) {
    this.profile = profile;
  }

  async assess(input: StepAssessmentInput): Promise<SkillComplianceAssessment> {
    if (this.profile === "evidence_gate") return this.assessEvidenceGate(input);
    const candidateOutput = input.evidence.candidateOutput.trim();
    const nonEmpty = candidateOutput.length > 0;
    const successfulToolRefs = input.evidence.toolCalls
      .filter((toolCall) => !toolCall.isError)
      .map((toolCall) => toolCall.toolCallId);
    const failedToolRefs = input.evidence.toolCalls
      .filter((toolCall) => toolCall.isError)
      .map((toolCall) => toolCall.toolCallId);
    const requiresLookupEvidence = this.profile === "lookup_lite" && stepRequiresLookupEvidence(input);
    const hasLookupEvidence = successfulToolRefs.length > 0;
    const criteria: CriterionAssessment[] = input.step.successCriteria.map((criterion) => {
      const satisfied = nonEmpty
        && (!requiresLookupEvidence || hasLookupEvidence)
        && (failedToolRefs.length === 0 || hasLookupEvidence);
      return {
        criterionId: criterion.id,
        satisfied,
        rationale: satisfied
          ? this.approvedRationale(hasLookupEvidence)
          : this.rejectedRationale(nonEmpty, requiresLookupEvidence, hasLookupEvidence, failedToolRefs),
        evidenceRefs: satisfied
          ? (hasLookupEvidence ? ["candidateOutput", ...successfulToolRefs] : ["candidateOutput"])
          : failedToolRefs,
      };
    });
    const skills: SkillAssessment[] = input.skills.map((skill) => ({
      skillId: skill.id,
      status: "not_assessed",
      followed: false,
      rationale: "Profiled rule assessment does not reperform Skill QA; completion is governed by the admitted criteria and lookup evidence.",
      evidenceRefs: [`skill:${skill.id}:${skill.contentHash}`],
    }));
    const feedback = criteria.every((criterion) => criterion.satisfied)
      ? ""
      : "Completion rejected by lightweight assessment; provide the missing answer evidence or use full model assessment.";
    return buildAssessment(input, criteria, skills, feedback, this.profile, "rule");
  }

  private approvedRationale(hasLookupEvidence: boolean): string {
    if (this.profile === "lookup_lite") {
      return hasLookupEvidence
        ? "The candidate is non-empty and is backed by successful lookup tool evidence."
        : "The candidate is non-empty and this lookup step did not require external tool evidence.";
    }
    return "The deterministic candidate is non-empty and satisfies the admitted criterion.";
  }

  private rejectedRationale(
    nonEmpty: boolean,
    requiresLookupEvidence: boolean,
    hasLookupEvidence: boolean,
    failedToolRefs: readonly string[],
  ): string {
    if (!nonEmpty) return "The candidate output is empty.";
    if (requiresLookupEvidence && !hasLookupEvidence) {
      return "The lookup candidate lacks successful tool evidence.";
    }
    if (failedToolRefs.length > 0 && !hasLookupEvidence) {
      return "Only failed tool evidence is available.";
    }
    return "The candidate does not satisfy the lightweight assessment policy.";
  }

  private assessEvidenceGate(input: StepAssessmentInput): SkillComplianceAssessment {
    const candidateOutput = input.evidence.candidateOutput.trim();
    const nonEmpty = candidateOutput.length > 0;
    const deliveryCandidate = input.evidence.deliveryCandidate;
    const successfulToolRefs = input.evidence.toolCalls
      .filter((toolCall) => !toolCall.isError)
      .map((toolCall) => toolCall.toolCallId);
    const receipts = runtimeObservableReceipts(input.evidence.toolCalls);
    const requiredKinds = runtimeGateRequiredKinds(input.step.evidenceContract?.requiredKinds ?? []);
    const blockingKinds = new Set(input.step.successCriteria
      .filter((criterion) => criterion.blocking !== false)
      .map((criterion) => criterion.id));
    const requiredKindsSatisfied = requiredKinds
      .filter((kind) => blockingKinds.has(kind))
      .every((kind) =>
      evidenceKindSatisfiedByGate(kind, receipts, successfulToolRefs, deliveryCandidate, input.workflowEvidenceActions, input.expectedArtifactKind)
      );
    const criteria: CriterionAssessment[] = input.step.successCriteria.map((criterion) => {
      const evidenceSatisfied = criterionSatisfiedByEvidenceGate(
        criterion.id,
        requiredKinds,
        requiredKindsSatisfied,
        receipts,
        successfulToolRefs,
        deliveryCandidate,
        input.workflowEvidenceActions,
        input.expectedArtifactKind,
      );
      const candidateRequired = criterion.blocking !== false
        && !isEvidenceCriterion(criterion.id);
      const satisfied = evidenceSatisfied && (nonEmpty || !candidateRequired);
      return {
        criterionId: criterion.id,
        satisfied,
        rationale: satisfied
          ? "The completion candidate and required observable Runtime operations satisfy the principle assessment gate."
          : rejectedEvidenceGateRationale(nonEmpty, receipts,
            requiredKinds.includes(criterion.id) || criterion.id === "explicit_caveats" ? [criterion.id] : requiredKinds,
            successfulToolRefs, deliveryCandidate, candidateRequired),
        evidenceRefs: satisfied
          ? ["candidateOutput", ...successfulToolRefs, ...receipts.map((receipt) => receipt.toolCallId), ...(deliveryCandidate?.sourceToolCallIds ?? [])]
          : successfulToolRefs,
      };
    });
    const skills: SkillAssessment[] = input.skills.map((skill) => ({
      skillId: skill.id,
      status: "not_assessed",
      followed: false,
      rationale: "Runtime principle assessment does not reperform Skill QA or attest to the model's source interpretation; it only checks required observable delivery effects.",
      evidenceRefs: [`skill:${skill.id}:${skill.contentHash}`, ...receipts.map((receipt) => receipt.toolCallId)],
    }));
    const feedback = criteria.every((criterion) => criterion.satisfied)
      ? ""
      : [
        "Completion rejected by Runtime evidence assessment.",
        ...criteria.filter((criterion) => !criterion.satisfied).map((criterion) => `${criterion.criterionId}: ${criterion.rationale}`),
        "A missing observable receipt is not proof that the operation never ran. Reuse the bound operation result; if its receipt was lost, repair the evidence handoff or the Plan contract. Rewriting the answer cannot create an operation receipt.",
      ].join("\n");
    return buildAssessment(input, criteria, skills, feedback, this.profile, "rule");
  }
}

interface RuntimeObservableReceipt {
  readonly toolCallId: string;
  readonly schema: string;
  readonly verdict?: string;
  readonly artifactPath?: string;
  readonly artifactKind?: string;
  readonly satisfied: ReadonlySet<string>;
  readonly failed: ReadonlySet<string>;
  readonly caveatsRecorded: boolean;
  readonly workflowAction?: { readonly skillName: string; readonly executorId: string; readonly actionId: string };
}

/**
 * The principle gate verifies only effects that Runtime can observe without
 * interpreting the model's work. Structured source receipts establish that
 * source material was actually acquired, while the model remains responsible
 * for interpreting that material. A command-computation receipt establishes a
 * reproducible transformation over hash-bound inputs, without elevating any
 * Skill executor into a separate execution authority.
 */
const RUNTIME_OBSERVABLE_GATE_KINDS = new Set([
  "source_summary",
  "source_urls",
  "schema_summary",
  "record_counts",
  "table_coverage",
  "structured_extraction_artifact",
  "derived_aggregation",
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
  "delivery_receipt",
]);

function runtimeGateRequiredKinds(requiredKinds: readonly string[]): string[] {
  return requiredKinds.filter((kind) => RUNTIME_OBSERVABLE_GATE_KINDS.has(kind));
}

function runtimeObservableReceipts(toolCalls: readonly { toolCallId: string; toolName: string; isError: boolean; result: string }[]): RuntimeObservableReceipt[] {
  const receipts: RuntimeObservableReceipt[] = [];
  for (const toolCall of toolCalls) {
    if (toolCall.isError) continue;
    for (const parsed of runtimeEvidenceRecordsFromToolResult(toolCall.result)) {
      const workflowRecord = parsed.schema === "agentloop.skillWorkflowEvidenceReceipt/v1"
        || parseToolResultObject(parsed.workflowEvidenceReceipt)?.schema === "agentloop.skillWorkflowEvidenceReceipt/v1";
      if (workflowRecord && toolCall.toolName !== "computer_run_command") continue;
      const topLevelSchema = typeof parsed.schema === "string" ? parsed.schema : undefined;
      const nestedReceipt = parseToolResultObject(parsed.evidenceReceipt)
        ?? parseToolResultObject(parsed.artifactReceipt);
      const schema = isRuntimeEvidenceReceiptSchema(topLevelSchema)
        ? topLevelSchema
        : typeof nestedReceipt?.schema === "string" && isRuntimeEvidenceReceiptSchema(nestedReceipt.schema)
          ? nestedReceipt.schema
          : undefined;
      if (
        schema === undefined
      ) continue;
      const evidenceKinds = runtimeEvidenceKindArrays(nestedReceipt ?? parsed);
      receipts.push({
        toolCallId: toolCall.toolCallId,
        schema,
        verdict: canonicalArtifactAcceptanceVerdict(parsed),
        ...(schema === "agentloop.artifactAcceptance/v1" || schema === "agentloop.artifactReceipt/v1"
          ? {
            artifactPath: artifactPathFromRecord(nestedReceipt ?? parsed),
            artifactKind: artifactKindFromRecord(nestedReceipt ?? parsed),
          }
          : {}),
        satisfied: new Set(evidenceKinds.satisfied),
        failed: new Set(evidenceKinds.failed),
        caveatsRecorded: Array.isArray((nestedReceipt ?? parsed).caveats)
          || evidenceKinds.satisfied.includes("explicit_caveats")
          || evidenceKinds.caveated.includes("explicit_caveats"),
        ...(schema === "agentloop.skillWorkflowEvidenceReceipt/v1" && workflowActionFromRecord(parsed) !== undefined
          ? { workflowAction: workflowActionFromRecord(parsed) }
          : {}),
      });
    }
  }
  return receipts;
}

function workflowActionFromRecord(record: Record<string, unknown>): RuntimeObservableReceipt["workflowAction"] | undefined {
  const skill = parseToolResultObject(record.skill);
  if (skill === undefined) return undefined;
  const skillName = typeof skill.skillName === "string" ? skill.skillName : undefined;
  const executorId = typeof skill.executorId === "string" ? skill.executorId : undefined;
  const actionId = typeof skill.actionId === "string" ? skill.actionId : undefined;
  return skillName === undefined || executorId === undefined || actionId === undefined ? undefined : { skillName, executorId, actionId };
}

function criterionSatisfiedByEvidenceGate(
  criterionId: string,
  requiredKinds: readonly string[],
  requiredKindsSatisfied: boolean,
  receipts: readonly RuntimeObservableReceipt[],
  successfulToolRefs: readonly string[],
  candidate?: RuntimeDeliveryCandidate,
  workflowEvidenceActions?: StepAssessmentInput["workflowEvidenceActions"],
  expectedArtifactKind?: string,
): boolean {
  // Semantic caveat evidence must not inherit an unrelated source/artifact
  // failure (nor automatically pass when all other operation receipts pass).
  if (isEvidenceCriterion(criterionId)) return evidenceKindSatisfiedByGate(criterionId, receipts, successfulToolRefs, candidate, workflowEvidenceActions, expectedArtifactKind);
  if (requiredKinds.length > 0) return requiredKindsSatisfied;
  return successfulToolRefs.length > 0;
}

function evidenceKindSatisfiedByGate(
  kind: string,
  receipts: readonly RuntimeObservableReceipt[],
  successfulToolRefs: readonly string[],
  candidate?: RuntimeDeliveryCandidate,
  workflowEvidenceActions?: StepAssessmentInput["workflowEvidenceActions"],
  expectedArtifactKind?: string,
): boolean {
  if (kind === "explicit_caveats") {
    // This proves only that limitations were recorded, not that the model's
    // explanation is sufficient. A Plan requirement itself is not evidence.
    return receipts.some((receipt) => !receipt.failed.has(kind) && receipt.caveatsRecorded);
  }
  if (kind === "delivery_receipt") {
    const candidateReceipt = candidate?.deliveryReceipt !== undefined
      && successfulToolRefs.includes(candidate.deliveryReceipt.sourceToolCallId)
      && deliveryReceiptMatchesExpectedKind(candidate.deliveryReceipt, expectedArtifactKind);
    return candidateReceipt || receipts.some((receipt) =>
        (receipt.schema === "agentloop.artifactReceipt/v1" || receipt.schema === "agentloop.artifactAcceptance/v1")
        && receipt.artifactPath !== undefined
        && receiptMatchesExpectedKind(receipt, expectedArtifactKind)
        && !receipt.failed.has("artifact_path")
        && !receipt.failed.has("artifact_non_empty"),
      );
  }
  if (kind === "artifact_acceptance") {
    const acceptance = latestArtifactAcceptanceReceipt(receipts, candidate, expectedArtifactKind);
    return acceptance !== undefined
      && (
        acceptance.verdict === "accepted"
        || acceptance.verdict === "caveated"
        || acceptance.satisfied.has("artifact_acceptance")
      )
      && acceptance.failed.size === 0;
  }
  // Artifact acceptance is a Runtime-owned, aggregate observation.  A Skill
  // manifest may advertise an action that can produce an artifact fact, but
  // that declaration is a capability inventory rather than a Plan commitment
  // to that action.  Do not let it erase the neutral facts carried by an
  // accepted acceptance receipt from a custom or other authorized renderer.
  // Non-artifact workflow facts remain authenticated against their declared
  // package action below.
  if (isArtifactAcceptanceEvidenceKind(kind)) {
    const acceptance = latestArtifactAcceptanceReceipt(receipts, candidate, expectedArtifactKind);
    if (
      acceptance !== undefined
      && (acceptance.verdict === "accepted" || acceptance.verdict === "caveated")
      && acceptance.satisfied.has(kind)
      && !acceptance.failed.has(kind)
    ) return true;
    if (expectedArtifactKind !== undefined) return false;
  }
  const declaredActions = (workflowEvidenceActions ?? []).filter((action) => action.producesEvidenceKinds.includes(kind));
  if (declaredActions.length > 0) {
    return receipts.some((receipt) => !receipt.failed.has(kind)
      && receipt.schema === "agentloop.skillWorkflowEvidenceReceipt/v1"
      && receipt.satisfied.has(kind)
      && receipt.workflowAction !== undefined
      && declaredActions.some((action) => action.skillName === receipt.workflowAction!.skillName && action.executorId === receipt.workflowAction!.executorId && action.actionId === receipt.workflowAction!.actionId));
  }
  return receipts.some((receipt) => {
    if (receipt.failed.has(kind)) return false;
    return receipt.satisfied.has(kind);
  });
}

function isArtifactAcceptanceEvidenceKind(kind: string): boolean {
  return kind === "artifact_path"
    || kind === "artifact_non_empty"
    || kind === "artifact_openable"
    || kind === "format_matches_request";
}

function isRuntimeEvidenceReceiptSchema(schema: string | undefined): boolean {
  return schema === "agentloop.artifactAcceptance/v1"
    || schema === "agentloop.artifactReceipt/v1"
    || schema === "agentloop.sourceSummary/v1"
    || schema === "agentloop.toolEvidenceReceipt/v1"
    || schema === "agentloop.commandComputationReceipt/v1"
    || schema === "agentloop.skillWorkflowEvidenceReceipt/v1";
}

/**
 * An artifact can be checked repeatedly while it is repaired. A later check is
 * the authoritative observation for that artifact; retaining an earlier
 * rejection as a permanent failure strands an otherwise deliverable Run.
 */
function latestArtifactAcceptanceReceipt(
  receipts: readonly RuntimeObservableReceipt[],
  candidate?: RuntimeDeliveryCandidate,
  expectedArtifactKind?: string,
): RuntimeObservableReceipt | undefined {
  const acceptances = receipts.filter((receipt) => receipt.schema === "agentloop.artifactAcceptance/v1");
  const deliveredPath = candidate?.deliveryReceipt?.artifact.path;
  if (deliveredPath !== undefined) {
    return acceptances.filter((receipt) =>
      receipt.artifactPath === deliveredPath
      && receiptMatchesExpectedKind(receipt, expectedArtifactKind),
    ).at(-1);
  }
  return acceptances.filter((receipt) => receiptMatchesExpectedKind(receipt, expectedArtifactKind)).at(-1);
}

function artifactPathFromRecord(record: Record<string, unknown>): string | undefined {
  const artifact = record.artifact;
  if (typeof artifact === "string" && artifact.trim().length > 0) return artifact;
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return undefined;
  const path = (artifact as Record<string, unknown>).path;
  return typeof path === "string" && path.trim().length > 0 ? path : undefined;
}

function artifactKindFromRecord(record: Record<string, unknown>): string | undefined {
  const artifact = record.artifact;
  if (artifact !== null && typeof artifact === "object" && !Array.isArray(artifact)) {
    const value = artifact as Record<string, unknown>;
    if (typeof value.kind === "string" && value.kind.trim().length > 0) return value.kind;
    if (typeof value.artifactKind === "string" && value.artifactKind.trim().length > 0) return value.artifactKind;
  }
  if (typeof record.kind === "string" && record.kind.trim().length > 0) return record.kind;
  if (typeof record.artifactKind === "string" && record.artifactKind.trim().length > 0) return record.artifactKind;
  return undefined;
}

function receiptMatchesExpectedKind(
  receipt: Pick<RuntimeObservableReceipt, "artifactPath" | "artifactKind">,
  expectedArtifactKind: string | undefined,
): boolean {
  if (expectedArtifactKind === undefined) return true;
  if (receipt.artifactPath === undefined) return false;
  return artifactMatchesExpectedKind({
    path: receipt.artifactPath,
    ...(receipt.artifactKind === undefined ? {} : { artifactKind: receipt.artifactKind }),
  }, expectedArtifactKind);
}

function deliveryReceiptMatchesExpectedKind(
  receipt: NonNullable<RuntimeDeliveryCandidate["deliveryReceipt"]>,
  expectedArtifactKind: string | undefined,
): boolean {
  if (expectedArtifactKind === undefined) return true;
  return artifactMatchesExpectedKind({
    path: receipt.artifact.path,
    ...(receipt.artifact.kind === undefined ? {} : { artifactKind: receipt.artifact.kind }),
  }, expectedArtifactKind);
}

function rejectedEvidenceGateRationale(
  nonEmpty: boolean,
  receipts: readonly RuntimeObservableReceipt[],
  requiredKinds: readonly string[],
  successfulToolRefs: readonly string[],
  candidate?: RuntimeDeliveryCandidate,
  candidateRequired = true,
): string {
  if (!nonEmpty && candidateRequired) return "The candidate output is empty.";
  if (successfulToolRefs.length === 0) return "No successful Runtime operation is available.";
  if (receipts.length === 0 && requiredKinds.length > 0) return "No observable Runtime artifact or acceptance receipt is available for the principle assessment gate.";
  const missing = requiredKinds.filter((kind) => !evidenceKindSatisfiedByGate(kind, receipts, successfulToolRefs, candidate));
  if (missing.length > 0) return `No bound observable evidence confirms: ${missing.join(", ")}. This does not establish that the underlying content or operation is absent.`;
  return "The observable Runtime operations do not satisfy the principle assessment gate.";
}

function isEvidenceCriterion(criterionId: string): boolean {
  return criterionId === "explicit_caveats" || RUNTIME_OBSERVABLE_GATE_KINDS.has(criterionId);
}

function parseToolResultObject(value: unknown): Record<string, unknown> | undefined {
  return parseJsonRecord(value);
}

function parseAssessment(input: StepAssessmentInput, value: unknown): SkillComplianceAssessment {
  try {
    const record = requireRecord(value, "submit_assessment arguments");
    if (!Array.isArray(record.criteria) || !Array.isArray(record.skills)) {
      throw new TypeError("criteria and skills must be arrays");
    }
    const criteria = record.criteria.map((item, index): CriterionAssessment => {
      const row = requireRecord(item, `criteria[${index}]`);
      if (typeof row.satisfied !== "boolean") throw new TypeError(`criteria[${index}].satisfied must be boolean`);
      return {
        criterionId: requireString(row.criterionId, `criteria[${index}].criterionId`, { max: 128 }),
        satisfied: row.satisfied,
        rationale: requireString(row.rationale, `criteria[${index}].rationale`, { max: 4_000 }),
        evidenceRefs: parseEvidenceRefs(row.evidenceRefs, `criteria[${index}].evidenceRefs`, 100),
      };
    });
    const skills = record.skills.map((item, index): SkillAssessment => {
      const row = requireRecord(item, `skills[${index}]`);
      if (typeof row.followed !== "boolean") throw new TypeError(`skills[${index}].followed must be boolean`);
      const status = row.status;
      if (status !== undefined && !["followed", "skipped_unavailable", "process_caveat", "not_followed", "not_assessed"].includes(status as string)) {
        throw new TypeError(`skills[${index}].status must be followed, skipped_unavailable, process_caveat, not_followed, or not_assessed`);
      }
      return {
        skillId: requireString(row.skillId, `skills[${index}].skillId`, { max: 128 }),
        ...(status === undefined ? {} : { status: status as SkillAssessment["status"] }),
        followed: row.followed,
        rationale: requireString(row.rationale, `skills[${index}].rationale`, { max: 4_000 }),
        evidenceRefs: parseEvidenceRefs(row.evidenceRefs, `skills[${index}].evidenceRefs`, 100),
      };
    });
    assertExactIds(
      criteria.map((item) => item.criterionId),
      input.step.successCriteria.map((item) => item.id),
      "criterion",
    );
    assertExactIds(skills.map((item) => item.skillId), input.skills.map((item) => item.id), "Skill");
    const feedback = typeof record.feedback === "string" ? record.feedback.trim().slice(0, 8_000) : "";
    const failedBoundary = parseFailedBoundary(input, record.failedBoundary);
    return buildAssessment(input, criteria, skills, feedback, input.assessmentProfile ?? "source_grounded", "model", failedBoundary);
  } catch (error) {
    if (error instanceof AppError && error.code === "ASSESSMENT_ERROR") throw error;
    throw new AppError(
      "ASSESSMENT_ERROR",
      error instanceof Error ? `Invalid assessment: ${error.message}` : "Invalid assessment",
      422,
    );
  }
}

function buildAssessment(
  input: StepAssessmentInput,
  criteria: readonly CriterionAssessment[],
  skills: readonly SkillAssessment[],
  feedback: string,
  assessmentProfile: AssessmentProfileId = "source_grounded",
  assessmentMethod: AssessmentMethod = "model",
  failedBoundary?: FailedBoundary,
): SkillComplianceAssessment {
  const classifiedCriteria = criteria.map((criterion) => classifyCriterion(input, criterion));
  const hasCaveatedSkill = skills.some((item) =>
    item.status === "skipped_unavailable" || item.status === "process_caveat"
  );
  const hasUserVisibleDelivery = input.evidence.candidateOutput.trim().length > 0
    || hasArtifactDeliveryEvidence(input);
  const approved = hasUserVisibleDelivery
    && classifiedCriteria.every((item) => item.satisfied || item.blocking !== true);
  const derivedFailedBoundary = approved
    ? undefined
    : failedBoundary ?? deriveFailedBoundary(input, classifiedCriteria, skills);
  return {
    id: randomUUID(),
    planId: input.planId,
    stepId: input.step.id,
    attempt: input.attempt,
    assessmentProfile,
    assessmentMethod,
    approved,
    criteria: classifiedCriteria,
    skills,
    evidenceDigest: evidenceDigest(input.evidence),
    feedback: approved && !hasCaveatedSkill && classifiedCriteria.every((item) => item.status === "satisfied")
      ? ""
      : feedback || defaultFeedback(classifiedCriteria, skills),
    ...(derivedFailedBoundary === undefined ? {} : { failedBoundary: derivedFailedBoundary }),
    createdAt: Date.now(),
  };
}

function hasArtifactDeliveryEvidence(input: StepAssessmentInput): boolean {
  return input.evidence.toolCalls.some((toolCall) => {
    if (toolCall.isError) return false;
    return runtimeObservableReceipts([toolCall]).some((receipt) =>
      receipt.schema === "agentloop.artifactReceipt/v1"
      || receipt.schema === "agentloop.artifactAcceptance/v1",
    );
  });
}

function classifyCriterion(input: StepAssessmentInput, criterion: CriterionAssessment): CriterionAssessment {
  const admitted = input.step.successCriteria.find((item) => item.id === criterion.criterionId);
  const blocking = admitted?.blocking ?? true;
  const verification = admitted?.verification ?? "deterministic";
  const expectedFormatUnmet = criterion.criterionId === "format_matches_request"
    && input.expectedArtifactKind !== undefined
    && latestArtifactAcceptanceReceipt(
      runtimeObservableReceipts(input.evidence.toolCalls),
      input.evidence.deliveryCandidate,
      input.expectedArtifactKind,
    ) === undefined;
  return {
    ...criterion,
    ...(expectedFormatUnmet
      ? {
        satisfied: false,
        rationale: `No accepted artifact matches the required ${input.expectedArtifactKind} format.`,
      }
      : {}),
    blocking,
    status: (expectedFormatUnmet ? false : criterion.satisfied)
      ? "satisfied"
      : verification === "model_judged" || verification === "decision_context"
        ? "unverified"
        : "conflict",
  };
}

function parseFailedBoundary(input: StepAssessmentInput, value: unknown): FailedBoundary | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "failedBoundary");
  const stepId = requireString(record.stepId, "failedBoundary.stepId", { max: 128 });
  if (stepId !== input.step.id) {
    throw new TypeError("failedBoundary.stepId must match the assessed step");
  }
  requireStringArray(record.violatedSkillRequirements, "failedBoundary.violatedSkillRequirements", 50);
  const suggestedRepairShape = parseSuggestedRepairShape(record.suggestedRepairShape);
  return {
    stepId,
    missingEvidenceKinds: uniqueStrings(requireStringArray(record.missingEvidenceKinds, "failedBoundary.missingEvidenceKinds", 50)),
    violatedSkillRequirements: [],
    reusableEvidenceRefs: parseEvidenceRefs(record.reusableEvidenceRefs, "failedBoundary.reusableEvidenceRefs", 100),
    suggestedRepairShape,
  };
}

function candidateExplicitCaveats(evidence: StepEvidence): readonly string[] {
  const candidate = evidence.deliveryCandidate;
  if (candidate === undefined) return [];
  return deliveryCandidateCaveats(candidate);
}

function parseSuggestedRepairShape(value: unknown): SuggestedRepairShape {
  const shape = requireString(value, "failedBoundary.suggestedRepairShape", { max: 32 });
  if (shape === "repair_leaf" || shape === "revise_plan" || shape === "ask_user" || shape === "fail") return shape;
  throw new TypeError("failedBoundary.suggestedRepairShape must be repair_leaf, revise_plan, ask_user, or fail");
}

function parseEvidenceRefs(value: unknown, label: string, max = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new TypeError(`${label} must be an array with at most ${max} entries`);
  }
  return uniqueStrings(value.map((item, index) => {
    if (typeof item !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    return normalizeEvidenceRef(item);
  }));
}

function normalizeEvidenceRef(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) throw new TypeError("evidence reference must contain at least 1 character");
  if (normalized.length <= 128) return normalized;
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 115)}#${suffix}`;
}

function deriveFailedBoundary(
  input: StepAssessmentInput,
  criteria: readonly CriterionAssessment[],
  _skills: readonly SkillAssessment[],
): FailedBoundary {
  const failedCriteria = criteria.filter((item) => !item.satisfied && item.blocking === true);
  const evidenceKinds = new Set<string>(input.step.evidenceContract?.requiredKinds ?? []);
  const missingEvidenceKinds = failedCriteria.flatMap((criterion) => {
    if (evidenceKinds.has(criterion.criterionId)) return [criterion.criterionId];
    return input.step.evidenceContract === undefined ? [criterion.criterionId] : [];
  });
  const reusableEvidenceRefs = [
    ...failedCriteria.flatMap((criterion) => criterion.evidenceRefs),
  ];
  const suggestedRepairShape = missingEvidenceKinds.length === 0
      && input.evidence.candidateOutput.trim().length === 0
    ? "ask_user"
    : "repair_leaf";
  return {
    stepId: input.step.id,
    missingEvidenceKinds: uniqueStrings(missingEvidenceKinds),
    violatedSkillRequirements: [],
    reusableEvidenceRefs: uniqueStrings(reusableEvidenceRefs),
    suggestedRepairShape,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function stepRequiresLookupEvidence(input: StepAssessmentInput): boolean {
  if (input.step.executionBinding.sourceKinds.some((kind) =>
    kind === "web" || kind === "uploaded_source" || kind === "visible_directory" || kind === "workspace_file"
  )) return true;
  return input.step.successCriteria.some((criterion) =>
    /(?:\b(?:source|url|cite|citation|current|latest|lookup|search|fetch)\b|来源|网址|引用|最新|当前|查询|检索|搜索)/iu
      .test(criterion.description),
  );
}

function assessmentView(input: StepAssessmentInput): Record<string, unknown> {
  const policy = assessmentPolicy(input);
  return {
    step: {
      id: input.step.id,
      objective: input.step.objective,
      ...(input.step.evidenceContract === undefined ? {} : { evidenceContract: input.step.evidenceContract }),
      successCriteria: input.step.successCriteria,
    },
    skills: input.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      contentHash: skill.contentHash,
      sourceKind: skill.sourceKind,
      description: skill.description,
      ...(skill.package === undefined ? {} : {
        package: {
          packageHash: skill.package.packageHash,
          entrypointPath: skill.package.entrypointPath,
          ...(skill.package.url === undefined ? {} : {
            sourceUrl: skill.package.url,
            sourceRevision: skill.package.revision,
          }),
        },
      }),
      instructionSummary: summarizeSkillInstructions(skill.instructions),
    })),
    ...(policy === undefined ? {} : { assessmentPolicy: policy }),
    evidence: sanitizeStepEvidence(input.modelEvidence ?? input.evidence),
    ...(input.contextSummary === undefined ? {} : { contextSummary: input.contextSummary }),
  };
}

function assessmentPolicy(input: StepAssessmentInput): Record<string, unknown> | undefined {
  const policy: Record<string, unknown> = {};
  if (input.skills.length > 0) {
    policy.skillCaveats = {
      unavailableValidation:
        "Skill QA is not a completion gate. Reject unavailable validation only when user or criteria require it; otherwise record skipped_unavailable or not_assessed.",
      processDiscipline:
        "Do not reject process-only Skill gaps when criteria pass; record process_caveat or not_assessed.",
    };
  }
  if (stepHasSourceKind(input.step, "web")) {
    policy.sourceCaveats = {
      evidenceBoundary:
        "If authoritative external sources were attempted and remain unavailable, forbidden, paywalled, or missing full text: do not approve criteria that require those missing facts. In feedback, explicitly separate verified facts from unavailable or unverified facts so Runtime can decide whether a limited-evidence delivery is acceptable. Treat source evidence as blocking only when exact/current/official source facts are the user's required deliverable; otherwise it is auxiliary grounding for the core artifact.",
    };
  }
  if (input.holisticSourceContractMismatch === true) {
    policy.holisticCompletion = {
      judgment:
        "Judge the goal, candidate, successful tool evidence, and explicit limitations together. A missing source-summary or caveat receipt shape is not automatic failure.",
      boundary:
        "Approve only supported conclusions. If a material fact remains missing, reject it with failedBoundary: name the missing evidence kind and choose repair_leaf only when a current-step tool can obtain it; otherwise choose revise_plan, ask_user, or fail.",
    };
  }
  return Object.keys(policy).length === 0 ? undefined : policy;
}

/**
 * The assessor receives the execution candidate as evidence. A converged
 * candidate that is actually an unexecuted tool invocation would otherwise
 * induce the assessor model to resume the execution instead of assessing it;
 * redact that shape defensively before it reaches the model.
 */
function sanitizeStepEvidence(evidence: StepEvidence): StepEvidence {
  return { ...evidence, candidateOutput: projectCandidateOutput(redactToolInvocation(evidence.candidateOutput)) };
}

function redactToolInvocation(value: string): string {
  const trimmed = value.trimStart();
  if (isTextToolInvocation(trimmed)) {
    return "[The completion candidate was an unexecuted tool invocation, not a completion statement; it was redacted from assessment evidence.]";
  }
  return value;
}

function projectCandidateOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 2_000) return value;
  const lines = trimmed.split(/\r?\n/);
  const outline = lines
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((line) => /^(?:#{1,6}\s|\d+\.\s|[-*]\s|\|.+\|$)/u.test(line.text))
    .slice(0, 80);
  return JSON.stringify({
    schema: "agentloop.candidateProjection/v1",
    characters: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
    preview: trimmed.slice(0, 1_000),
    outline,
    caveat: "Full candidate output is persisted in canonical evidence; assessment model projection is limited to summary, outline, and hash.",
  });
}

function assessmentRuntimeContext(
  input: StepAssessmentInput,
  attempt: number,
  runtimeDirective: string | undefined,
  taskProfile: TaskProfile = assessmentTaskProfile(input),
): RuntimeContextSnapshot {
  return {
    id: `${input.runId}:assessment:${input.step.id}:${attempt}`,
    phase: "assessment",
    ...(attempt === 1 ? {} : { supersedesId: `${input.runId}:assessment:${input.step.id}:${attempt - 1}` }),
    content: [
      "<assessment_context source=\"server\">",
      JSON.stringify(assessmentView(input)),
      "</assessment_context>",
      formatDynamicPromptContext(taskProfile),
      ...(runtimeDirective === undefined ? [] : [
        "<runtime_directive>",
        runtimeDirective,
        "</runtime_directive>",
      ]),
    ].join("\n"),
  };
}

function assessmentTaskProfile(input: StepAssessmentInput): TaskProfile {
  const allowsResearchPolicy = stepAllowsResearchPolicy(input.step);
  const intent = classifyTaskIntent({
    objective: input.step.objective,
    successCriteria: input.step.successCriteria,
    toolNames: stepResolvedToolNames(input.step),
    skillNames: input.skills.map((skill) => skill.name),
  });
  return buildTaskProfile({
    phase: "assessment",
    intent: "execute",
    evidenceProfile: input.assessmentProfile ?? "source_grounded",
    ...(allowsResearchPolicy ? { sourceNeed: intent.sourceNeed } : {}),
    ...(allowsResearchPolicy && intent.researchPolicy !== undefined ? { researchPolicy: intent.researchPolicy } : {}),
    skillBound: input.skills.length > 0,
  });
}

function stepAllowsResearchPolicy(step: StepAssessmentInput["step"]): boolean {
  const requiredKinds = step.evidenceContract?.requiredKinds ?? [];
  return step.role === "fact_acquisition"
    || stepHasSourceKind(step, "web")
    || requiredKinds.includes("source_summary")
    || requiredKinds.includes("source_urls");
}

function evidenceDigest(evidence: unknown): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function summarizeSkillInstructions(instructions: string): string {
  const lines = instructions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const notable = lines.filter((line) => /^(#{1,6}\s|[-*]\s|\d+\.\s)/.test(line));
  const source = notable.length > 0 ? notable : lines;
  const summary = source.slice(0, 8).join("\n");
  return summary.length <= 700 ? summary : `${summary.slice(0, 699)}…`;
}

function assertExactIds(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) {
    throw new AppError("ASSESSMENT_ERROR", `Assessment must cover every ${label} exactly once`, 422);
  }
  const expectedSet = new Set(expected);
  if (actual.some((id) => !expectedSet.has(id))) {
    throw new AppError("ASSESSMENT_ERROR", `Assessment contains an unknown ${label} ID`, 422);
  }
}

function defaultFeedback(
  criteria: readonly CriterionAssessment[],
  _skills: readonly SkillAssessment[],
): string {
  const failedCriteria = criteria.filter((item) => !item.satisfied && item.blocking === true).map((item) => item.criterionId);
  if (failedCriteria.length > 0) {
    return `Completion rejected. Unsatisfied blocking criteria: ${failedCriteria.join(", ")}. Repair the same step and resubmit.`;
  }
  const unverified = criteria.filter((item) => item.status === "unverified").map((item) => item.criterionId);
  return `Completion delivered with non-blocking unverified criteria: ${unverified.join(", ") || "none"}.`;
}
