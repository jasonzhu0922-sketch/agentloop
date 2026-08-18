import { randomUUID } from "node:crypto";
import { AppError, badRequest } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { ModelAdapter, ModelInvocation, ModelToolCall, RuntimeContextSnapshot, RuntimeEventSink } from "../runtime/contracts.ts";
import { completeWithStreaming } from "../runtime/model-streaming.ts";
import { formatAvailableSkills, formatLoadedSkill } from "../skills/skill-context.ts";
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

const LOAD_SKILL_TOOL = {
  name: "load_skill",
  description: [
    "Load the exact authorized Skill instructions when the task matches an entry in available_skills.",
    "The returned Skill body and its relative-path base become the authoritative workflow context for planning.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string" } },
  },
} as const;

const MAX_PLANNING_ATTEMPTS = 3;
const MAX_PLANNING_TURNS = 8;

export class ModelPlanner implements Planner {
  private readonly model: ModelAdapter;

  constructor(model: ModelAdapter) {
    this.model = model;
  }

  async plan(task: TaskSpec, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<PlanProposal> {
    const messages: ModelInvocation["messages"] = [
      { role: "user", content: task.input },
    ];
    const availableByName = new Map(task.availableSkills.map((skill) => [skill.name, skill]));
    const loadedSkillIds = new Set<string>();
    const tools = task.availableSkills.length === 0
      ? [SUBMIT_PLAN_TOOL]
      : [LOAD_SKILL_TOOL, SUBMIT_PLAN_TOOL];
    const systemPrompt = [
      "You are the planning phase of a plan-first agent runtime.",
      "You do not execute the task and you cannot declare completion.",
      "Only the Skill catalog is initially visible. When a Skill matches the task, call load_skill and read its exact body before selecting or binding it.",
      "Do not call load_skill and submit_plan in the same response: Skill instructions must be observed before the Plan is authored.",
      "After all relevant Skills are loaded, return exactly one submit_plan tool call and no other tool call.",
      "Select only relevant Skills. Bind every selected Skill to at least one concrete step.",
      "Build an acyclic dependency graph. Tool names and IDs must come from the supplied catalogs.",
      "Each step needs observable success criteria. Do not copy the Skill body into step prose and do not put the Plan in prose.",
      "Every step must include the tools needed to prove its own success criteria. Do not defer a written artifact's required read-back or content verification to a later step, because a later step cannot retroactively make the current step admissible.",
      "Keep the Plan scoped to the user's requested deliverable. Do not add optional polish, critique, or follow-up work as a separate terminal step unless the user explicitly requested it or it is necessary to prove a stated success criterion. Fold required quality checks into the step that produces the deliverable.",
    ].filter(Boolean).join("\n\n");
    let lastError = new AppError("PLANNING_ERROR", "Planner did not produce a valid Plan", 422);
    let planningAttempts = 0;
    let runtimeDirective: string | undefined;
    for (let turn = 1; turn <= MAX_PLANNING_TURNS; turn += 1) {
      const invocation: ModelInvocation = {
        runId: task.runId,
        systemPrompt,
        phase: "planning",
        runtimeContext: planningRuntimeContext(task, turn, runtimeDirective),
        messages,
        tools,
        toolChoice: "required",
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
      const loadCalls = response.toolCalls.filter((call) => call.name === LOAD_SKILL_TOOL.name);
      const planCalls = response.toolCalls.filter((call) => call.name === SUBMIT_PLAN_TOOL.name);

      if (
        response.finishReason !== "length"
        && loadCalls.length > 0
        && loadCalls.length === response.toolCalls.length
      ) {
        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });
        for (const call of loadCalls) {
          try {
            const name = parseSkillLoadName(call.arguments);
            const skill = availableByName.get(name);
            if (skill === undefined) {
              throw new AppError(
                "PLANNING_ERROR",
                `Skill \"${name}\" is not in available_skills`,
                422,
              );
            }
            loadedSkillIds.add(skill.id);
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: formatLoadedSkill(skill),
              isError: false,
            });
          } catch (error) {
            messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: error instanceof Error ? error.message : "Invalid load_skill call",
              isError: true,
            });
          }
        }
        continue;
      }

      try {
        if (response.finishReason === "length") {
          throw planningResponseError(
            "Planner response was truncated",
            turn,
            response,
          );
        }
        if (response.toolCalls.length !== 1 || planCalls.length !== 1) {
          throw planningResponseError(
            loadCalls.length > 0
              ? "Planner must load Skills in a separate response before submitting the Plan"
              : "Planner must submit exactly one structured submit_plan call",
            turn,
            response,
          );
        }
        const proposal = parsePlanProposal(planCalls[0]);
        const unloaded = proposal.selectedSkillIds.filter((skillId) => !loadedSkillIds.has(skillId));
        if (unloaded.length > 0) {
          const names = unloaded.map((skillId) =>
            task.availableSkills.find((skill) => skill.id === skillId)?.name ?? skillId
          );
          throw new AppError(
            "PLANNING_ERROR",
            `Load every selected Skill before submitting the Plan. Not loaded: ${names.join(", ")}`,
            422,
          );
        }
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
            validationError: lastError.message,
            instruction: lastError.message.startsWith("Load every selected Skill")
              ? "Call load_skill for the named Skills, read the results, then submit the complete Plan in a later response."
              : "Resubmit the entire Plan as exactly one valid submit_plan tool call.",
          },
        });
      }
    }
    if (planningAttempts < MAX_PLANNING_ATTEMPTS) {
      lastError = new AppError(
        "PLANNING_ERROR",
        `Planner exceeded its ${MAX_PLANNING_TURNS}-turn Skill loading and Plan submission limit`,
        422,
      );
    }
    throw lastError;
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
        agent: { id: task.agent.id, name: task.agent.name },
        availableToolNames: task.availableToolNames,
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

function parseSkillLoadName(value: unknown): string {
  return requireString(requireRecord(value, "load_skill arguments").name, "load_skill name", { max: 80 });
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
