import { randomUUID } from "node:crypto";
import { AppError, badRequest } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { ModelAdapter, ModelInvocation, ModelToolCall, RuntimeContextSnapshot, RuntimeEventSink } from "../runtime/contracts.ts";
import { completeWithStreaming } from "../runtime/model-streaming.ts";
import { operationProfileCatalogForPlanning } from "../runtime/operation-profiles.ts";
import { formatAvailableSkills } from "../skills/skill-context.ts";
import type {
  PlanProposal,
  PlanStepProposal,
  Planner,
  SuccessCriterion,
  TaskSpec,
} from "./contracts.ts";
import { admitPlan } from "./admission.ts";

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
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "objective", "dependencies", "skillIds", "requiredToolNames", "successCriteria"],
          properties: {
            id: { type: "string" },
            objective: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
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
        },
      },
    },
  },
} as const;

const MAX_PLANNING_ATTEMPTS = 2;
const PLANNING_MAX_OUTPUT_TOKENS = 8_192;
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
      "Do not plan file, image, PDF, or other artifact creation unless a writable, render, generation, or command Tool is available.",
      "Do not create a Plan step whose objective is only to load, activate, fetch, retrieve, or read a Skill.",
      "Skill loading is Runtime preparation for a Skill-bound user-deliverable step; bind the Skill to the concrete work step that uses it.",
      "Keep the Plan scoped to the user's requested deliverable. Do not add optional polish, critique, or follow-up work as a separate terminal step unless the user explicitly requested it or it is necessary to prove a stated success criterion. Fold required quality checks into the step that produces the deliverable.",
      "Prefer the smallest valid Plan. Fold one-off discovery or verification into a production step instead of creating a separate exploration-only step unless the discovery itself is the deliverable.",
      ...(task.responseOnly ? [
        "This is a conversational reply, not an execution request. Create exactly one response step.",
        "The response step must select no Skills and require no Tools. It answers only the latest user message and must not resume, modify, or repeat prior work.",
      ] : []),
    ].filter(Boolean).join("\n\n");
    let lastError = new AppError("PLANNING_ERROR", "Planner did not produce a valid Plan", 422);
    let planningAttempts = 0;
    let runtimeDirective: string | undefined;
    await emit?.({
      type: "planning.started",
      data: {
        availableSkillCount: task.availableSkills.length,
        availableToolCount: task.availableToolNames.length,
      },
    });
    for (let turn = 1; turn <= MAX_PLANNING_ATTEMPTS; turn += 1) {
      const turnRuntimeDirective = runtimeDirective;
      await emit?.({
        type: "planning.turn.started",
        data: {
          turn,
          loadedSkillCount: 0,
          pendingSkillCount: 0,
          hasRuntimeDirective: turnRuntimeDirective !== undefined,
          toolCount: 1,
          messageCount: messages.length,
        },
      });
      const invocation: ModelInvocation = {
        runId: task.runId,
        systemPrompt,
        phase: "planning",
        runtimeContext: planningRuntimeContext(task, turn, turnRuntimeDirective),
        messages,
        tools: [SUBMIT_PLAN_TOOL],
        toolChoice: { name: SUBMIT_PLAN_TOOL.name },
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
      const planCalls = response.toolCalls.filter((call) => call.name === SUBMIT_PLAN_TOOL.name);
      await emit?.({
        type: "planning.turn.completed",
        data: {
          turn,
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
          loadSkillCallCount: 0,
          submitPlanCallCount: planCalls.length,
          loadedSkillCount: 0,
          contentLength: response.content.length,
        },
      });

      try {
        if (response.finishReason === "length") {
          throw planningResponseError(
            "Planner response was truncated",
            turn,
            response,
          );
        }
        if (response.toolCalls.length !== 1 || planCalls.length !== 1) {
          throw planningResponseError("Planner must submit exactly one structured submit_plan call", turn, response);
        }
        const proposal = parsePlanProposal(planCalls[0]);
        if (task.responseOnly) assertResponseOnlyPlan(proposal);
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
        runtimeDirective = JSON.stringify({
          planningRepair: {
            attempt: planningAttempts + 1,
            validationError: summarizePlanningError(lastError.message),
            instruction: response.finishReason === "length"
              ? "Return only one compact submit_plan call. Do not explain or repeat the task. Keep the plan as small as possible."
              : "Resubmit the entire Plan as exactly one valid submit_plan tool call. If a step is too broad, split discovery/extraction, production/writing, and verification/comparison into smaller dependency-linked steps with their own success criteria. If the invalid step only loads or activates a Skill, remove that infrastructure step and bind the Skill to the concrete user-deliverable step.",
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

function assertResponseOnlyPlan(proposal: PlanProposal): void {
  if (proposal.selectedSkillIds.length !== 0 || proposal.steps.length !== 1) {
    throw new AppError("PLANNING_ERROR", "A conversational reply must contain exactly one no-Skill response step", 422);
  }
  const [step] = proposal.steps;
  if (step.skillIds.length !== 0 || step.requiredToolNames.length !== 0) {
    throw new AppError("PLANNING_ERROR", "A conversational reply step cannot use Skills or Tools", 422);
  }
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
        stepGranularity: STEP_GRANULARITY_GUIDANCE,
        operationProfiles: operationProfileCatalogForPlanning(),
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

function summarizePlanningError(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 220);
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
    objective: requireString(record.objective, `steps[${index}].objective`, { max: 20_000 }),
    dependencies: requireStringArray(record.dependencies, `steps[${index}].dependencies`, 100),
    skillIds: requireStringArray(record.skillIds, `steps[${index}].skillIds`, 100),
    requiredToolNames: canonicalStringSet(record.requiredToolNames, `steps[${index}].requiredToolNames`, 100),
    successCriteria: criteria.length === 0
      ? [{ id: `criterion-${randomUUID()}`, description: "Produce observable evidence for this objective", source: "planner" }]
      : criteria,
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
