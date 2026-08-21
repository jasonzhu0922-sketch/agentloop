import { randomUUID } from "node:crypto";
import { AppError, badRequest } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { ModelAdapter, ModelInvocation, ModelToolCall, RuntimeContextSnapshot, RuntimeEventSink } from "../runtime/contracts.ts";
import { completeWithStreaming } from "../runtime/model-streaming.ts";
import { inferOperationProfile, operationProfileCatalogForPlanning } from "../runtime/operation-profiles.ts";
import { formatAvailableSkills } from "../skills/skill-context.ts";
import type {
  PlanProposal,
  PlanStepProposal,
  Planner,
  SuccessCriterion,
  TaskSpec,
} from "./contracts.ts";
import { admitPlan } from "./admission.ts";

const PLAN_STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "objective", "dependencies", "skillIds", "requiredToolNames", "successCriteria"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["leaf", "milestone"] },
    parentId: { type: "string" },
    objective: { type: "string" },
    dependencies: { type: "array", items: { type: "string" } },
    refinementState: { type: "string", enum: ["not_refinable", "pending_facts", "ready_to_refine", "refining", "refined"] },
    requiredFacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "evidenceKinds"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          evidenceKinds: { type: "array", items: { type: "string" } },
          satisfiedBy: { type: "array", items: { type: "string" } },
        },
      },
    },
    skillIds: { type: "array", items: { type: "string" } },
    requiredToolNames: { type: "array", uniqueItems: true, items: { type: "string" } },
    successCriteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description"],
        properties: { id: { type: "string" }, description: { type: "string" } },
      },
    },
  },
} as const;

const SUBMIT_PLAN_TOOL = {
  name: "submit_plan",
  description: "Submit the complete dependency-aware execution plan. This is the only valid planning response.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "selectedSkillIds", "steps"],
    properties: {
      goal: { type: "string" },
      selectedSkillIds: { type: "array", items: { type: "string" } },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: PLAN_STEP_SCHEMA,
      },
    },
  },
} as const;

const SUBMIT_PLAN_PATCH_TOOL = {
  name: "submit_plan_patch",
  description: "Repair the previously rejected Plan by replacing only invalid steps. Do not resubmit unchanged steps.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["replacements"],
    properties: {
      replacements: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["targetStepId", "replacementSteps", "downstreamDependencyStepId"],
          properties: {
            targetStepId: { type: "string" },
            replacementSteps: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: PLAN_STEP_SCHEMA,
            },
            downstreamDependencyStepId: { type: "string" },
          },
        },
      },
    },
  },
} as const;

const MAX_PLANNING_ATTEMPTS = 3;
const PLANNING_MAX_OUTPUT_TOKENS = 8_192;
const PLANNING_PATCH_MAX_OUTPUT_TOKENS = 4_096;
const STEP_GRANULARITY_GUIDANCE = {
  stepContract: [
    "One Plan step is one assessable operation unit with one dominant work phase.",
    "A step may use multiple tools only when they serve the same phase and produce the same evidence boundary.",
    "Every step must be small enough that its success criteria can be assessed without continuing into a different phase.",
  ],
  splitWhen: [
    "Discovery, extraction, or reverse engineering is needed before production.",
    "Data source profiling, extraction-program authoring, extraction execution, report writing, or verification each needs its own success evidence.",
    "The task creates or modifies a reusable artifact and then verifies it.",
    "Different success evidence is needed for source understanding, artifact creation, and verification.",
    "The objective contains a chain such as read/reconstruct/confirm/write/verify or inspect/build/test.",
  ],
  mergeOnlyWhen: [
    "The work is a tiny one-off direct answer or direct deliverable and verification is a local check of that same artifact.",
    "No intermediate evidence, script, source profile, or downstream deliverable needs to be reused by another step.",
  ],
  recommendedPatterns: [
    {
      when: "turn prior evidence or analysis into a reusable script, workflow, or tool",
      steps: [
        "extract_contract_or_spec",
        "author_reusable_artifact",
        "verify_reusable_artifact",
      ],
    },
    {
      when: "analyze data and write a report from reusable evidence",
      steps: [
        "profile_data_source",
        "author_extraction_program",
        "run_extraction_program",
        "write_report_from_evidence",
        "verify_report_or_outputs",
      ],
    },
  ],
} as const;

export class ModelPlanner implements Planner {
  private readonly model: ModelAdapter;

  constructor(model: ModelAdapter) {
    this.model = model;
  }

  async plan(task: TaskSpec, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<PlanProposal> {
    await emit?.({
      type: "planning.started",
      data: {
        availableSkillCount: task.availableSkills.length,
        availableToolCount: task.availableToolNames.length,
      },
    });
    if (task.responseOnly) {
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
      return responseOnlyPlan(task.input);
    }
    const messages: ModelInvocation["messages"] = [
      ...(task.conversationHistory ?? []),
      { role: "user", content: task.input },
    ];
    const systemPrompt = [
      "You are the planning phase of a plan-first agent runtime.",
      "You do not execute the task and you cannot declare completion.",
      "Use only the Skill catalog summaries to choose relevant Skills or none.",
      "Use the available Tool descriptions to decide whether requested artifacts can actually be produced in this Run.",
      "Return exactly one submit_plan tool call and no other tool call.",
      "Select only relevant Skills. Bind every selected Skill to at least one concrete step.",
      "Build an acyclic dependency graph. Tool names and IDs must come from the supplied catalogs.",
      "Use kind=\"leaf\" for executable steps. You may use kind=\"milestone\" only as a lightweight non-executable phase boundary for work that should be refined later from durable evidence.",
      "Milestone steps must not require execution Tools. They are planning structure, not completion evidence.",
      "Each step needs observable success criteria. Do not copy the Skill body into step prose and do not put the Plan in prose.",
      "Every step must include the tools needed to prove its own success criteria.",
      "Use the operation profile catalog in the planning context to shape each step's working method. Profiles are generic operation disciplines, not business-domain instructions.",
      "Before calling submit_plan, choose the smallest dependency-linked operation units using the stepGranularity guidance in the planning context.",
      "Keep each step as one bounded operation unit. Split discovery/extraction, production/writing, and verification/comparison into dependency-linked steps when they need different evidence or tool phases.",
      "When the task asks to convert prior work, analysis evidence, or source material into a reusable script, workflow, or tool, plan separate steps for extracting the reusable contract, authoring the artifact, and verifying it.",
      "For data-analysis work, plan for structured extraction evidence rather than repeated raw stdout dumps or a success criterion that requires all raw cells/rows.",
      "For data-to-report work over files or bulk data, default to separate steps for source profiling, extraction-program authoring when needed, extraction execution, report writing, and verification.",
      "Keep extraction and writing boundaries explicit: an extraction step must not produce the final report, and the writing step must consume the extraction artifact rather than re-read or re-dump the source data.",
      "A source-profiling step should identify files/sheets/tables/fields/ranges/counts only; a later extraction execution step should produce the reusable evidence artifact.",
      "When conversation.workset/v1 is present, use it as persisted context for follow-up requests: continue from unfinished Plan steps, reuse listed artifacts, preserve failed boundary facts, and bind the required capabilities that still apply.",
      "Do not restart completed upstream steps solely because the latest user message says to continue; plan the smallest continuation that consumes prior durable outputs.",
      "Do not plan file, image, PDF, or other artifact creation unless a writable, render, generation, or command Tool is available.",
      "Do not create a Plan step whose objective is only to load, activate, fetch, retrieve, or read a Skill.",
      "Skill loading is Runtime preparation for a Skill-bound user-deliverable step; bind the Skill to the concrete work step that uses it.",
      "Keep the Plan scoped to the user's requested deliverable. Do not add optional polish, critique, or follow-up work as a separate terminal step unless the user explicitly requested it or it is necessary to prove a stated success criterion.",
      "Required quality checks for an artifact-generating or artifact-modifying step must remain a separate verification step unless they are only the local receipt needed to prove that same step's output exists.",
      "Prefer the smallest valid Plan that preserves phase boundaries. Fold only one-off receipt checks into production; do not fold post-generation rendering, parsing, comparison, quality review, or defect repair into the same step that writes or builds the artifact.",
    ].filter(Boolean).join("\n\n");
    let lastError = new AppError("PLANNING_ERROR", "Planner did not produce a valid Plan", 422);
    let planningAttempts = 0;
    let runtimeDirective: string | undefined;
    let rejectedProposalForPatch: PlanProposal | undefined;
    for (let turn = 1; turn <= MAX_PLANNING_ATTEMPTS; turn += 1) {
      const turnRuntimeDirective = runtimeDirective;
      const patchTurn = rejectedProposalForPatch !== undefined && turn === 2;
      const planningTool = patchTurn ? SUBMIT_PLAN_PATCH_TOOL : SUBMIT_PLAN_TOOL;
      await emit?.({
        type: "planning.turn.started",
        data: {
          turn,
          loadedSkillCount: 0,
          pendingSkillCount: 0,
          hasRuntimeDirective: turnRuntimeDirective !== undefined,
          toolCount: 1,
          repairMode: patchTurn ? "patch" : "full",
          messageCount: messages.length,
        },
      });
      const invocation: ModelInvocation = {
        runId: task.runId,
        systemPrompt: patchTurn ? planPatchSystemPrompt(systemPrompt) : systemPrompt,
        phase: "planning",
        runtimeContext: planningRuntimeContext(task, turn, turnRuntimeDirective),
        messages,
        tools: [planningTool],
        toolChoice: { name: planningTool.name },
        maxOutputTokens: Math.min(
          patchTurn ? PLANNING_PATCH_MAX_OUTPUT_TOKENS : PLANNING_MAX_OUTPUT_TOKENS,
          this.model.limits.maxOutputTokens,
        ),
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
      const planCalls = response.toolCalls.filter((call) => call.name === SUBMIT_PLAN_TOOL.name);
      const patchCalls = response.toolCalls.filter((call) => call.name === SUBMIT_PLAN_PATCH_TOOL.name);
      await emit?.({
        type: "planning.turn.completed",
        data: {
          turn,
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          loadSkillCallCount: 0,
          submitPlanCallCount: planCalls.length,
          submitPlanPatchCallCount: patchCalls.length,
          loadedSkillCount: 0,
          contentLength: response.content.length,
          repairMode: patchTurn ? "patch" : "full",
        },
      });

      let rejectedProposal: PlanProposal | undefined;
      try {
        if (response.finishReason === "length") {
          throw planningResponseError(
            "Planner response was truncated",
            turn,
            response,
          );
        }
        if (!patchTurn && (response.toolCalls.length !== 1 || planCalls.length !== 1)) {
          throw planningResponseError("Planner must submit exactly one structured submit_plan call", turn, response);
        }
        if (patchTurn && (response.toolCalls.length !== 1 || patchCalls.length !== 1)) {
          throw planningResponseError("Planner must submit exactly one structured submit_plan_patch call", turn, response);
        }
        const proposal = patchTurn
          ? applyPlanPatch(rejectedProposalForPatch, parsePlanPatch(patchCalls[0]))
          : parsePlanProposal(planCalls[0]);
        rejectedProposal = proposal;
        admitPlan({
          runId: task.runId,
          proposal,
          availableSkills: task.availableSkills,
          availableToolNames: new Set(task.availableToolNames),
        });
        return proposal;
      } catch (error) {
        planningAttempts += 1;
        lastError = error instanceof AppError && error.code === "PLANNING_ERROR"
          ? error
          : new AppError("PLANNING_ERROR", error instanceof Error ? error.message : "Invalid Plan", 422);
        if (planningAttempts === MAX_PLANNING_ATTEMPTS) break;
        rejectedProposalForPatch = rejectedProposal ?? rejectedProposalForPatch;
        runtimeDirective = JSON.stringify({
          planningRepair: {
            attempt: planningAttempts + 1,
            validationError: summarizePlanningError(lastError.message),
            ...(rejectedProposalForPatch === undefined ? {} : { rejectedPlan: summarizePlanProposal(rejectedProposalForPatch) }),
            instruction: response.finishReason === "length"
              ? "Return only one compact submit_plan call. Do not explain or repeat the task. Keep the plan as small as possible."
              : rejectedProposalForPatch !== undefined && turn === 1
                ? "Return exactly one submit_plan_patch call. Replace only invalid steps from rejectedPlan. Keep unchanged steps out of the patch. If a target step is split, set downstreamDependencyStepId to the final replacement step that downstream work should depend on. Keep artifact repair conditional: inspect or verify first, then materialize source modification, rebuild, and final verification only when blocking defects are confirmed."
                : "Resubmit the entire Plan as exactly one valid submit_plan tool call. Audit every step in the resubmitted Plan, not only the previously rejected step. Preserve previously valid split steps and downstream dependencies. If any step is too broad, split discovery/extraction, production/writing, and verification/comparison into smaller dependency-linked steps with their own success criteria. Keep artifact repair conditional: inspect or verify first, then materialize source modification, rebuild, and final verification only when blocking defects are confirmed. Do not introduce a new step that combines source or inspection evidence, write/build/command production, and readback/render/parse/quality verification. If the invalid step only loads or activates a Skill, remove that infrastructure step and bind the Skill to the concrete user-deliverable step.",
          },
        });
      }
    }
    if (planningAttempts < MAX_PLANNING_ATTEMPTS) {
      lastError = new AppError(
        "PLANNING_ERROR",
        `Planner exceeded its ${MAX_PLANNING_ATTEMPTS}-attempt Plan submission limit`,
        422,
      );
    }
    throw lastError;
  }
}

function responseOnlyPlan(input: string): PlanProposal {
  return {
    goal: input.trim().slice(0, 20_000) || "Answer the latest user message",
    selectedSkillIds: [],
    steps: [{
      id: "response",
      objective: "Answer the latest user message directly without using Skills or Tools.",
      dependencies: [],
      skillIds: [],
      requiredToolNames: [],
      successCriteria: [{ id: "answered", description: "A non-empty direct answer is returned." }],
    }],
  };
}

function planPatchSystemPrompt(base: string): string {
  return [
    base,
    "This repair turn must not resubmit the whole Plan.",
    "Return exactly one submit_plan_patch tool call. Replace only rejected or invalid steps from the supplied rejectedPlan.",
    "Every replacement step must still use only supplied Skill IDs and Tool names, keep dependencies acyclic, and carry observable success criteria.",
  ].join("\n\n");
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

function planningRuntimeContext(
  task: TaskSpec,
  turn: number,
  runtimeDirective: string | undefined,
): RuntimeContextSnapshot {
  return {
    id: `${task.runId}:planning:${turn}`,
    phase: "planning",
    ...(turn === 1 ? {} : { supersedesId: `${task.runId}:planning:${turn - 1}` }),
    content: [
      "<planning_context source=\"server\">",
      JSON.stringify({
        availableToolNames: task.availableToolNames,
        availableTools: task.availableTools ?? task.availableToolNames.map((name) => ({ name })),
        visibleDirectories: task.visibleDirectories ?? [],
        ...(task.conversationWorkingSet === undefined ? {} : { conversationWorkingSet: task.conversationWorkingSet }),
        stepGranularity: STEP_GRANULARITY_GUIDANCE,
        operationProfiles: relevantOperationProfiles(task),
      }),
      "</planning_context>",
      formatAvailableSkills(task.availableSkills),
      ...(runtimeDirective === undefined ? [] : [
        "<runtime_directive>",
        runtimeDirective,
        "</runtime_directive>",
      ]),
    ].filter(Boolean).join("\n"),
  };
}

function relevantOperationProfiles(task: TaskSpec): ReturnType<typeof operationProfileCatalogForPlanning> {
  const catalog = operationProfileCatalogForPlanning();
  const selected = inferOperationProfile({
    objective: [
      task.input,
      task.conversationWorkingSet?.activeGoal?.goal ?? "",
      task.conversationWorkingSet?.resumeSuggestion ?? "",
    ].join("\n"),
    successCriteria: [],
    requiredToolNames: [
      ...task.availableToolNames,
      ...(task.conversationWorkingSet?.requiredCapabilities.toolNames ?? []),
    ],
    skillNames: task.availableSkills.map((skill) => skill.name),
  });
  const selectedIds = new Set([selected.id]);
  const hasSkillExecutionSurface = task.availableSkills.length > 0
    || (task.conversationWorkingSet?.requiredCapabilities.skillIds.length ?? 0) > 0;
  if (selected.id === "direct_answer" && hasSkillExecutionSurface) {
    selectedIds.delete("direct_answer");
    selectedIds.add("content_generation");
    selectedIds.add("artifact_build");
  }
  return catalog.filter((profile) => selectedIds.has(profile.id));
}

function summarizePlanningError(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 220);
}

function summarizePlanProposal(proposal: PlanProposal): Record<string, unknown> {
  return {
    goal: proposal.goal.slice(0, 500),
    selectedSkillIds: proposal.selectedSkillIds,
    steps: proposal.steps.map((step) => ({
      id: step.id,
      objective: step.objective.slice(0, 500),
      dependencies: step.dependencies,
      skillIds: step.skillIds,
      requiredToolNames: step.requiredToolNames,
      successCriteria: step.successCriteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.description.slice(0, 300),
      })),
    })),
  };
}

function parsePlanProposal(call: ModelToolCall): PlanProposal {
  try {
    const value = requireRecord(call.arguments, "submit_plan arguments");
    if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 100) {
      throw badRequest("steps must contain between 1 and 100 entries");
    }
    return {
      goal: requireString(value.goal, "goal", { max: 20_000 }),
      selectedSkillIds: requireStringArray(value.selectedSkillIds, "selectedSkillIds", 100),
      steps: value.steps.map((item, index) => parseStep(item, index)),
    };
  } catch (error) {
    if (error instanceof AppError && error.code === "BAD_REQUEST") {
      throw new AppError("PLANNING_ERROR", error.message, 422);
    }
    throw error;
  }
}

interface PlanPatch {
  readonly replacements: readonly PlanStepReplacement[];
}

interface PlanStepReplacement {
  readonly targetStepId: string;
  readonly replacementSteps: readonly PlanStepProposal[];
  readonly downstreamDependencyStepId: string;
}

function parsePlanPatch(call: ModelToolCall): PlanPatch {
  try {
    const value = requireRecord(call.arguments, "submit_plan_patch arguments");
    if (!Array.isArray(value.replacements) || value.replacements.length === 0 || value.replacements.length > 20) {
      throw badRequest("replacements must contain between 1 and 20 entries");
    }
    return {
      replacements: value.replacements.map((item, index) => {
        const replacement = requireRecord(item, `replacements[${index}]`);
        if (!Array.isArray(replacement.replacementSteps) || replacement.replacementSteps.length === 0 || replacement.replacementSteps.length > 20) {
          throw badRequest(`replacements[${index}].replacementSteps must contain between 1 and 20 entries`);
        }
        return {
          targetStepId: requireString(replacement.targetStepId, `replacements[${index}].targetStepId`, { max: 128 }),
          replacementSteps: replacement.replacementSteps.map((step, stepIndex) =>
            parseStep(step, stepIndex)
          ),
          downstreamDependencyStepId: requireString(replacement.downstreamDependencyStepId, `replacements[${index}].downstreamDependencyStepId`, { max: 128 }),
        };
      }),
    };
  } catch (error) {
    if (error instanceof AppError && error.code === "BAD_REQUEST") {
      throw new AppError("PLANNING_ERROR", error.message, 422);
    }
    throw error;
  }
}

function applyPlanPatch(base: PlanProposal | undefined, patch: PlanPatch): PlanProposal {
  if (base === undefined) throw new AppError("PLANNING_ERROR", "Plan patch requires a rejected Plan", 422);
  let steps = [...base.steps];
  const replacedTargets = new Set<string>();
  for (const replacement of patch.replacements) {
    if (replacedTargets.has(replacement.targetStepId)) {
      throw new AppError("PLANNING_ERROR", `Plan patch replaces step ${replacement.targetStepId} more than once`, 422);
    }
    replacedTargets.add(replacement.targetStepId);
    const index = steps.findIndex((step) => step.id === replacement.targetStepId);
    if (index < 0) throw new AppError("PLANNING_ERROR", `Plan patch targets unknown step ${replacement.targetStepId}`, 422);
    const replacementIds = new Set(replacement.replacementSteps.map((step) => step.id));
    if (!replacementIds.has(replacement.downstreamDependencyStepId)) {
      throw new AppError("PLANNING_ERROR", `Plan patch downstreamDependencyStepId ${replacement.downstreamDependencyStepId} is not a replacement step`, 422);
    }
    const unrelatedIds = new Set(steps.map((step) => step.id).filter((id) => id !== replacement.targetStepId));
    for (const replacementId of replacementIds) {
      if (unrelatedIds.has(replacementId)) {
        throw new AppError("PLANNING_ERROR", `Plan patch replacement step ${replacementId} duplicates an existing step`, 422);
      }
    }
    steps = [
      ...steps.slice(0, index),
      ...replacement.replacementSteps,
      ...steps.slice(index + 1).map((step) => ({
        ...step,
        dependencies: step.dependencies.map((dependency) =>
          dependency === replacement.targetStepId ? replacement.downstreamDependencyStepId : dependency
        ),
      })),
    ];
  }
  return { ...base, steps };
}

function parseStep(value: unknown, index: number): PlanStepProposal {
  const record = requireRecord(value, `steps[${index}]`);
  if (!Array.isArray(record.successCriteria) || record.successCriteria.length > 50) {
    throw badRequest(`steps[${index}].successCriteria must be an array with at most 50 entries`);
  }
  const criteria: SuccessCriterion[] = record.successCriteria.map((item, criterionIndex) => {
    const criterion = requireRecord(item, `steps[${index}].successCriteria[${criterionIndex}]`);
    return {
      id: requireString(criterion.id, `criterion id`, { max: 128 }),
      description: requireString(criterion.description, `criterion description`, { max: 2_000 }),
      source: "planner",
    };
  });
  return {
    id: requireString(record.id, `steps[${index}].id`, { max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
    ...parseOptionalStepKind(record.kind, index),
    ...parseOptionalParentId(record.parentId, index),
    objective: requireString(record.objective, `steps[${index}].objective`, { max: 20_000 }),
    dependencies: requireStringArray(record.dependencies, `steps[${index}].dependencies`, 100),
    ...parseOptionalRefinementState(record.refinementState, index),
    ...parseOptionalRequiredFacts(record.requiredFacts, index),
    skillIds: requireStringArray(record.skillIds, `steps[${index}].skillIds`, 100),
    requiredToolNames: canonicalStringSet(record.requiredToolNames, `steps[${index}].requiredToolNames`, 100),
    successCriteria: criteria.length === 0
      ? [{ id: `criterion-${randomUUID()}`, description: "Produce observable evidence for this objective", source: "planner" }]
      : criteria,
  };
}

function parseOptionalStepKind(value: unknown, index: number): Pick<PlanStepProposal, "kind"> {
  if (value === undefined) return {};
  if (value === "leaf" || value === "milestone") return { kind: value };
  throw badRequest(`steps[${index}].kind must be leaf or milestone`);
}

function parseOptionalParentId(value: unknown, index: number): Pick<PlanStepProposal, "parentId"> {
  if (value === undefined) return {};
  return { parentId: requireString(value, `steps[${index}].parentId`, { max: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }) };
}

function parseOptionalRefinementState(value: unknown, index: number): Pick<PlanStepProposal, "refinementState"> {
  if (value === undefined) return {};
  if (
    value === "not_refinable"
    || value === "pending_facts"
    || value === "ready_to_refine"
    || value === "refining"
    || value === "refined"
  ) {
    return { refinementState: value };
  }
  throw badRequest(`steps[${index}].refinementState is invalid`);
}

function parseOptionalRequiredFacts(value: unknown, index: number): Pick<PlanStepProposal, "requiredFacts"> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 100) {
    throw badRequest(`steps[${index}].requiredFacts must be an array with at most 100 entries`);
  }
  return {
    requiredFacts: value.map((item, factIndex) => {
      const fact = requireRecord(item, `steps[${index}].requiredFacts[${factIndex}]`);
      return {
        id: requireString(fact.id, `requiredFact id`, { max: 128 }),
        description: requireString(fact.description, `requiredFact description`, { max: 2_000 }),
        evidenceKinds: requireStringArray(fact.evidenceKinds, `requiredFact evidenceKinds`, 50),
        ...(fact.satisfiedBy === undefined
          ? {}
          : { satisfiedBy: requireStringArray(fact.satisfiedBy, `requiredFact satisfiedBy`, 100) }),
      };
    }),
  };
}

function canonicalStringSet(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw badRequest(`${label} must be an array with at most ${maximum} entries`);
  }
  return [...new Set(value.map((item, index) =>
    requireString(item, `${label}[${index}]`, { max: 128 })
  ))];
}
