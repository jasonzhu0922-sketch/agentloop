import { AppError, badRequest } from "../shared/errors.ts";
import { canonicalArtifactFormatFamily } from "../shared/artifact-format.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { ModelAdapter, ModelInvocation, ModelToolCall, RuntimeContextSnapshot, RuntimeEventSink } from "../runtime/contracts.ts";
import { completeWithStreaming } from "../runtime/model-streaming.ts";
import { inferOperationProfile, operationProfileCatalogForPlanning } from "../runtime/operation-profiles.ts";
import { classifyTaskIntent, uploadedSourcePlanningContext } from "../runtime/task-intent.ts";
import { buildDynamicSystemPrompt, buildTaskProfile, formatDynamicPromptContext, type TaskProfile } from "../runtime/dynamic-prompt.ts";
import { formatAvailableSkills } from "../skills/skill-context.ts";
import type {
  CaveatPolicy,
  ConversationReusableArtifact,
  EvidenceContract,
  EvidenceKind,
  OutcomeLeafRole,
  OutcomePlanShape,
  PlanProposal,
  PlanStepProposal,
  PlanningCapability,
  Planner,
  SelectedSkillRole,
  TaskSpec,
} from "./contracts.ts";
import { admitPlan, reusableSourceEvidenceKindsForTurn } from "./admission.ts";
import { resolveCapabilityGaps, resolveSourceGroundingGap } from "./capability-resolution.ts";
import { planningCapabilitiesFromToolNames, planningCapabilitiesFromTools } from "./step-execution-binding.ts";
import type { RuntimeResultBinding } from "../runtime/runtime-result.ts";

const EVIDENCE_KIND_VALUES = [
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
  "explicit_caveats",
] as const satisfies readonly EvidenceKind[];

const ARTIFACT_DELIVERY_EVIDENCE_KIND_VALUES = [
  "artifact_path",
  "artifact_non_empty",
  "artifact_acceptance",
  "artifact_openable",
  "format_matches_request",
] as const satisfies readonly EvidenceKind[];

const SKILL_QA_ONLY_EVIDENCE_KIND_VALUES = [
  "basic_navigation",
] as const satisfies readonly EvidenceKind[];

const CAVEAT_POLICY_VALUES = [
  "none",
  "mark_unverified_facts",
  "strict_fail_on_missing_source",
] as const satisfies readonly CaveatPolicy[];

// A plan can expose independent evidence gaps (for example, source grounding
// followed by a structured schema receipt). Keep recovery bounded while
// allowing the authorized catalog to add each missing producer.
const MAX_PLANNING_TURNS = 4;
const MAX_CAPABILITY_RECOVERIES = 2;

const OUTCOME_LEAF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "objective",
    "dependsOn",
    "role",
    "skillIds",
    "requiredCapabilities",
    "sourceConstraint",
    "evidenceContract",
  ],
  properties: {
    id: { type: "string" },
    objective: { type: "string" },
    dependsOn: { type: "array", items: { type: "string" } },
    role: { type: "string", enum: ["fact_acquisition", "produce", "deliver", "repair"] },
    skillIds: { type: "array", items: { type: "string" } },
    requiredCapabilities: { type: "array", items: { type: "string" } },
    sourceConstraint: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["requiredToolSourceIds", "requiredUploadedSourceIds", "requiredVisibleDirectoryIds"],
      properties: {
        requiredToolSourceIds: { type: ["array", "null"], minItems: 1, items: { type: "string" } },
        requiredUploadedSourceIds: { type: ["array", "null"], minItems: 1, items: { type: "string" } },
        requiredVisibleDirectoryIds: { type: ["array", "null"], minItems: 1, items: { type: "string" } },
      },
    },
    evidenceContract: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["requiredKinds", "caveatPolicy"],
      properties: {
        requiredKinds: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", enum: EVIDENCE_KIND_VALUES },
        },
        caveatPolicy: { type: "string", enum: CAVEAT_POLICY_VALUES },
      },
    },
  },
} as const;

const SUBMIT_OUTCOME_PLAN_TOOL = {
  name: "submit_outcome_plan",
  description: "Submit the minimal OutcomePlan. This is the only valid first-round planning response.",
  strict: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["schema", "goal", "shape", "selectedSkillRoles", "leaves"],
    properties: {
      schema: { type: "string", enum: ["agentloop.outcomePlan/v2"] },
      goal: { type: "string" },
      shape: { type: "string", enum: ["single_leaf", "fact_then_produce", "multi_deliverable", "pipeline", "recovery_patch"] },
      selectedSkillRoles: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["skillId", "role", "reason"],
          properties: {
            skillId: { type: "string" },
            role: { type: "string", enum: ["primary_builder", "source_provider", "support", "qa"] },
            reason: { type: "string" },
          },
        },
      },
      leaves: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: OUTCOME_LEAF_SCHEMA,
      },
    },
  },
} as const;

type PlannerContractRetryKind = "empty" | "plain_text" | "execution_tool" | "arguments" | "native_skill_binding" | "admission";

interface PlannerContractRetry {
  readonly kind: PlannerContractRetryKind;
  readonly directive: string;
  readonly candidateSkillIds?: readonly string[];
}

const PLANNING_MAX_OUTPUT_TOKENS = 8_192;
const STEP_GRANULARITY_GUIDANCE = {
  stepContract: [
    "Initial Plan is not a workflow script; it is the smallest canonical outcome boundary that lets Runtime start useful work.",
    "One leaf is one user-value outcome or prerequisite fact boundary, not a checklist of internal actions.",
    "A leaf may contain local tool calls, Skill workflow actions, receipt checks, and export/readback evidence needed to complete that same outcome.",
    "Success criteria state the delivered boundary and assessable evidence, not an internal QA or repair checklist.",
    "Human-in-the-Loop is a control pause inside an outcome, not a terminal Plan step; preserve every unmet original deliverable after the response.",
    "Optional enhancement, polish, exhaustive source depth, examples, advanced navigation, and visual refinements are execution preferences unless the user explicitly requested them.",
  ],
  splitWhen: [
    "Independent source acquisition or research is required before production and its facts will be reused by a later outcome.",
    "The task requires multiple independent deliverables or reusable artifacts that should be assessed separately.",
    "A prior Assessment, recovery directive, or failed boundary requires a targeted repair/replan step, not a generic QA tail.",
  ],
  mergeOnlyWhen: [
    "The task is an ordinary answer or artifact deliverable.",
    "Local file receipt, export metadata, and readback evidence prove the same leaf's output and do not need their own Plan step.",
    "Skill workflow, formatting, polish, QA, and defect repair are leaf execution or recovery details, not generic Planner steps.",
  ],
  progressiveRefinement: [
    {
      when: "ordinary artifact or answer task",
      defaultShape: "one outcome leaf with concrete delivery boundary",
    },
    {
      when: "research/source facts are required before production",
      defaultShape: "one fact-acquisition leaf followed by one production leaf",
    },
    {
      when: "reusable pipeline or targeted recovery is required",
      defaultShape: "split only the durable fact, production, and required recovery boundaries",
    },
  ],
} as const;

export class ModelPlanner implements Planner {
  private readonly model: ModelAdapter;

  constructor(model: ModelAdapter) {
    this.model = model;
  }

  async plan(task: TaskSpec, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<PlanProposal> {
    const taskProfile = planningTaskProfile(task);
    await emit?.({
      type: "planning.started",
      data: {
        availableSkillCount: task.availableSkills.length,
        availableToolCount: task.availableToolNames.length,
      },
    });
    if (task.responseOnly && taskProfile.planShape === "single_leaf") {
      await emit?.({
        type: "planning.turn.started",
        data: {
          turn: 1,
          loadedSkillCount: 0,
          pendingSkillCount: 0,
          hasRuntimeDirective: false,
          toolCount: 0,
          messageCount: 1,
          deterministic: true,
        },
      });
      await emit?.({
        type: "planning.turn.completed",
        data: {
          turn: 1,
          finishReason: "deterministic",
          toolCallCount: 0,
          loadSkillCallCount: 0,
          submitPlanCallCount: 0,
          loadedSkillCount: 0,
          contentLength: 0,
          deterministic: true,
        },
      });
      return responseOnlyPlan(planningIntentObjective(task));
    }
    const messages: ModelInvocation["messages"] = [
      ...(task.conversationHistory ?? []),
      { role: "user", content: task.input },
    ];
    let planningTask = task;
    let selectedSkillRoles = task.selectedSkillRoles ?? selectInitialSkillRoles(task.availableSkills, taskProfile);
    let capabilityRecoveryCount = 0;
    const attemptedContractRepairs = new Set<PlannerContractRetryKind>();
    let lastPlanningError: AppError | undefined;
    await emit?.({
      type: "planning.profile.created",
      data: taskProfile as unknown as Readonly<Record<string, unknown>>,
    });
    await emit?.({
      type: "planning.skills.role_selected",
      data: {
        selectedCount: selectedSkillRoles.length,
        skills: selectedSkillRoles,
      },
    });
    const systemPrompt = buildDynamicSystemPrompt({
      phase: "planning",
      baseInstructions: [
        "You are the Planner for a Plan-first Runtime.",
        "Return exactly one submit_outcome_plan tool call; do not execute work, call other tools, or declare completion.",
        "Use only supplied context facts, capability catalog entries, and Skill catalog entries.",
      ],
      contractLines: [
        "Fill the smallest Outcome Plan using agentloop.outcomePlan/v2 so Runtime can start useful work.",
        "Use the supplied TaskProfile shape as the default shape; only choose a narrower valid shape when the user request is simpler.",
        "Use one leaf for ordinary answers/artifacts; split only for reusable source facts.",
        "Leaves are durable evidence boundaries, not workflow scripts or internal tool checklists.",
        "selectedSkillRoles is an execution-selection list, not a candidate list: every listed Skill, regardless of role, must also appear in at least one concrete leaf.skillIds; otherwise omit it.",
        "Keep local receipt, export, and readback evidence inside the producing leaf.",
        "For requested file or media formats, the minimum usability of that format is core delivery evidence: readable/openable output, requested format/type, workspace path, and non-empty receipt.",
        "HIL pauses an outcome; preserve its requested deliverable and continue production after the response.",
        "For browser/document artifacts, require format/openability; Skill-owned QA covers navigation and polish unless required.",
        "Do not create Skill-loading-only, polish-only, QA, or repair/verification tail leaves. Skill-required QA is handled inside the Skill-bound leaf after load_skill, not as a Planner template.",
        "Use contracts only for source provenance, artifacts, high-risk facts, or external effects. Runtime audits normal delivery automatically; do not require its receipt.",
        "For factual materials, require available source grounding and explicit caveats for unavailable facts; do not require inaccessible official/full-text sources as a blocking criterion unless the user asked for strict official-source verification.",
        "All leaf IDs, Skill IDs, capability IDs, dependencies, roles, and evidence kinds must match the submit_outcome_plan schema and supplied catalogs.",
      ],
      taskProfile,
    });
    let runtimeDirective: string | undefined;
    for (let turn = 1; turn <= MAX_PLANNING_TURNS; turn += 1) {
      await emit?.({
        type: "planning.turn.started",
        data: {
          turn,
          loadedSkillCount: 0,
          pendingSkillCount: 0,
          hasRuntimeDirective: runtimeDirective !== undefined,
          toolCount: 1,
          repairMode: runtimeDirective === undefined ? "none" : "contract_retry",
          messageCount: messages.length,
        },
      });
      const invocation: ModelInvocation = {
        runId: task.runId,
        systemPrompt,
        phase: "planning",
        runtimeContext: planningRuntimeContext(planningTask, turn, runtimeDirective, taskProfile, selectedSkillRoles),
        messages,
        tools: [submitOutcomePlanToolForTask(planningTask)],
        toolChoice: { name: SUBMIT_OUTCOME_PLAN_TOOL.name },
        maxOutputTokens: Math.min(PLANNING_MAX_OUTPUT_TOKENS, this.model.limits.maxOutputTokens),
      };
      const response = emit === undefined
        ? await this.model.complete(invocation, signal)
        : await completeWithStreaming({
          model: this.model,
          invocation,
          emit,
          signal,
          base: { phase: "planning", turn },
        });
      const outcomePlanCalls = response.toolCalls.filter((call) => call.name === SUBMIT_OUTCOME_PLAN_TOOL.name);
      await emit?.({
        type: "planning.turn.completed",
        data: {
          turn,
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          loadSkillCallCount: 0,
          submitOutcomePlanCallCount: outcomePlanCalls.length,
          submitPlanPatchCallCount: 0,
          loadedSkillCount: 0,
          contentLength: response.content.length,
          repairMode: runtimeDirective === undefined ? "none" : "contract_retry",
        },
      });

      try {
        if (response.finishReason === "length") {
          throw planningResponseError("Planner response was truncated", turn, response);
        }
        if (response.toolCalls.length !== 1 || outcomePlanCalls.length !== 1) {
          throw planningResponseError("Planner must submit exactly one structured submit_outcome_plan call", turn, response);
        }
        const proposal = normalizeOutcomePlanProposal(parseOutcomePlanProposal(outcomePlanCalls[0]), planningTask);
        assertInitialOutcomePlanShape(proposal, planningTask);
        await emit?.({
          type: "planning.outcome_plan.submitted",
          data: {
            schema: proposal.schema,
            shape: proposal.shape,
            selectedSkillRoles: proposal.selectedSkillRoles ?? [],
            leafCount: proposal.steps.length,
          },
        });
        admitPlan({
          runId: task.runId,
          proposal,
          availableSkills: planningTask.availableSkills,
          availableToolNames: new Set(planningTask.availableToolNames),
          ...(planningTask.availableTools === undefined ? {} : { availableTools: planningTask.availableTools }),
          availableCapabilities: planningCapabilitiesForTask(planningTask),
          ...(planningTask.requiredToolSourceIds === undefined ? {} : { requiredToolSourceIds: planningTask.requiredToolSourceIds }),
          ...(planningTask.sources === undefined ? {} : { availableUploadedSourceIds: planningTask.sources.map((source) => source.id) }),
          ...(planningTask.visibleDirectories === undefined ? {} : { availableVisibleDirectoryIds: planningTask.visibleDirectories.map((directory) => directory.id) }),
          reusableEvidenceKinds: reusableSourceEvidenceKindsForTurn(
            planningTask.conversationWorkingSet,
            planningTask.turnResolution,
          ),
          resultBindings: runtimeResultBindingsForPlanningTask(planningTask),
          taskIntent: {
            deliverySurface: taskProfile.deliverySurface,
            artifactKind: taskProfile.artifactKind,
            sourceNeed: taskProfile.sourceNeed,
            evidenceDemand: planningTask.turnResolution?.evidenceDemand,
          },
        });
        await emit?.({
          type: "planning.outcome_plan.admitted",
          data: {
            shape: proposal.shape,
            leafCount: proposal.steps.length,
          },
        });
        return proposal;
      } catch (error) {
        const planningError = error instanceof AppError && error.code === "PLANNING_ERROR"
          ? error
          : new AppError("PLANNING_ERROR", error instanceof Error ? error.message : "Invalid OutcomePlan", 422);
        lastPlanningError = planningError;
        await emit?.({
          type: "planning.contract_failed",
          data: {
            validationError: summarizePlanningError(planningError.message),
            planningTurn: turn,
          },
        });
        const resolution = capabilityRecoveryCount < MAX_CAPABILITY_RECOVERIES && isCapabilityRecoveryFailure(planningError)
          ? resolveCapabilityRecovery(planningTask, outcomePlanCalls, isSourceGroundingFailure(planningError))
          : undefined;
        if (resolution !== undefined) {
          capabilityRecoveryCount += 1;
          planningTask = resolution.task;
          selectedSkillRoles = resolution.selectedSkillRoles;
          runtimeDirective = resolution.directive;
          await emit?.({
            type: "planning.capability_gap.resolved",
            data: {
              gapCount: resolution.gapCount,
              candidateCapabilityIds: resolution.candidateCapabilityIds,
              candidateSkillIds: resolution.candidateSkillIds,
            },
          });
          continue;
        }
        const contractRetry = plannerContractRetryDirective(planningError, response, outcomePlanCalls, planningTask);
        if (contractRetry !== undefined && !attemptedContractRepairs.has(contractRetry.kind)) {
          attemptedContractRepairs.add(contractRetry.kind);
          runtimeDirective = contractRetry.directive;
          if (contractRetry.kind === "native_skill_binding") {
            await emit?.({
              type: "planning.skill_binding.repair_offered",
              data: {
                candidateSkillIds: contractRetry.candidateSkillIds ?? [],
                planningTurn: turn,
              },
            });
          }
          continue;
        }
        throw planningError;
      }
    }
    throw lastPlanningError ?? new AppError("PLANNING_ERROR", "Planner did not produce an OutcomePlan", 422);
  }
}

function responseOnlyPlan(input: string): PlanProposal {
  return {
    goal: input.trim().slice(0, 20_000) || "Answer the latest user message",
    schema: "agentloop.outcomePlan/v2",
    shape: "single_leaf",
    selectedSkillRoles: [],
    selectedSkillIds: [],
    steps: [{
      id: "response",
      objective: "Answer the latest user message directly without using Skills or Tools.",
      dependencies: [],
      role: "deliver",
      skillIds: [],
      requiredCapabilities: ["conversation_delivery"],
      successCriteria: [{ id: "answered", description: "A non-empty direct answer is returned.", source: "planner" }],
    }],
  };
}

function planningResponseError(
  message: string,
  turn: number,
  response: Awaited<ReturnType<ModelAdapter["complete"]>>,
): AppError {
  return new AppError("PLANNING_ERROR", message, 422, {
    planningTurn: turn,
    finishReason: response.finishReason,
    toolCallCount: response.toolCalls.length,
    toolCallNames: response.toolCalls.map((call) => call.name),
    responseContentLength: response.content.length,
    responseContentPreview: response.content.slice(0, 500),
  });
}

function shouldRetryPlannerToolContract(
  response: Awaited<ReturnType<ModelAdapter["complete"]>>,
  outcomePlanCallCount: number,
  availableToolNames: readonly string[],
): boolean {
  if (response.finishReason === "length") return false;
  if (response.toolCalls.length === 0) return false;
  if (response.toolCalls.length === 1 && outcomePlanCallCount === 1) return false;
  const availableExecutionTools = new Set(availableToolNames);
  return response.toolCalls.some((call) => availableExecutionTools.has(call.name));
}

function plannerContractRetryDirective(
  planningError: AppError,
  response: Awaited<ReturnType<ModelAdapter["complete"]>>,
  outcomePlanCalls: readonly ModelToolCall[],
  task: TaskSpec,
): PlannerContractRetry | undefined {
  if (shouldRetryPlannerEmptyResponse(response)) {
    return { kind: "empty", directive: plannerEmptyResponseDirective() };
  }
  if (shouldRetryPlannerPlainResponse(response)) {
    return { kind: "plain_text", directive: plannerPlainResponseDirective() };
  }
  if (shouldRetryPlannerToolContract(response, outcomePlanCalls.length, task.availableToolNames)) {
    return { kind: "execution_tool", directive: plannerToolContractDirective(response) };
  }
  if (shouldRetryOutcomePlanArgumentsContract(planningError, response, outcomePlanCalls)) {
    return { kind: "arguments", directive: plannerOutcomePlanArgumentsDirective(outcomePlanCalls[0], planningError) };
  }
  const nativeSkillBinding = nativeTransformationSkillBindingRepair(planningError, task);
  if (nativeSkillBinding !== undefined) return nativeSkillBinding;
  if (shouldRetryOutcomePlanAdmissionContract(response, outcomePlanCalls)) {
    return {
      kind: "admission",
      directive: plannerOutcomePlanAdmissionDirective(
        planningError,
        planningCapabilitiesForTask(task).map((capability) => capability.id),
      ),
    };
  }
  return undefined;
}

function nativeTransformationSkillBindingRepair(
  planningError: AppError,
  task: TaskSpec,
): PlannerContractRetry | undefined {
  if (!/uploaded artifact transformation must use one primary-builder leaf/i.test(planningError.message)) return undefined;
  const candidateSkillIds = nativePrimaryBuilderSkillIds(task, planningTaskProfile(task).artifactKind ?? "none");
  if (candidateSkillIds.length === 0) return undefined;
  return {
    kind: "native_skill_binding",
    candidateSkillIds,
    directive: [
      "Your previous submit_outcome_plan call was rejected by Runtime Admission.",
      `Validation error: ${summarizePlanningError(planningError.message)}.`,
      "The prior OutcomePlan attempted a native uploaded-file transformation without binding its primary format Skill.",
      `Eligible primary-builder Skill IDs: ${JSON.stringify(candidateSkillIds)}.`,
      "Select exactly the Skill that owns the native input format, include it in selectedSkillRoles as primary_builder, and bind that same ID to the single producer leaf.",
      "Do not create a source-summary/fact-acquisition leaf, and do not copy an eligible Skill into the Plan unless that leaf executes it.",
    ].join("\n"),
  };
}

function isCapabilityRecoveryFailure(error: AppError): boolean {
  return /requires evidence that its bound capabilities cannot produce:/.test(error.message)
    || isSourceGroundingFailure(error);
}

function isSourceGroundingFailure(error: AppError): boolean {
  return /must bind a capability that produces required source-grounding evidence/.test(error.message);
}

function resolveCapabilityRecovery(
  task: TaskSpec,
  outcomePlanCalls: readonly ModelToolCall[],
  sourceGroundingRequired: boolean,
): {
  readonly task: TaskSpec;
  readonly selectedSkillRoles: readonly SelectedSkillRole[];
  readonly directive: string;
  readonly gapCount: number;
  readonly candidateCapabilityIds: readonly string[];
  readonly candidateSkillIds: readonly string[];
} | undefined {
  if (task.capabilityRecovery === undefined || outcomePlanCalls.length !== 1) return undefined;
  let proposal: PlanProposal;
  try {
    proposal = normalizeOutcomePlanProposal(parseOutcomePlanProposal(outcomePlanCalls[0]), task);
  } catch {
    return undefined;
  }
  const currentCapabilities = planningCapabilitiesForTask(task);
  const evidenceGaps = resolveCapabilityGaps({
    proposal,
    currentSkills: task.availableSkills,
    currentCapabilities,
    catalog: task.capabilityRecovery,
  });
  const sourceGroundingGap = sourceGroundingRequired && task.turnResolution?.evidenceDemand !== undefined
    && task.turnResolution.evidenceDemand !== "none"
    ? resolveSourceGroundingGap({
      catalog: task.capabilityRecovery,
      evidenceDemand: task.turnResolution.evidenceDemand,
    })
    : undefined;
  const gaps = [...evidenceGaps, ...(sourceGroundingGap === undefined ? [] : [sourceGroundingGap])];
  if (gaps.length === 0 || gaps.some((gap) => gap.candidates.length === 0)) return undefined;
  const candidateCapabilityIds = [...new Set(gaps.flatMap((gap) => gap.candidates.map((candidate) => candidate.capabilityId)))].sort();
  const candidateSkillIds = [...new Set(gaps.flatMap((gap) => gap.candidates.flatMap((candidate) => candidate.requiredSkillIds)))].sort();
  const recoverySkills = task.capabilityRecovery.availableSkills.filter((skill) => candidateSkillIds.includes(skill.id));
  const availableSkills = uniqueSkills([...task.availableSkills, ...recoverySkills]);
  const existingCapabilityIds = new Set(currentCapabilities.map((capability) => capability.id));
  const availableCapabilities = [
    ...currentCapabilities,
    ...task.capabilityRecovery.availableCapabilities.filter((capability) =>
      candidateCapabilityIds.includes(capability.id) && !existingCapabilityIds.has(capability.id)),
  ];
  const selectedSkillRoles = uniqueSkillRoles([
    ...(task.selectedSkillRoles ?? selectInitialSkillRoles(task.availableSkills, planningTaskProfile(task))),
    ...recoverySkills.flatMap((skill) => skill.agentLoop?.roles.includes("source_provider") === true ? [{
      skillId: skill.id,
      role: "source_provider" as const,
      reason: "Candidate evidence producer discovered from the authorized capability catalog.",
    }] : []),
  ]);
  return {
    task: { ...task, availableSkills, availableCapabilities },
    selectedSkillRoles,
    directive: capabilityRecoveryDirective(gaps),
    gapCount: gaps.length,
    candidateCapabilityIds,
    candidateSkillIds,
  };
}

function capabilityRecoveryDirective(gaps: ReturnType<typeof resolveCapabilityGaps>): string {
  return [
    "Runtime Admission found that the previous plan required evidence its bound capabilities could not produce.",
    "The authorized capability catalog has now been expanded only with the eligible evidence-producer candidates below.",
    "Revise the OutcomePlan for the same goal. Bind a selected candidate Skill to the concrete acquisition leaf when required, and make downstream HIL/production leaves depend on that fact leaf instead of claiming that they themselves produced upstream evidence.",
    "Do not invent capabilities, add permissions, install tools, or keep an evidence requirement on a leaf that does not produce it.",
    `Capability gaps: ${JSON.stringify(gaps)}.`,
  ].join("\n");
}

function uniqueSkills(skills: readonly TaskSpec["availableSkills"][number][]): TaskSpec["availableSkills"] {
  return [...new Map(skills.map((skill) => [skill.id, skill])).values()];
}

function uniqueSkillRoles(roles: readonly SelectedSkillRole[]): readonly SelectedSkillRole[] {
  return [...new Map(roles.map((role) => [role.skillId, role])).values()];
}

function shouldRetryPlannerEmptyResponse(
  response: Awaited<ReturnType<ModelAdapter["complete"]>>,
): boolean {
  return response.finishReason !== "length"
    && response.toolCalls.length === 0
    && response.content.trim().length === 0;
}

function shouldRetryPlannerPlainResponse(
  response: Awaited<ReturnType<ModelAdapter["complete"]>>,
): boolean {
  return response.finishReason !== "length"
    && response.toolCalls.length === 0
    && response.content.trim().length > 0;
}

function plannerPlainResponseDirective(): string {
  return [
    "Your previous planning response returned ordinary assistant text instead of the required structured plan.",
    "Treat the latest user message as the active planning goal, not as a request to report completed work.",
    "Submit exactly one submit_outcome_plan call for that goal.",
    "Do not execute work, call other tools, or declare completion during planning.",
  ].join("\n");
}

function shouldRetryOutcomePlanArgumentsContract(
  planningError: AppError,
  response: Awaited<ReturnType<ModelAdapter["complete"]>>,
  outcomePlanCalls: readonly ModelToolCall[],
): boolean {
  if (response.finishReason === "length") return false;
  if (response.toolCalls.length !== 1 || outcomePlanCalls.length !== 1) return false;
  if (isJsonObject(outcomePlanCalls[0].arguments)) return false;
  return planningError.message === "submit_outcome_plan arguments must be a JSON object";
}

function shouldRetryOutcomePlanAdmissionContract(
  response: Awaited<ReturnType<ModelAdapter["complete"]>>,
  outcomePlanCalls: readonly ModelToolCall[],
): boolean {
  if (response.finishReason === "length") return false;
  return response.toolCalls.length === 1 && outcomePlanCalls.length === 1 && isJsonObject(outcomePlanCalls[0].arguments);
}

function plannerEmptyResponseDirective(): string {
  return [
    "Your previous planning response was empty.",
    "Submit exactly one submit_outcome_plan call for the same user goal.",
    "Do not execute work, call other tools, or declare completion during planning.",
  ].join("\n");
}

function plannerToolContractDirective(response: Awaited<ReturnType<ModelAdapter["complete"]>>): string {
  const attemptedTools = [...new Set(response.toolCalls.map((call) => call.name))]
    .sort()
    .join(", ");
  return [
    "Your previous planning response attempted tool calls that are not callable in the planning phase.",
    `Attempted tools: ${attemptedTools || "none"}.`,
    "Do not inspect files, read artifacts, run commands, load Skills, or execute any work during planning.",
    "Submit exactly one submit_outcome_plan call. Put only authorized execution capability IDs from planning_context.capabilityCatalog.allowedIds in each leaf's requiredCapabilities.",
    "For a user-reported defect in a prior artifact, plan a repair leaf that locates the prior artifact, verifies the defect, regenerates or edits the artifact, and records artifact_acceptance evidence.",
  ].join("\n");
}

function plannerOutcomePlanAdmissionDirective(
  planningError: AppError,
  allowedCapabilityIds: readonly string[],
): string {
  return [
    "Your previous submit_outcome_plan call was rejected by Runtime Admission.",
    `Validation error: ${summarizePlanningError(planningError.message)}.`,
    "Submit exactly one corrected submit_outcome_plan call for the same user goal.",
    "Do not execute work, call execution tools, load Skills, or declare completion during planning.",
    "Treat operation profiles, execution capabilities, evidence kinds, Skills, Tools, and ToolSources as separate namespaces. requiredCapabilities may contain only IDs from the execution capability catalog.",
    `Authorized execution capability IDs: ${JSON.stringify([...new Set(allowedCapabilityIds)].sort())}.`,
    "For initial execution plans, selectedSkillRoles may use only primary_builder or source_provider; support and qa roles are recovery-only.",
    "selectedSkillRoles[].skillId and leaves[].skillIds may contain only IDs in planning_context.availableSkillIds. Do not place capability IDs, Tool names, ToolSource IDs, or evidence kinds in either Skill field; use leaves[].requiredCapabilities for capabilities. If availableSkillIds is empty, both Skill fields must be empty arrays.",
    "planning_context.candidateSkillRoles are relevance suggestions, not preselected dependencies. Omit any candidate that is not bound to and executed by a concrete leaf.",
    "Every selected primary_builder Skill must be bound to at least one concrete leaf that uses it.",
    "A terminal leaf that only proposes options or waits for Human-in-the-Loop cannot satisfy a requested artifact. Keep the artifact-producing obligation in the same resumed leaf or add a dependent production leaf with observable artifact evidence.",
    "If a Skill is only a style/reference fallback and is not needed for execution, omit it from selectedSkillRoles instead of selecting it as support.",
    "Keep QA, verification, readback, and local acceptance inside the producing leaf unless TaskProfile.planShape is recovery_patch.",
  ].join("\n");
}

function plannerOutcomePlanArgumentsDirective(call: ModelToolCall, planningError: AppError): string {
  return [
    "Your previous submit_outcome_plan tool call was rejected because its arguments were not a JSON object.",
    `Validation error: ${summarizePlanningError(planningError.message)}.`,
    `Observed argument type: ${plannerArgumentType(call.arguments)}.`,
    "Call submit_outcome_plan again with arguments as a structured object, not as a JSON string or prose.",
    "Do not embed raw double quotes inside string fields; escape quotation marks or omit them.",
    "The arguments object must include schema, goal, shape, selectedSkillRoles, and leaves.",
  ].join("\n");
}

function plannerArgumentType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function planningTaskIntent(task: TaskSpec) {
  const intent = classifyTaskIntent({
    objective: planningIntentObjective(task),
    toolNames: task.availableToolNames,
    skillNames: task.availableSkills.map((skill) => skill.name),
    responseOnly: task.responseOnly,
    evidenceDemand: task.turnResolution?.evidenceDemand,
    userConstraints: task.turnResolution?.userConstraints,
  });
  const target = conversationArtifactTransformationTarget(task);
  if (target === undefined) {
    // The user owns whether this is file work: input formats never turn an
    // extraction/summarization request into a transform.  Once the user's
    // wording explicitly asks to modify or transform provided files, Runtime
    // may require a workspace result without claiming an output format.
    if (
      (intent.artifactAction === "modify" || intent.artifactAction === "transform")
      && (task.sources ?? []).some((source) => source.status === "ready")
    ) {
      return {
        ...intent,
        deliverySurface: "workspace_artifact" as const,
        wantsArtifact: true,
        wantsConversationAnswer: false,
      };
    }
    return intent;
  }
  // A server-validated reusable artifact is an explicit workspace deliverable
  // target. Its format, rather than a lossy paraphrase of the latest turn,
  // owns the native transformation boundary.
  return {
    ...intent,
    deliverySurface: "workspace_artifact" as const,
    artifactAction: "modify" as const,
    artifactKind: conversationArtifactKind(target),
    sourceNeed: "none" as const,
    researchPolicy: undefined,
    wantsArtifact: true,
    wantsConversationAnswer: false,
  };
}

function planningTaskProfile(task: TaskSpec): TaskProfile {
  const taskIntent = planningTaskIntent(task);
  const priorArtifactTransformation = conversationArtifactTransformationTarget(task) !== undefined;
  const operationProfiles = relevantOperationProfiles(task);
  const operationProfileIds = new Set(operationProfiles.map((profile) => profile.id));
  const artifactKind = taskIntent.artifactKind;
  const uploadedArtifactTransformation = isUploadedArtifactTransformationTask(task, taskIntent);
  const sourceNeed = taskIntent.sourceNeed === "none"
    && (task.sources?.length ?? 0) > 0
    && task.responseOnly !== true
    && !uploadedArtifactTransformation
    && !priorArtifactTransformation
    ? "source_grounded"
    : taskIntent.sourceNeed;
  const recovery = task.conversationWorkingSet?.failedBoundaries.length
    || task.conversationWorkingSet?.activeGoal?.unfinished === true;
  const dataAnalysisSourceTask = !priorArtifactTransformation
    && operationProfileIds.has("data_analysis")
    && (taskHasVisibleDataSource(task) || taskHasUploadedDataSource(task));
  const planShape = recovery
    ? "recovery_patch"
    : uploadedArtifactTransformation || priorArtifactTransformation
      ? "single_leaf"
      : dataAnalysisSourceTask
        ? "fact_then_produce"
        : artifactKind !== "none" && (sourceNeed === "source_grounded" || sourceNeed === "strict_user_source")
          ? "fact_then_produce"
          : "single_leaf";
  return buildTaskProfile({
    phase: "planning",
    intent: recovery ? "recover" : "execute",
    operations: operationProfiles,
    evidenceProfile: sourceNeed === "none"
      ? "deterministic"
      : sourceNeed === "strict_user_source"
        ? "risk_sensitive"
        : sourceNeed,
    riskProfile: inferRiskProfile(task.availableToolNames),
    planShape,
    artifactKind,
    artifactAction: taskIntent.artifactAction,
    sourceNeed,
    researchPolicy: taskIntent.researchPolicy,
    deliverySurface: taskIntent.deliverySurface,
    skillBound: task.availableSkills.length > 0,
    responseOnly: task.responseOnly === true,
  });
}

function inferArtifactKind(input: string): NonNullable<TaskProfile["artifactKind"]> {
  return classifyTaskIntent({ objective: input }).artifactKind;
}

function inferSourceNeed(input: string): NonNullable<TaskProfile["sourceNeed"]> {
  return classifyTaskIntent({ objective: input }).sourceNeed;
}

function taskHasVisibleDataSource(task: TaskSpec): boolean {
  return (task.visibleDirectories?.length ?? 0) > 0
    && task.availableToolNames.some((name) =>
      name === "visible_index_directory"
      || name === "visible_extract_tables"
      || name === "visible_read_files"
      || name === "visible_find_files"
    );
}

function taskHasUploadedDataSource(task: TaskSpec): boolean {
  return (task.sources ?? []).some((source) =>
    /(?:csv|tsv|xls|xlsx|xlsm|spreadsheet|sheet|table|json|ndjson|parquet)/iu.test([
      source.originalName,
      source.mimeType,
      source.extension,
    ].join(" "))
  );
}

/**
 * An uploaded artifact can be either evidence for a new deliverable or the
 * native work product being transformed. Only the first case needs a durable
 * fact-acquisition boundary. The latter stays under the format Skill that can
 * inspect and modify the original bytes without reducing them to prose first.
 */
function isUploadedArtifactTransformationTask(
  task: TaskSpec,
  taskIntent: ReturnType<typeof classifyTaskIntent>,
): boolean {
  if (
    taskIntent.deliverySurface !== "workspace_artifact"
    || taskIntent.sourceNeed !== "none"
    || !task.availableToolNames.includes("materialize_source_file")
  ) return false;
  if (taskIntent.artifactAction !== "modify" && taskIntent.artifactAction !== "transform") return false;
  const objective = planningIntentObjective(task);
  const genericArtifactReference = taskIntent.artifactAction === "transform"
    || referencesProvidedArtifact(objective);
  const normalizedObjective = objective.toLowerCase();
  return (task.sources ?? []).some((source) =>
    source.status === "ready"
    && (
      genericArtifactReference
      || (source.originalName.trim().length > 0 && normalizedObjective.includes(source.originalName.toLowerCase()))
    )
  );
}

/**
 * Prior accepted artifacts already live in the conversation workspace. Unlike
 * uploads, they do not need source materialization, but their identity must
 * be resolved by Runtime before Planner treats the request as a native edit.
 */
function conversationArtifactTransformationTarget(task: TaskSpec): ConversationReusableArtifact | undefined {
  const target = task.turnResolution?.targetArtifact;
  if (target === undefined || task.turnResolution?.evidenceDemand !== "none") return undefined;
  return task.conversationWorkingSet?.reusableArtifacts.find((artifact) =>
    artifact.reusable && artifact.runId === target.runId && artifact.path === target.path,
  );
}

function conversationArtifactKind(artifact: ConversationReusableArtifact): NonNullable<TaskProfile["artifactKind"]> {
  const signal = `${artifact.path} ${artifact.name} ${artifact.mimeType}`.toLowerCase();
  if (/(?:\.pptx?\b|powerpoint|presentationml)/u.test(signal)) return "presentation";
  if (/(?:\.xlsx?\b|\.xlsm\b|spreadsheetml|\bexcel\b|\.csv\b)/u.test(signal)) return "spreadsheet";
  if (/(?:\.html?\b|text\/html)/u.test(signal)) return "html";
  if (/(?:\.png\b|\.jpe?g\b|\.webp\b|\.gif\b|\.svg\b|image\/)/u.test(signal)) return "image";
  if (/(?:\.js\b|\.ts\b|\.py\b|\.json\b|\.yaml?\b|text\/x-)/u.test(signal)) return "code";
  return "document";
}

function referencesProvidedArtifact(value: string): boolean {
  return /(?:\b(?:this|that|the|attached|uploaded|provided|source|original|existing|current)\s+(?:file|artifact|document|presentation|slides?|deck|spreadsheet|workbook|image)\b|(?:这(?:份|个|张)|该(?:份|个|张)?|上传的|提供的|原始|原有|现有|当前).{0,16}(?:文件|文档|报告|演示文稿|幻灯片|课件|pptx?|表格|工作簿|xlsx?|图片|图像|海报))/iu.test(value);
}

function nativePrimaryBuilderSkillIds(
  task: TaskSpec,
  artifactKind: NonNullable<TaskProfile["artifactKind"]>,
): string[] {
  if (artifactKind === "none") {
    const available = new Set(task.availableSkills.map((skill) => skill.id));
    return (task.selectedSkillRoles ?? [])
      .filter((selection) => selection.role === "primary_builder" && available.has(selection.skillId))
      .map((selection) => selection.skillId);
  }
  return task.availableSkills
    .filter((skill) =>
      skill.agentLoop?.roles.includes("primary_builder") === true
      && skill.agentLoop.artifactKinds.includes(artifactKind)
    )
    .map((skill) => skill.id);
}

function inferRiskProfile(toolNames: readonly string[]): NonNullable<TaskProfile["riskProfile"]> {
  if (toolNames.some((name) => /(?:email|send|publish|deploy|payment|delete|remove|dangerous)/iu.test(name))) {
    return "external_side_effect";
  }
  if (toolNames.some((name) => /(?:web|http|fetch|search|browser|network)/iu.test(name))) {
    return "external_network";
  }
  if (toolNames.some((name) => /(?:write|create|patch|edit|run|command|save|export)/iu.test(name))) {
    return "workspace_write";
  }
  if (toolNames.some((name) => /(?:read|list|inspect|find|search)/iu.test(name))) return "read_only";
  return "no_tool";
}

function planningIntentObjective(task: TaskSpec): string {
  const effectiveGoal = task.turnResolution?.effectiveGoal ?? task.input;
  // Every resolved effectiveGoal is self-contained. Appending the prior active
  // goal to a resolved new_goal would reintroduce exactly the cross-turn
  // semantic contamination the Resolver boundary is meant to remove.
  const inheritsActiveGoal = task.turnResolution === undefined;
  return [...new Set([
    effectiveGoal,
    ...(task.turnResolution?.userConstraints ?? []),
    task.input,
    inheritsActiveGoal ? task.conversationWorkingSet?.activeGoal?.goal ?? "" : "",
    inheritsActiveGoal ? task.conversationWorkingSet?.resumeSuggestion ?? "" : "",
  ].map((value) => value.trim()).filter((value) => value.length > 0))].join("\n");
}

function selectInitialSkillRoles(
  skills: readonly TaskSpec["availableSkills"][number][],
  taskProfile: TaskProfile,
): SelectedSkillRole[] {
  if (skills.length === 0) return [];
  return skills.map((skill) => ({
    skillId: skill.id,
    role: taskProfile.artifactKind === "none" && taskProfile.sourceNeed !== "none"
      ? "source_provider"
      : "primary_builder",
    reason: "Selected by deterministic first-round relevance filtering for the current TaskProfile.",
  }));
}

function planningRuntimeContext(
  task: TaskSpec,
  turn: number,
  runtimeDirective: string | undefined,
  taskProfile: TaskProfile = buildTaskProfile({
    phase: "planning",
    intent: task.responseOnly === true ? "reply" : "execute",
    operations: relevantOperationProfiles(task),
    skillBound: task.availableSkills.length > 0,
    responseOnly: task.responseOnly === true,
  }),
  selectedSkillRoles: readonly SelectedSkillRole[] = [],
): RuntimeContextSnapshot {
  const availableCapabilities = planningCapabilitiesForTask(task);
  return {
    id: `${task.runId}:planning:${turn}`,
    phase: "planning",
    ...(turn === 1 ? {} : { supersedesId: `${task.runId}:planning:${turn - 1}` }),
    content: [
      "<planning_context source=\"server\">",
      JSON.stringify({
        availableSkillIds: task.availableSkills.map((skill) => skill.id),
        availableCapabilities,
        capabilityCatalog: {
          schema: "agentloop.capabilityCatalog/v1",
          namespace: "execution_capability",
          allowedIds: availableCapabilities.map((capability) => capability.id),
          usage: "Only these IDs may appear in leaves[].requiredCapabilities. Other planning-context identifiers remain in their own namespaces.",
        },
        operationProfileCatalog: {
          schema: "agentloop.operationProfileCatalog/v1",
          namespace: "operation_profile",
          classificationOnly: true,
          ids: taskProfile.operations.map((profile) => profile.id),
        },
        ...(task.requiredToolSourceIds === undefined || task.requiredToolSourceIds.length === 0
          ? {}
          : { requiredToolSourceIds: task.requiredToolSourceIds }),
        ...(task.workspaceFacts === undefined ? {} : { workspaceFacts: task.workspaceFacts }),
        visibleDirectories: task.visibleDirectories ?? [],
        sources: task.sources ?? [],
        uploadedSourceContext: uploadedSourcePlanningContext(task.sources ?? []),
        ...(task.conversationWorkingSet === undefined ? {} : { conversationWorkingSet: task.conversationWorkingSet }),
        ...(task.turnResolution === undefined ? {} : { turnResolution: task.turnResolution }),
        ...((task.planningExtensionContexts?.length ?? 0) === 0 ? {} : {
          planningExtensionContexts: task.planningExtensionContexts,
        }),
        ...artifactFollowupContextField(task),
        stepGranularity: STEP_GRANULARITY_GUIDANCE,
        operationProfiles: taskProfile.operations,
        taskProfile,
        candidateSkillRoles: selectedSkillRoles,
        candidateSkillRolePolicy: "These are relevance candidates, not selected Plan dependencies. Include a Skill in submit_outcome_plan.selectedSkillRoles only when a concrete leaf binds and executes that Skill; otherwise omit it.",
        ...(task.continuationSkillIds === undefined || task.continuationSkillIds.length === 0
          ? {}
          : {
            continuationSkillIds: task.continuationSkillIds,
            continuationSkillPolicy: "These are Skills canonically bound by completed prior steps. They remain available context, not selected Plan dependencies. Re-evaluate them against the latest TaskProfile, request, conversation history, and completedStepContexts; do not infer continuation from a keyword alone. A source_provider-only continuation belongs on a new fact_acquisition leaf only when the latest turn actually needs source work; do not bind it to an artifact-producing leaf merely because it supplied the prior content.",
          }),
        ...(taskProfile.researchPolicy === undefined
          ? {}
          : {
            researchPlanningPolicy: {
              schema: taskProfile.researchPolicy.schema,
              instruction:
                "Use this policy only to shape source/research leaves and their evidence contracts; do not add research work to unrelated artifact or direct-answer leaves.",
              authorityRule: taskProfile.researchPolicy.authorityNeed === "official_required"
                ? "The user explicitly requires official or exact-source verification. Missing required official evidence may block claims that depend on it."
                : "Rank sources by relevance, traceability, and reliability. Official or first-party sources are useful when accessible, but are not a completion gate. After bounded attempts, use credible independent or industry sources and deliver the supported summary with explicit caveats.",
              depth: taskProfile.researchPolicy.depth,
              maxSearches: taskProfile.researchPolicy.maxSearches,
              maxFetches: taskProfile.researchPolicy.maxFetches,
              authorityNeed: taskProfile.researchPolicy.authorityNeed,
              freshnessNeed: taskProfile.researchPolicy.freshnessNeed,
              stopWhen: taskProfile.researchPolicy.stopWhen,
            },
          }),
        ...(task.conversationWorkingSet?.evidenceLedger === undefined
          ? {}
          : {
            evidenceReusePolicy: "Use bounded completed source summaries as prior evidence for downstream production. Do not repeat acquisition solely to recreate them; seek new sources only for an explicit request for updated, additional, or stricter verification.",
          }),
        outcomePlanContract: {
          schema: "agentloop.outcomePlan/v2",
          callablePlanningTool: SUBMIT_OUTCOME_PLAN_TOOL.name,
          capabilityCatalogSemantics: "requiredCapabilities accepts only IDs from capabilityCatalog.allowedIds. Runtime Admission resolves those authorized execution capabilities to tools after the Plan is submitted; identifiers from other planning namespaces are not capabilities.",
          skillIdPolicy: "Only availableSkillIds are Skills; capabilities, Tools, ToolSources, and evidence IDs use requiredCapabilities. Empty availableSkillIds means no Skills.",
          sourceConstraintPolicy: "Set sourceConstraint to null when a leaf has no concrete ToolSource, uploaded source, or visible-directory binding; never send sourceConstraint: {}. When present, use requiredToolSourceIds only for host-registered ToolSources and bind every requiredToolSourceIds item through a leaf.sourceConstraint. Use requiredUploadedSourceIds only for concrete IDs listed in sources when the leaf reads those uploads. Use requiredVisibleDirectoryIds only for IDs listed in visibleDirectories when the leaf invokes visible_* tools with rootId. Set unused sourceConstraint ID arrays to null. Never cross these identity namespaces.",
          allowedLeafRoles: ["fact_acquisition", "produce", "deliver", "repair"],
          allowedEvidenceKinds: EVIDENCE_KIND_VALUES,
          caveatPolicies: CAVEAT_POLICY_VALUES,
          evidenceContractPolicy: evidenceContractPolicyForTask(task, taskProfile),
          firstRoundRules: [
            "submit exactly one OutcomePlan",
            "do not submit plan patches",
            "do not create QA or repair leaves unless TaskProfile.planShape is recovery_patch",
            "candidateSkillRoles are suggestions only; do not copy them into selectedSkillRoles unless a concrete leaf binds and executes that Skill",
            "initial selectedSkillRoles may use only primary_builder or source_provider; support and qa roles are recovery-only",
            "every initially selected Skill, regardless of role, must be bound to a concrete leaf that uses it",
          ],
        },
      }),
      "</planning_context>",
      formatDynamicPromptContext(taskProfile),
      formatAvailableSkills(task.availableSkills),
      ...(runtimeDirective === undefined ? [] : [
        "<runtime_directive>",
        runtimeDirective,
        "</runtime_directive>",
      ]),
    ].filter(Boolean).join("\n"),
  };
}

function submitOutcomePlanToolForTask(task: TaskSpec): ModelInvocation["tools"][number] {
  const allowedCapabilityIds = planningCapabilitiesForTask(task).map((capability) => capability.id).sort();
  return {
    ...SUBMIT_OUTCOME_PLAN_TOOL,
    inputSchema: {
      ...SUBMIT_OUTCOME_PLAN_TOOL.inputSchema,
      properties: {
        ...SUBMIT_OUTCOME_PLAN_TOOL.inputSchema.properties,
        leaves: {
          ...SUBMIT_OUTCOME_PLAN_TOOL.inputSchema.properties.leaves,
          items: {
            ...OUTCOME_LEAF_SCHEMA,
            properties: {
              ...OUTCOME_LEAF_SCHEMA.properties,
              requiredCapabilities: {
                type: "array",
                items: { type: "string", enum: allowedCapabilityIds },
              },
            },
          },
        },
      },
    },
  };
}

function planningCapabilitiesForTask(task: TaskSpec): readonly PlanningCapability[] {
  return task.availableCapabilities
    ?? (task.availableTools === undefined
      ? planningCapabilitiesFromToolNames(task.availableToolNames, task.sources)
      : planningCapabilitiesFromTools(task.availableTools, task.sources));
}

function evidenceContractPolicyForTask(task: TaskSpec, taskProfile: TaskProfile): Record<string, unknown> {
  const capabilities = planningCapabilitiesForTask(task);
  const sourceBoundCapabilities = capabilitiesForConcreteTaskSources(task, capabilities);
  const producibleSourceKinds = new Set(sourceBoundCapabilities.flatMap((capability) => capability.produces));
  const sourceKinds = (["source_summary", "source_urls", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"] as const)
    .filter((kind) => producibleSourceKinds.has(kind));
  const strictSourceKinds = sourceKinds.includes("source_summary")
    ? (["source_summary", ...(sourceKinds.includes("source_urls") ? ["source_urls" as const] : [])] as const)
    : sourceKinds.filter((kind) => kind !== "explicit_caveats").slice(0, 1);
  const progressiveSourceKinds = sourceKinds.includes("source_urls")
    ? (["source_urls", ...(sourceKinds.includes("explicit_caveats") ? ["explicit_caveats" as const] : [])] as const)
    : strictSourceKinds;
  const requiredSourceKinds = taskProfile.sourceNeed === "lookup_lite"
    ? progressiveSourceKinds
    : strictSourceKinds;
  if (taskProfile.deliverySurface === "conversation" && taskProfile.artifactKind === "none") {
    const requiresSourceEvidence = taskProfile.sourceNeed !== undefined && taskProfile.sourceNeed !== "none";
    return {
      schema: "agentloop.evidenceContractPolicy/v1",
      principle: "Evidence contracts follow the semantic delivery surface. Source evidence, final conversation delivery, and workspace artifact delivery are separate evidence families.",
      finalDeliverySurface: "conversation",
      sourceFactAcquisition: {
        useWhen: "the task has visible directories, uploaded files, bulk data, or source-grounded analysis requirements",
        recommendedRequiredKinds: sourceKinds,
        ...(requiresSourceEvidence ? { requiredKinds: requiredSourceKinds } : {}),
        note: "Use structured extraction artifacts for reusable data evidence, but do not treat that source artifact as the final user deliverable.",
      },
      finalProduceOrDeliverLeaf: {
        defaultRequiredKinds: [],
        forbiddenKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "artifact_openable", "format_matches_request"],
        note: "For conversation-only answers, Runtime retains delivery events automatically; require evidence only for source provenance, high-risk facts, or external side effects.",
      },
    };
  }
  if (taskProfile.deliverySurface === "workspace_artifact" && taskProfile.artifactKind !== undefined && taskProfile.artifactKind !== "none") {
    return {
      schema: "agentloop.evidenceContractPolicy/v1",
      principle: "Evidence contracts follow the semantic delivery surface. Source evidence, final conversation delivery, and workspace artifact delivery are separate evidence families.",
      finalDeliverySurface: "workspace_artifact",
      sourceFactAcquisition: {
        useWhen: "the requested artifact depends on visible directories, uploaded files, bulk data, or source-grounded analysis requirements",
        recommendedRequiredKinds: sourceKinds,
      },
      finalProduceOrDeliverLeaf: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt"],
        recommendedWhenAvailable: ["artifact_acceptance", "artifact_openable"],
        note: "For requested file/media artifacts, final delivery must be backed by observable artifact evidence; final prose alone is not enough.",
      },
    };
  }
  return {
    schema: "agentloop.evidenceContractPolicy/v1",
    principle: "Use the smallest evidence contract that matches the task semantics; do not add artifact evidence unless the user requested a workspace artifact.",
    finalProduceOrDeliverLeaf: {
      defaultRequiredKinds: [],
    },
  };
}

/**
 * Evidence-policy recommendations must describe the concrete inputs in this
 * Run.  In particular, an upload must not inherit evidence kinds from a
 * workspace reader whose only valid input is an artifact from an earlier
 * operation.  Admission remains the authoritative fail-closed check.
 */
function capabilitiesForConcreteTaskSources(
  task: TaskSpec,
  capabilities: readonly PlanningCapability[],
): readonly PlanningCapability[] {
  const sourceKinds = new Set<PlanningCapability["sourceKinds"][number]>();
  if ((task.sources?.length ?? 0) > 0) sourceKinds.add("uploaded_source");
  if ((task.visibleDirectories?.length ?? 0) > 0) sourceKinds.add("visible_directory");
  if (sourceKinds.size === 0) return capabilities;
  return capabilities.filter((capability) => capability.sourceKinds.some((kind) => sourceKinds.has(kind)));
}

function relevantOperationProfiles(task: TaskSpec): ReturnType<typeof operationProfileCatalogForPlanning> {
  const catalog = operationProfileCatalogForPlanning();
  const artifactFollowup = buildArtifactFollowupContext(task);
  const objective = planningIntentObjective(task);
  const taskIntent = planningTaskIntent(task);
  const selected = inferOperationProfile({
    objective,
    successCriteria: [],
    toolNames: [],
    skillNames: task.availableSkills.map((skill) => skill.name),
  });
  const selectedIds = new Set([selected.id]);
  if (artifactFollowup !== undefined && taskIntent.sourceNeed === "none") {
    selectedIds.clear();
    selectedIds.add("artifact_build");
  } else if (taskIntent.deliverySurface === "workspace_artifact") {
    selectedIds.delete("direct_answer");
    selectedIds.add("artifact_build");
  }
  if (artifactFollowup === undefined && taskIntent.sourceNeed !== "none") {
    selectedIds.delete("direct_answer");
    selectedIds.add("web_research");
  }
  const hasSkillExecutionSurface = task.availableSkills.length > 0
    || (task.conversationWorkingSet?.recommendedCapabilities.skillIds.length ?? 0) > 0;
  if (selected.id === "direct_answer" && hasSkillExecutionSurface) {
    selectedIds.delete("direct_answer");
    selectedIds.add("content_generation");
    selectedIds.add("artifact_build");
  }
  return catalog.filter((profile) => selectedIds.has(profile.id));
}

function artifactFollowupContextField(task: TaskSpec): { readonly artifactFollowup?: ReturnType<typeof buildArtifactFollowupContext> } {
  const artifactFollowup = buildArtifactFollowupContext(task);
  return artifactFollowup === undefined ? {} : { artifactFollowup };
}

function buildArtifactFollowupContext(task: TaskSpec): {
  readonly schema: "agentloop.artifactFollowup/v1";
  readonly intent: "convert_artifact" | "edit_existing_artifact" | "create_file_from_delivery_text" | "artifact_followup";
  readonly requestedOutputFormat?: string;
  readonly candidateSourceArtifacts: readonly {
    readonly path: string;
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: number;
    readonly runId: string;
    readonly reason: string;
  }[];
  readonly candidateSourceResults: readonly NonNullable<NonNullable<TaskSpec["conversationWorkingSet"]>["resultCards"]>[number][];
  readonly sourceSelectionPolicy: readonly string[];
} | undefined {
  const workset = task.conversationWorkingSet;
  if (workset === undefined) return undefined;
  const text = normalizePlannerText(planningIntentObjective(task)).toLowerCase();
  const requestedOutputFormat = requestedOutputFormatFromText(text);
  const artifactMentioned = /(?:\b(?:artifact|file|pdf|markdown|md|html|docx?|word|txt)\b|文件|产物|这个|该|上(?:一|个)轮|刚才)/iu.test(text);
  const conversionRequested = requestedOutputFormat !== undefined
    && /(?:\b(?:convert|export|render|generate|create|save|produce|make)\b|转|转换|导出|生成|创建|保存|输出|产出|制作)/iu.test(text);
  const editRequested = artifactMentioned
    && /(?:\b(?:edit|update|modify|change|correct|replace|rename|title)\b|编辑|修改|更改|改为|改成|改掉|替换|标题|重命名|修正)/iu.test(text);
  const taskIntent = planningTaskIntent(task);
  const deliveryTextFileRequested = taskIntent.deliverySurface === "workspace_artifact"
    && artifactMentioned
    && /(?:\b(?:generate|create|save|produce|make|write|export)\b|生成|创建|保存|输出|产出|制作|写|导出)/iu.test(text);
  if (!conversionRequested && !editRequested && !deliveryTextFileRequested) return undefined;

  const artifacts = [...workset.reusableArtifacts].reverse();
  const candidates = artifacts
    .map((artifact) => {
      const reason = artifactFollowupReason(artifact, text, requestedOutputFormat, editRequested);
      return reason === undefined ? undefined : {
        path: artifact.path,
        name: artifact.name,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
        runId: artifact.runId,
        reason,
      };
    })
    .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined)
    .slice(0, 5);

  const boundResult = conversationResultInput(task);
  const candidateSourceResults = boundResult === undefined
    ? []
    : [boundResult];
  if (candidates.length === 0 && candidateSourceResults.length === 0) return undefined;
  return {
    schema: "agentloop.artifactFollowup/v1",
    intent: editRequested
      ? "edit_existing_artifact"
      : conversionRequested
        ? "convert_artifact"
        : candidates.length === 0 && deliveryTextFileRequested
          ? "create_file_from_delivery_text"
          : "artifact_followup",
    ...(requestedOutputFormat === undefined ? {} : { requestedOutputFormat }),
    candidateSourceArtifacts: candidates,
    candidateSourceResults,
    sourceSelectionPolicy: [
      "Prefer an explicitly referenced reusable artifact path or file name from conversationWorkingSet.reusableArtifacts.",
      "For editing an existing artifact in place, use computer_patch_file when available and then verify the patched artifact; do not rewrite the whole file unless the required change cannot be expressed as a unique local patch.",
      "For artifact conversion, use convert_artifact when available; prefer reusable Markdown, HTML, text, document, or PPTX artifacts as the conversion source before completed delivery text. PPTX sources currently convert directly to PDF through the portable PPTX renderer.",
      "When the requested source exists only as model-generated or completed delivery Markdown text, first materialize it as a reusable .md artifact with computer_write_file, then pass that artifact to convert_artifact and verify the converted output; never pass raw content to convert_artifact or introduce a separate format-specific converter.",
      "For a candidateSourceResults entry, its result ref is a formal Plan input. Use its compact summary first and read_result with its opaque resultId for needed content; do not substitute source reacquisition merely because the prior result has source lineage.",
      "Use uploaded or original sources only when the user explicitly asks to reanalyze, regenerate from source data, or change source-grounded content.",
    ],
  };
}

function conversationResultInput(task: TaskSpec): NonNullable<NonNullable<TaskSpec["conversationWorkingSet"]>["resultCards"]>[number] | undefined {
  const target = task.turnResolution?.targetResult;
  if (target === undefined || task.turnResolution?.evidenceDemand !== "none") return undefined;
  return task.conversationWorkingSet?.resultCards?.find((item) =>
    item.result.resultId === target.resultId,
  );
}

function runtimeResultBindingsForPlanningTask(task: TaskSpec): readonly RuntimeResultBinding[] {
  const resolution = task.turnResolution;
  if (resolution?.targetResult === undefined || resolution.relation === "new_goal") return [];
  return [{
    schema: "agentloop.resultBinding/v1",
    result: resolution.targetResult,
    relation: resolution.relation,
  }];
}

function artifactFollowupReason(
  artifact: ConversationReusableArtifact,
  text: string,
  requestedOutputFormat: string | undefined,
  editRequested: boolean,
): string | undefined {
  const path = artifact.path.toLowerCase();
  const name = artifact.name.toLowerCase();
  if (path.length > 0 && text.includes(path)) return "explicit_path_match";
  if (name.length > 0 && text.includes(name)) return "explicit_name_match";
  if (editRequested && requestedOutputFormat !== undefined && artifactFormatFamily(path) === requestedOutputFormat) {
    return "requested_existing_artifact_format";
  }
  if (requestedOutputFormat !== undefined && isConvertibleArtifact(artifact.path, artifact.mimeType, requestedOutputFormat)) {
    return "preferred_artifact_conversion_source";
  }
  if (requestedOutputFormat !== undefined && artifactFormatFamily(path) === requestedOutputFormat) {
    return "requested_output_format_artifact";
  }
  return undefined;
}

function truncatePlannerContextText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

function requestedOutputFormatFromText(text: string): string | undefined {
  const targetMatch = text.match(
    /(?:\b(?:convert|export|render|save|generate|create|produce|make)(?:\s+to|\s+as)?\b|转\s*(?:成|为)?|转换\s*(?:成|为)?|导出\s*(?:成|为)?|输出\s*(?:成|为)?|生成\s*(?:一份|一个)?|创建\s*(?:一份|一个)?|保存\s*(?:成|为)?).{0,24}\b(pdf|markdown|md|html|docx?|word|txt)\b/iu,
  );
  const value = targetMatch?.[1] ?? [...text.matchAll(/\b(pdf|markdown|md|html|docx?|word|txt)\b/giu)].at(-1)?.[1];
  if (value === undefined) return undefined;
  return canonicalArtifactFormatFamily(value);
}

function isConvertibleArtifact(path: string, mimeType: string, requestedOutputFormat: string): boolean {
  const source = artifactFormatFamily(path);
  const target = canonicalArtifactFormatFamily(requestedOutputFormat);
  if (source === target) return false;
  if (source === "markdown" || source === "html" || source === "txt" || source === "word") {
    return true;
  }
  if (!["word", "pdf", "html", "markdown", "txt"].includes(target)) return false;
  return /(?:markdown|html|plain|wordprocessingml|msword)/iu.test(mimeType);
}

function artifactFormatFamily(path: string): string | undefined {
  const extension = artifactExtension(path);
  return extension === undefined ? undefined : canonicalArtifactFormatFamily(extension);
}

function artifactExtension(path: string): string | undefined {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/u);
  return match?.[1];
}

function summarizePlanningError(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 220);
}

function assertInitialOutcomePlanShape(proposal: PlanProposal, task: TaskSpec): void {
  const taskIntent = planningTaskIntent(task);
  const priorResultMaterialization = conversationResultInput(task) !== undefined
    && taskIntent.deliverySurface === "workspace_artifact";
  if (priorResultMaterialization && proposal.steps.some((step) => step.role === "fact_acquisition")) {
    throw new AppError(
      "PLANNING_ERROR",
      "A workspace artifact derived from a bound prior Runtime Result must materialize that formal input in its producer leaf; do not add fact acquisition unless the current user request requires refresh or verification",
      422,
    );
  }
  if (
    taskIntent.deliverySurface === "workspace_artifact"
    && proposal.steps.every((step) => !stepCanProduceObservableArtifact(step))
  ) {
    throw new AppError(
      "PLANNING_ERROR",
      "OutcomePlan turns a requested workspace artifact into a text-only delivery; include an artifact-producing leaf with observable artifact evidence",
      422,
      { artifactKind: taskIntent.artifactKind, deliverySurface: taskIntent.deliverySurface },
    );
  }
  const uploadedArtifactTransformation = isUploadedArtifactTransformationTask(task, taskIntent);
  if (uploadedArtifactTransformation || conversationArtifactTransformationTarget(task) !== undefined) {
    const primaryBuilderSkillIds = nativePrimaryBuilderSkillIds(task, taskIntent.artifactKind);
    const onlyStep = proposal.steps[0];
    // A continuation after a failed artifact Run may legitimately be a
    // recovery patch. It still has the same non-splittable ownership boundary:
    // one primary builder leaf owns the original file through acceptance.
    const hasSingleNativeTransformationBoundary = proposal.shape === "single_leaf"
      || proposal.shape === "recovery_patch";
    const ownsNativeTransformation = primaryBuilderSkillIds.length === 0
      || primaryBuilderSkillIds.some((skillId) =>
        onlyStep?.skillIds.includes(skillId) === true
        && proposal.selectedSkillRoles?.some((selection) =>
          selection.skillId === skillId && selection.role === "primary_builder"
        ) === true
      );
    if (
      !hasSingleNativeTransformationBoundary
      || proposal.steps.length !== 1
      || onlyStep?.role === "fact_acquisition"
      || !ownsNativeTransformation
    ) {
      throw new AppError(
        "PLANNING_ERROR",
        uploadedArtifactTransformation
          ? `An uploaded artifact transformation must use one primary-builder leaf that owns original-file materialization, native-format work, and final acceptance; do not create a generic fact-acquisition/source-summary leaf; eligible primary-builder Skills: ${primaryBuilderSkillIds.join(", ")}`
          : "An artifact transformation must use one primary-builder leaf that owns the target file, native-format work, and final acceptance; do not create a generic fact-acquisition/source-summary leaf",
        422,
        { artifactKind: taskIntent.artifactKind, deliverySurface: taskIntent.deliverySurface },
      );
    }
  }
  if (isEmptyConversationWorkspace(task) && !explicitWorkspaceInspectionRequested(task.input)) {
    const inspectionStep = proposal.steps.find((step) => isWorkspaceInspectionStep(step));
    if (inspectionStep !== undefined) {
      throw new AppError(
        "PLANNING_ERROR",
        `Step ${inspectionStep.id} turns empty workspace context intake into Plan work; use planning.workspaceFacts/v1 and plan the requested outcome directly`,
        422,
      );
    }
  }
  const recoveryPlan = proposal.shape === "recovery_patch";
  if (!recoveryPlan && proposal.steps.some((step) => step.role === "repair")) {
    throw new AppError(
      "PLANNING_ERROR",
      "Initial OutcomePlan cannot contain repair leaves unless TaskProfile.planShape is recovery_patch",
      422,
    );
  }
  const invalidRoleSkills = (proposal.selectedSkillRoles ?? []).filter((selection) =>
    !recoveryPlan && (selection.role === "support" || selection.role === "qa")
  );
  if (invalidRoleSkills.length > 0) {
    throw new AppError(
      "PLANNING_ERROR",
      `Initial OutcomePlan cannot expose support/qa Skill roles (${invalidRoleSkills.map((selection) => selection.skillId).join(", ")})`,
      422,
    );
  }
}

function stepCanProduceObservableArtifact(step: PlanStepProposal): boolean {
  // An omitted contract is still allowed for legacy/custom planners; Runtime
  // observes the resulting file evidence. Legacy Skill-bound planners also
  // use the bound Skill as the execution signal and receive the Runtime-owned
  // artifact contract during normalization. delivery_receipt is an audit
  // record, not a semantic assertion that the step is text-only. An explicit
  // non-artifact contract (for example, a HIL direction/caveat contract),
  // however, is a semantic claim that this terminal step does not deliver the
  // requested workspace artifact.
  const semanticEvidenceKinds = step.evidenceContract?.requiredKinds.filter((kind) =>
    kind !== "delivery_receipt" && kind !== "basic_navigation",
  ) ?? [];
  if (
    semanticEvidenceKinds.length === 0
    && (step.requiredCapabilities.includes("workspace_artifact_write") || step.skillIds.length > 0)
  ) return true;
  return step.evidenceContract?.requiredKinds.some((kind) =>
    kind === "artifact_path"
    || kind === "artifact_non_empty"
    || kind === "artifact_acceptance"
    || kind === "artifact_openable"
    || kind === "format_matches_request"
  ) === true;
}

function normalizeOutcomePlanProposal(proposal: PlanProposal, task: TaskSpec): PlanProposal {
  const taskProfile = planningTaskProfile(task);
  const terminalStepIds = terminalLeafStepIds(proposal.steps);
  const normalizedSteps: PlanStepProposal[] = proposal.steps.map((step) => {
    const sourceMaterializationNormalized = normalizeUploadedSourceTransformationStep(
      step,
      terminalStepIds,
      taskProfile,
      task,
    );
    const sourcePolicyNormalized = normalizeProgressiveSourceContract(sourceMaterializationNormalized, taskProfile);
    const deliveryNormalized = normalizeConversationOnlyTerminalStep(sourcePolicyNormalized, terminalStepIds, taskProfile, task);
    const artifactNormalized = normalizeWorkspaceArtifactTerminalStep(deliveryNormalized, terminalStepIds, taskProfile, task);
    if (artifactNormalized.evidenceContract !== undefined) return artifactNormalized;
    const coreCriteria = artifactNormalized.successCriteria.filter((criterion) =>
      !isUnrequestedOptionalEnhancementCriterion(criterion.description, task.input)
    );
    if (coreCriteria.length > 0) return { ...artifactNormalized, successCriteria: coreCriteria };
    return {
      ...artifactNormalized,
      successCriteria: [{
        id: `${step.id}-core-delivery`,
        description: coreSuccessCriterionDescription(artifactNormalized),
        source: "planner" as const,
      }],
    };
  });
  return {
    ...proposal,
    steps: normalizedSteps.map((step) => normalizeStructuredAggregationLeaf(step, normalizedSteps, task)),
  };
}

/**
 * Uploaded-source summaries preserve content semantics, but file transforms
 * need the immutable original bytes. Bind the generic materialization
 * capability to the terminal producer instead of exposing server storage
 * paths or relying on the model to rediscover an inaccessible upload root.
 */
function normalizeUploadedSourceTransformationStep(
  step: PlanStepProposal,
  terminalStepIds: ReadonlySet<string>,
  taskProfile: TaskProfile,
  task: TaskSpec,
): PlanStepProposal {
  if (
    taskProfile.deliverySurface !== "workspace_artifact"
    || !terminalStepIds.has(step.id)
    || step.role === "fact_acquisition"
    || !task.availableToolNames.includes("materialize_source_file")
  ) return step;
  const taskIntent = planningTaskIntent(task);
  if (!isUploadedArtifactTransformationTask(task, taskIntent)) return step;
  const readySourceIds = (task.sources ?? [])
    .filter((source) => source.status === "ready")
    .map((source) => source.id);
  const boundSourceIds = step.sourceConstraint?.requiredUploadedSourceIds ?? readySourceIds;
  if (boundSourceIds.length === 0) return step;
  return {
    ...step,
    requiredCapabilities: uniquePlannerStrings([
      ...step.requiredCapabilities,
      "uploaded_source_materialization",
    ]),
    sourceConstraint: {
      ...step.sourceConstraint,
      requiredUploadedSourceIds: uniquePlannerStrings(boundSourceIds),
    },
  };
}

/**
 * A user-requested file cannot converge through prose. Runtime-owned artifact
 * evidence is mandatory when the planning model omits the evidence contract
 * on the terminal producer. An explicit Planner-authored contract remains
 * authoritative, including when it is intentionally weak.
 */
function normalizeWorkspaceArtifactTerminalStep(
  step: PlanStepProposal,
  terminalStepIds: ReadonlySet<string>,
  taskProfile: TaskProfile,
  task: TaskSpec,
): PlanStepProposal {
  if (
    taskProfile.deliverySurface !== "workspace_artifact"
    || taskProfile.artifactKind === undefined
    || taskProfile.artifactKind === "none"
    || !terminalStepIds.has(step.id)
    || step.role === "fact_acquisition"
    || step.evidenceContract !== undefined
  ) return step;
  const runtimeRequiredKinds: EvidenceKind[] = [
    "artifact_path",
    "artifact_non_empty",
    "format_matches_request",
    "delivery_receipt",
    ...(task.availableToolNames.includes("verify_artifact_acceptance")
      ? ["artifact_acceptance" as const]
      : []),
  ];
  const requiredKinds = uniqueEvidenceKinds([
    ...runtimeRequiredKinds,
  ]);
  const existingCriteria = new Map(step.successCriteria.map((criterion) => [criterion.id, criterion]));
  for (const kind of runtimeRequiredKinds) {
    if (!existingCriteria.has(kind)) {
      existingCriteria.set(kind, {
        id: kind,
        description: evidenceCriterionDescription(kind, "none"),
        source: "planner",
      });
    }
  }
  return {
    ...step,
    evidenceContract: {
      requiredKinds,
      caveatPolicy: "none",
    },
    successCriteria: [...existingCriteria.values()],
  };
}

/**
 * Lookup-lite web research is progressively deliverable from traceable
 * discovery metadata plus explicit caveats. Source-grounded work still reads
 * source content, but an inaccessible official source never becomes blocking;
 * only Runtime-owned strict_user_source may require official evidence.
 */
function normalizeProgressiveSourceContract(
  step: PlanStepProposal,
  taskProfile: TaskProfile,
): PlanStepProposal {
  const contract = step.evidenceContract;
  if (contract === undefined || taskProfile.sourceNeed === "strict_user_source") return step;
  const discoveryCanSupportBoundedDelivery = taskProfile.sourceNeed === "lookup_lite"
    && taskProfile.deliverySurface === "conversation"
    && taskProfile.operations.some((operation) => operation.id === "web_research")
    && contract.requiredKinds.includes("source_urls");
  const requiredKinds = discoveryCanSupportBoundedDelivery
    ? contract.requiredKinds.filter((kind) => kind !== "source_summary")
    : contract.requiredKinds;
  const caveatPolicy = contract.caveatPolicy === "strict_fail_on_missing_source"
    ? "mark_unverified_facts"
    : contract.caveatPolicy;
  if (requiredKinds.length === contract.requiredKinds.length && caveatPolicy === contract.caveatPolicy) return step;
  return {
    ...step,
    evidenceContract: {
      ...contract,
      requiredKinds,
      caveatPolicy,
    },
  };
}

/**
 * A complete structured artifact is an input to a count/group/rank question,
 * not an optional hint. Keep this at the Plan boundary: tools expose neutral
 * records and receipts, while this rule only recognizes aggregation semantics.
 */
function normalizeStructuredAggregationLeaf(
  step: PlanStepProposal,
  allSteps: readonly PlanStepProposal[],
  task: TaskSpec,
): PlanStepProposal {
  if (
    step.role === "fact_acquisition"
    || !aggregationRequested(`${task.input}\n${step.objective}`)
    || !dependsOnStructuredExtraction(step, allSteps)
    || !task.availableToolNames.includes("computer_aggregate_table_artifact")
  ) return step;
  const requiredKinds = uniqueEvidenceKinds([
    ...(step.evidenceContract?.requiredKinds ?? []),
    "derived_aggregation",
    "explicit_caveats",
  ]);
  const caveatPolicy = step.evidenceContract?.caveatPolicy ?? "mark_unverified_facts";
  return {
    ...step,
    role: step.role === undefined ? "deliver" : step.role,
    requiredCapabilities: [...new Set([...step.requiredCapabilities, "workspace_structured_artifact_read"])],
    evidenceContract: { requiredKinds, caveatPolicy },
    successCriteria: requiredKinds.map((kind) => ({
      id: kind,
      description: evidenceCriterionDescription(kind, caveatPolicy),
      source: "planner" as const,
    })),
  };
}

function dependsOnStructuredExtraction(
  step: PlanStepProposal,
  allSteps: readonly PlanStepProposal[],
): boolean {
  const byId = new Map(allSteps.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (seen.has(stepId)) return false;
    seen.add(stepId);
    const candidate = byId.get(stepId);
    if (candidate === undefined) return false;
    if (
      candidate.evidenceContract?.requiredKinds.includes("structured_extraction_artifact")
      || (
        (
          candidate.requiredCapabilities.includes("uploaded_table_extraction")
          || candidate.requiredCapabilities.includes("visible_table_extraction")
          || candidate.requiredCapabilities.includes("workspace_structured_artifact_read")
        )
        && /(?:extract|table|spreadsheet|workbook|csv|xlsx|xlsm|表格|工作簿|工作表|抽取)/iu.test(candidate.objective)
      )
    ) return true;
    return candidate.dependencies.some(visit);
  };
  return step.dependencies.some(visit);
}

function aggregationRequested(value: string): boolean {
  return /(?:\b(?:count|how many|group(?:ed|ing)?|distribution|rank(?:ing)?|top|bottom|max(?:imum)?|min(?:imum)?|average|mean|sum|total)\b|数量|多少|计数|统计|分组|分布|排行|排名|最高|最低|最大|最小|均值|平均|总数|合计|汇总|占比)/iu.test(value);
}

function uniqueEvidenceKinds(values: readonly EvidenceKind[]): EvidenceKind[] {
  return [...new Set(values)];
}

function uniquePlannerStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function terminalLeafStepIds(steps: readonly PlanStepProposal[]): ReadonlySet<string> {
  const dependedOn = new Set(steps.flatMap((step) => step.dependencies));
  return new Set(steps
    .filter((step) => (step.kind ?? "leaf") === "leaf" && !dependedOn.has(step.id))
    .map((step) => step.id));
}

function normalizeConversationOnlyTerminalStep(
  step: PlanStepProposal,
  terminalStepIds: ReadonlySet<string>,
  taskProfile: TaskProfile,
  task: TaskSpec,
): PlanStepProposal {
  const conversationOnly = (taskProfile.deliverySurface === "conversation" && taskProfile.artifactKind === "none")
    || task.responseOnly === true;
  if (!conversationOnly) return step;
  if (!terminalStepIds.has(step.id) || step.role === "fact_acquisition" || step.role === "repair") return step;
  const evidenceContract = step.evidenceContract;
  if (evidenceContract === undefined) return {
    ...step,
    successCriteria: step.successCriteria.filter((criterion) => !isArtifactDeliveryEvidenceKind(criterion.id)),
  };
  const requiredKinds = evidenceContract.requiredKinds.filter((kind) =>
    !isArtifactDeliveryEvidenceKind(kind) && kind !== "delivery_receipt"
  );
  if (requiredKinds.length === 0) return {
    ...step,
    evidenceContract: undefined,
    successCriteria: step.successCriteria.filter((criterion) => !isArtifactDeliveryEvidenceKind(criterion.id)),
  };
  return {
    ...step,
    evidenceContract: { ...evidenceContract, requiredKinds },
    successCriteria: requiredKinds.map((kind) => ({
      id: kind,
      description: evidenceCriterionDescription(kind, evidenceContract.caveatPolicy),
      source: "planner",
    })),
  };
}

function isArtifactDeliveryEvidenceKind(kind: string): kind is typeof ARTIFACT_DELIVERY_EVIDENCE_KIND_VALUES[number] {
  return (ARTIFACT_DELIVERY_EVIDENCE_KIND_VALUES as readonly string[]).includes(kind);
}

function coreSuccessCriterionDescription(step: PlanStepProposal): string {
  const text = normalizePlannerText(`${step.id}\n${step.objective}`);
  if (/(?:html[-_ ]?ppt|html|网页|页面|浏览器)/iu.test(text)) {
    return "Deliver the requested HTML artifact with an observable workspace path and non-empty file evidence.";
  }
  if (/(?:source|research|web|fact|来源|调研|检索|事实|资料)/iu.test(text)) {
    return "Produce a bounded fact summary with available source references and explicit caveats for unavailable facts.";
  }
  return "Produce observable evidence for the step objective without making unrequested optional enhancements blocking.";
}

function isEmptyConversationWorkspace(task: TaskSpec): boolean {
  return task.workspaceFacts?.schema === "planning.workspaceFacts/v1"
    && task.workspaceFacts.kind === "conversation_workspace"
    && task.workspaceFacts.state === "empty"
    && task.workspaceFacts.visibleDirectoryCount === 0
    && (task.workspaceFacts.sourceCount ?? 0) === 0;
}

function explicitWorkspaceInspectionRequested(input: string): boolean {
  const text = normalizePlannerText(input);
  return /(?:inspect|scan|explore|check|read|analyze|modify|update|refactor|debug|fix|look\s+at|查看|检查|分析|梳理|定位|修改|修复|调试|基于现有)/iu.test(text)
    && /(?:workspace|project|repo|repository|codebase|source|directory|folder|files?|工作区|项目|仓库|代码库|源码|目录|文件|已有|现有)/iu.test(text);
}

function isWorkspaceInspectionStep(step: PlanStepProposal): boolean {
  const text = normalizePlannerText([
    step.id,
    step.objective,
    ...step.successCriteria.map((criterion) => criterion.description),
  ].join("\n"));
  if (isArtifactDeliveryReceiptStep(step, text)) return false;
  const usesInspectionTools = step.requiredCapabilities.includes("workspace_file_read")
    || step.requiredCapabilities.includes("visible_directory_read");
  return usesInspectionTools
    && /(?:workspace|project|repo|repository|codebase|entry|framework|directory|folder|工作区|项目|仓库|代码库|入口|技术栈|目录|文件结构)/iu.test(text)
    && /(?:inspect|scan|explore|identify|determine|survey|inventory|勘察|检查|识别|确定|梳理|探查)/iu.test(text);
}

function isArtifactDeliveryReceiptStep(step: PlanStepProposal, text: string): boolean {
  if (!isArtifactProducingStep(step)) return false;
  const hasDeliveryIntent = /(?:deliver|delivery|create|produce|generate|write|build|export|save|artifact|file|path|workspace path|交付|创建|生成|制作|写入|构建|导出|保存|产物|文件|路径|工作区路径)/iu
    .test(text);
  if (!hasDeliveryIntent) return false;
  return /(?:receipt|readback|non-empty|openable|readable|exists|local build|local read|交付回执|读取确认|读回|非空|可打开|可读|本地构建|本地读取|路径明确)/iu
    .test(text);
}

function isArtifactProducingStep(step: PlanStepProposal): boolean {
  return step.requiredCapabilities.includes("workspace_artifact_write")
    || step.evidenceContract?.requiredKinds.some((kind) => isArtifactDeliveryEvidenceKind(kind)) === true;
}

function isUnrequestedOptionalEnhancementCriterion(description: string, userInput: string): boolean {
  const criterion = normalizePlannerText(description);
  const input = normalizePlannerText(userInput);
  if (explicitStrictQualityRequested(input)) return false;
  if (explicitSourceStrictnessRequested(input) && matchesSourceStrictness(criterion)) return false;
  if (explicitVisualEnhancementRequested(input) && matchesVisualEnhancement(criterion)) return false;
  if (explicitNavigationEnhancementRequested(input) && matchesNavigationEnhancement(criterion)) return false;
  if (explicitExampleEnhancementRequested(input) && matchesExampleEnhancement(criterion)) return false;
  return matchesSourceStrictness(criterion)
    || matchesVisualEnhancement(criterion)
    || matchesNavigationEnhancement(criterion)
    || matchesExampleEnhancement(criterion);
}

function explicitStrictQualityRequested(input: string): boolean {
  return /(?:strict quality|must pass acceptance|pixel-perfect|release validation|严格质量|必须验收|终检|发布验收|上线验收)/iu.test(input);
}

function explicitSourceStrictnessRequested(input: string): boolean {
  return /(?:official|authoritative|full-text|source verification|cite every|标准全文|官方|权威|来源核验|逐条|逐项|精确条款|引用每|出处完整)/iu.test(input);
}

function explicitVisualEnhancementRequested(input: string): boolean {
  return /(?:visual|theme|beautiful|polish|design|chart|diagram|matrix|timeline|professional|视觉|主题|美观|设计|图表|流程图|矩阵|时间线|专业|排版)/iu.test(input);
}

function explicitNavigationEnhancementRequested(input: string): boolean {
  return /(?:html[-_ ]?ppt|presentation|slides?|deck|keyboard|progress|pagination|responsive|navigation|screen|演示|课件|幻灯片|键盘|进度|页码|响应式|导航|翻页|演示屏)/iu.test(input);
}

function explicitExampleEnhancementRequested(input: string): boolean {
  return /(?:case|exercise|example|practice|misconception|案例|练习|示例|实操|误区)/iu.test(input);
}

function matchesSourceStrictness(text: string): boolean {
  return /(?:official|authoritative|full-text|standard version|must cite|权威|官方|标准全文|标准版本|逐条|逐项|精确条款|完整来源)/iu.test(text)
    || /(?:无法确认|无法获得|不可访问).{0,24}(不(?:能|得)|阻塞|失败|未完成)/iu.test(text);
}

function matchesVisualEnhancement(text: string): boolean {
  return /(?:visual theme|professional|polish|clear typography|chart|diagram|matrix|timeline|flow|no overflow|unreadable|视觉主题|专业统一|排版清晰|图表|流程|矩阵|时间路线|可视化|无明显内容溢出|不可读元素|美观|高级)/iu.test(text);
}

function matchesNavigationEnhancement(text: string): boolean {
  return /(?:keyboard|progress|page number|pagination|responsive|common screen|navigation|键盘翻页|页码|进度提示|适配|常见演示屏幕|逐页导航|浏览运行检查)/iu.test(text);
}

function matchesExampleEnhancement(text: string): boolean {
  return /(?:case|exercise|example|practice|misconception|roadmap|案例|练习|示例|实操|常见误区|路线图)/iu.test(text);
}

function normalizePlannerText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseOutcomePlanProposal(call: ModelToolCall): PlanProposal {
  try {
    const value = requireRecord(call.arguments, "submit_outcome_plan arguments");
    parseOutcomePlanSchema(value.schema);
    const shape = parseOutcomePlanShape(value.shape);
    const selectedSkillRoles = parseSelectedSkillRoles(value.selectedSkillRoles);
    if (!Array.isArray(value.leaves) || value.leaves.length === 0 || value.leaves.length > 20) {
      throw badRequest("leaves must contain between 1 and 20 entries");
    }
    return {
      schema: "agentloop.outcomePlan/v2",
      goal: requireString(value.goal, "goal", { max: 20_000 }),
      shape,
      selectedSkillRoles,
      selectedSkillIds: [...new Set(selectedSkillRoles.map((selection) => selection.skillId))],
      steps: value.leaves.map((item, index) => parseOutcomeLeaf(item, index)),
    };
  } catch (error) {
    if (error instanceof AppError && error.code === "BAD_REQUEST") {
      throw new AppError("PLANNING_ERROR", error.message, 422);
    }
    throw error;
  }
}

function parseOutcomePlanShape(value: unknown): OutcomePlanShape {
  const shape = requireString(value, "shape", { max: 64 });
  if (
    shape === "single_leaf"
    || shape === "fact_then_produce"
    || shape === "multi_deliverable"
    || shape === "pipeline"
    || shape === "recovery_patch"
  ) {
    return shape;
  }
  throw badRequest("shape is invalid");
}

function parseOutcomePlanSchema(value: unknown): "agentloop.outcomePlan/v2" {
  if (value === undefined) return "agentloop.outcomePlan/v2";
  const schema = requireString(value, "schema", { max: 128 });
  if (schema !== "agentloop.outcomePlan/v2") {
    throw badRequest("schema must be agentloop.outcomePlan/v2");
  }
  return schema;
}

function parseSelectedSkillRoles(value: unknown): SelectedSkillRole[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw badRequest("selectedSkillRoles must be an array with at most 20 entries");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const record = requireRecord(item, `selectedSkillRoles[${index}]`);
    const skillId = requireString(record.skillId, `selectedSkillRoles[${index}].skillId`, { max: 128 });
    const role = parseSkillRole(record.role, index);
    const key = `${skillId}:${role}`;
    if (seen.has(key)) throw badRequest("selectedSkillRoles must not contain duplicates");
    seen.add(key);
    return {
      skillId,
      role,
      reason: requireString(record.reason, `selectedSkillRoles[${index}].reason`, { max: 1_000 }),
    };
  });
}

function parseSkillRole(value: unknown, index: number): SelectedSkillRole["role"] {
  const role = requireString(value, `selectedSkillRoles[${index}].role`, { max: 64 });
  if (role === "primary_builder" || role === "source_provider" || role === "support" || role === "qa") return role;
  throw badRequest(`selectedSkillRoles[${index}].role is invalid`);
}

function parseOutcomeLeaf(value: unknown, index: number): PlanStepProposal {
  const record = requireRecord(value, `leaves[${index}]`);
  const evidenceContract = record.evidenceContract === undefined || record.evidenceContract === null
    ? undefined
    : parseEvidenceContract(record.evidenceContract, index);
  // Some tool-call providers materialize an omitted optional object as `{}` or
  // as an object whose optional ID arrays are all null. A bare
  // sourceConstraint carries no binding semantics, so canonicalize it to
  // absence before Admission rather than rejecting an otherwise valid Plan.
  const sourceConstraint = record.sourceConstraint === undefined || record.sourceConstraint === null
    ? undefined
    : parseSourceConstraint(record.sourceConstraint, index);
  return {
    id: requireString(record.id, `leaves[${index}].id`, { max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
    kind: "leaf",
    objective: requireString(record.objective, `leaves[${index}].objective`, { max: 20_000 }),
    dependencies: requireStringArray(record.dependsOn, `leaves[${index}].dependsOn`, 100),
    role: parseOutcomeLeafRole(record.role, index),
    skillIds: requireStringArray(record.skillIds, `leaves[${index}].skillIds`, 100),
    requiredCapabilities: canonicalStringSet(record.requiredCapabilities, `leaves[${index}].requiredCapabilities`, 100),
    ...(sourceConstraint === undefined ? {} : { sourceConstraint }),
    ...(evidenceContract === undefined ? {
      successCriteria: [{
        id: "delivered",
        description: "The requested outcome is delivered to the user.",
        source: "planner" as const,
      }],
    } : {
      evidenceContract,
      successCriteria: evidenceContract.requiredKinds.map((kind) => ({
        id: kind,
        description: evidenceCriterionDescription(kind, evidenceContract.caveatPolicy),
        source: "planner" as const,
      })),
    }),
  };
}

function parseSourceConstraint(value: unknown, index: number): PlanStepProposal["sourceConstraint"] {
  const record = requireRecord(value, `leaves[${index}].sourceConstraint`);
  if (Object.keys(record).length === 0) return undefined;
  const requiredToolSourceIds = record.requiredToolSourceIds === undefined || record.requiredToolSourceIds === null
    ? []
    : canonicalStringSet(record.requiredToolSourceIds, `leaves[${index}].sourceConstraint.requiredToolSourceIds`, 20);
  const requiredUploadedSourceIds = record.requiredUploadedSourceIds === undefined || record.requiredUploadedSourceIds === null
    ? []
    : canonicalStringSet(record.requiredUploadedSourceIds, `leaves[${index}].sourceConstraint.requiredUploadedSourceIds`, 20);
  const requiredVisibleDirectoryIds = record.requiredVisibleDirectoryIds === undefined || record.requiredVisibleDirectoryIds === null
    ? []
    : canonicalStringSet(record.requiredVisibleDirectoryIds, `leaves[${index}].sourceConstraint.requiredVisibleDirectoryIds`, 20);
  if (requiredToolSourceIds.length === 0 && requiredUploadedSourceIds.length === 0 && requiredVisibleDirectoryIds.length === 0) return undefined;
  return {
    ...(requiredToolSourceIds.length === 0 ? {} : { requiredToolSourceIds }),
    ...(requiredUploadedSourceIds.length === 0 ? {} : { requiredUploadedSourceIds }),
    ...(requiredVisibleDirectoryIds.length === 0 ? {} : { requiredVisibleDirectoryIds }),
  };
}

function parseOutcomeLeafRole(value: unknown, index: number): OutcomeLeafRole {
  const role = requireString(value, `leaves[${index}].role`, { max: 64 });
  if (role === "fact_acquisition" || role === "produce" || role === "deliver" || role === "repair") return role;
  throw badRequest(`leaves[${index}].role is invalid`);
}

function parseEvidenceContract(value: unknown, index: number): EvidenceContract {
  const record = requireRecord(value, `leaves[${index}].evidenceContract`);
  const requiredKinds = canonicalStringSet(record.requiredKinds, `leaves[${index}].evidenceContract.requiredKinds`, 20)
    .filter((kind) => !(SKILL_QA_ONLY_EVIDENCE_KIND_VALUES as readonly string[]).includes(kind))
    .map((kind) => parseEvidenceKind(kind, index));
  if (requiredKinds.length === 0) {
    throw badRequest(`leaves[${index}].evidenceContract.requiredKinds must contain at least 1 Runtime evidence kind`);
  }
  const caveatPolicy = parseCaveatPolicy(record.caveatPolicy, index);
  return { requiredKinds, caveatPolicy };
}

function parseEvidenceKind(value: string, index: number): EvidenceKind {
  if ((EVIDENCE_KIND_VALUES as readonly string[]).includes(value)) return value as EvidenceKind;
  throw badRequest(`leaves[${index}].evidenceContract.requiredKinds contains unsupported evidence kind ${value}`);
}

function parseCaveatPolicy(value: unknown, index: number): CaveatPolicy {
  const policy = requireString(value, `leaves[${index}].evidenceContract.caveatPolicy`, { max: 64 });
  if ((CAVEAT_POLICY_VALUES as readonly string[]).includes(policy)) return policy as CaveatPolicy;
  throw badRequest(`leaves[${index}].evidenceContract.caveatPolicy is invalid`);
}

function evidenceCriterionDescription(kind: EvidenceKind, caveatPolicy: CaveatPolicy): string {
  const suffix = caveatPolicy === "none" ? "" : ` Caveat policy: ${caveatPolicy}.`;
  switch (kind) {
    case "source_summary":
      return `A bounded source summary is available.${suffix}`;
    case "source_urls":
      return `Source URLs or equivalent source references are available.${suffix}`;
    case "schema_summary":
      return `A bounded schema or field summary is available.${suffix}`;
    case "record_counts":
      return `Record, row, range, or cell counts are available.${suffix}`;
    case "table_coverage":
      return `All extracted tables are covered by the summary.${suffix}`;
    case "structured_extraction_artifact":
      return `A durable structured extraction artifact or content-addressed reference is available.${suffix}`;
    case "derived_aggregation":
      return `A complete, coverage-backed aggregation derived from the structured records is available.${suffix}`;
    case "artifact_path":
      return "The delivered artifact path is recorded.";
    case "artifact_non_empty":
      return "The delivered artifact is non-empty.";
    case "artifact_acceptance":
      return "A structured artifact acceptance evidence object records the applicable file, format, openability, tool-reported checks, and caveats.";
    case "artifact_openable":
      return "The delivered artifact can be opened by the appropriate local/browser tool.";
    case "format_matches_request":
      return "The delivered artifact format matches the user request.";
    case "basic_navigation":
      return "Basic navigation is a Skill-owned QA signal, not generic Runtime delivery evidence.";
    case "delivery_receipt":
      return "A delivery receipt identifies the final user-facing result.";
    case "explicit_caveats":
      return `Unavailable or unverified facts are explicitly caveated.${suffix}`;
  }
}

function canonicalStringSet(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw badRequest(`${label} must be an array with at most ${maximum} entries`);
  }
  return [...new Set(value.map((item, index) =>
    requireString(item, `${label}[${index}]`, { max: 128 })
  ))];
}
