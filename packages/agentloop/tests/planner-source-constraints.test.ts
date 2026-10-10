import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_PLANNING_TURNS, MAX_SUPPORTED_PLANNING_TURNS, ModelPlanner } from "../src/planning/planner.ts";
import type { TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";

class RedundantSourceConstraintPlannerModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 40_000, maxOutputTokens: 2_048 } as const;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    assert.equal(request.phase, "planning");
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "submit-redundant-source-constraint",
        name: "submit_outcome_plan",
        arguments: {
          schema: "agentloop.outcomePlan/v2",
          goal: "Read ODS metadata and deliver a DDM-ready summary.",
          shape: "fact_then_produce",
          selectedSkillRoles: [],
          leaves: [
            {
              id: "ods-facts",
              objective: "Read the approved ODS metadata from OntoFlow.",
              dependsOn: [],
              role: "fact_acquisition",
              skillIds: [],
              requiredCapabilities: ["data_asset.ods_read"],
              sourceConstraint: {
                bindings: [{ kind: "tool_source", ids: ["ontoflow-jtbc"] }],
              },
              evidenceContract: {
                requiredKinds: ["source_summary", "schema_summary", "record_counts"],
                caveatPolicy: "strict_fail_on_missing_source",
              },
            },
            {
              id: "ddm-delivery",
              objective: "Create the DDM-ready delivery from the acquired facts.",
              dependsOn: ["ods-facts"],
              role: "produce",
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write"],
              // This is the model error from Run 2082138e: a dependent leaf
              // mechanically repeats provenance that it neither reads nor attests.
              sourceConstraint: {
                bindings: [{ kind: "tool_source", ids: ["ontoflow-jtbc"] }],
              },
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty", "explicit_caveats"],
                caveatPolicy: "mark_unverified_facts",
              },
            },
          ],
        },
      }],
    };
  }
}

function planningRetryTask(): TaskSpec {
  const tools = [{ name: "computer_write_file", description: "Write a workspace artifact." }];
  return {
    runId: "run-planning-turn-limit",
    input: "Create a Markdown report from the approved inputs.",
    taskUnderstanding: understandTask({
      objective: "Create a Markdown report from the approved inputs.",
      toolNames: tools.map((tool) => tool.name),
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "create_artifact",
        requiresExecution: true,
        deliverables: [{ action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
      },
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
  };
}

function retryingPlannerModel(): { readonly model: ModelAdapter; readonly calls: () => number } {
  let count = 0;
  return {
    model: {
      limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
      complete: async (): Promise<ModelResponse> => {
        count += 1;
        if (count === 1) return { content: "", finishReason: "tool_calls", toolCalls: [] };
        if (count === 2) return { content: "I will create the plan.", finishReason: "stop", toolCalls: [] };
        if (count === 3) return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "invalid-arguments", name: "submit_outcome_plan", arguments: "not-an-object" }],
        };
        const validLeaf = {
          id: "write-report",
          objective: "Write the requested Markdown report.",
          dependsOn: [],
          role: "produce",
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
          evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty"],
            caveatPolicy: "mark_unverified_facts",
          },
        };
        if (count === 4) return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "unknown-capability",
            name: "submit_outcome_plan",
            arguments: {
              schema: "agentloop.outcomePlan/v2",
              goal: "Create a Markdown report from the approved inputs.",
              shape: "single_leaf",
              selectedSkillRoles: [],
              leaves: [{
                ...validLeaf,
                requiredCapabilities: ["capability_not_available_in_this_run"],
              }],
            },
          }],
        };
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "valid-plan",
            name: "submit_outcome_plan",
            arguments: {
              schema: "agentloop.outcomePlan/v2",
              goal: "Create a Markdown report from the approved inputs.",
              shape: "single_leaf",
              selectedSkillRoles: [],
              leaves: [validLeaf],
            },
          }],
        };
      },
    },
    calls: () => count,
  };
}

test("ModelPlanner honors the configured contract-repair turn limit while preserving the default", async () => {
  const defaultBudget = retryingPlannerModel();
  await assert.rejects(
    new ModelPlanner(defaultBudget.model).plan(planningRetryTask()),
    /Step write-report requires unknown capabilities: capability_not_available_in_this_run/,
  );
  assert.equal(defaultBudget.calls(), DEFAULT_MAX_PLANNING_TURNS);

  const configuredBudget = retryingPlannerModel();
  const started: Array<Record<string, unknown>> = [];
  const proposal = await new ModelPlanner(configuredBudget.model, { maxPlanningTurns: 5 }).plan(
    planningRetryTask(),
    undefined,
    async (event) => { if (event.type === "planning.started") started.push({ ...event.data }); },
  );
  assert.equal(configuredBudget.calls(), 5);
  assert.deepEqual(proposal.steps.map((step) => step.id), ["write-report"]);
  assert.deepEqual(started, [{ availableSkillCount: 0, availableToolCount: 1, maxPlanningTurns: 5 }]);
});

test("ModelPlanner rejects an unsafe configured planning turn limit", () => {
  const model = retryingPlannerModel().model;
  assert.throws(() => new ModelPlanner(model, { maxPlanningTurns: 0 }), /maxPlanningTurns must be a positive safe integer/);
  assert.throws(() => new ModelPlanner(model, { maxPlanningTurns: MAX_SUPPORTED_PLANNING_TURNS + 1 }), /maxPlanningTurns must be a positive safe integer/);
});

test("Planner drops model-authored ToolSource bindings and leaves source resolution to Admission", async () => {
  const tools = [
    {
      name: "mcp_ontoflow_jtbc_call_rdb_sql_api_query",
      description: "Read approved ODS metadata.",
      source: {
        id: "ontoflow-jtbc",
        transport: "mcp" as const,
        capabilities: [{
          id: "data_asset.ods_read",
          category: "data_asset",
          producesEvidenceKinds: ["source_summary", "schema_summary", "record_counts", "explicit_caveats"],
          sourceKinds: ["database"],
        }],
      },
    },
    { name: "computer_write_file", description: "Write a workspace artifact." },
  ];
  const task: TaskSpec = {
    runId: "run-source-constraint-regression",
    input: "Read approved ODS metadata and deliver a DDM-ready summary.",
    taskUnderstanding: understandTask({
      objective: "Read approved ODS metadata and deliver a DDM-ready summary.",
      toolNames: tools.map((tool) => tool.name),
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
  };

  const proposal = await new ModelPlanner(new RedundantSourceConstraintPlannerModel()).plan(task);
  const acquisition = proposal.steps.find((step) => step.id === "ods-facts");
  const delivery = proposal.steps.find((step) => step.id === "ddm-delivery");

  assert.equal(acquisition?.sourceConstraint, undefined);
  assert.equal(delivery?.sourceConstraint, undefined);
});

test("Planner repair uses a bound prior Result instead of recreating its fact-acquisition leaf", async () => {
  let calls = 0;
  const priorResult = { schema: "agentloop.resultRef/v1" as const, resultId: "rr_00000000-0000-4000-8000-000000000123" };
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    complete: async (request) => {
      calls += 1;
      const reacquisition = calls === 1;
      if (!reacquisition) {
        assert.match(request.runtimeContext?.content ?? "", /bound a prior Runtime Result as the formal input/);
        assert.match(request.runtimeContext?.content ?? "", new RegExp(priorResult.resultId));
      }
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `prior-result-plan-${calls}`,
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: "Complete the requested artifact from the bound prior Result.",
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: reacquisition ? [{
              id: "repeated-acquisition",
              objective: "Reacquire the database facts despite the formal prior Result.",
              dependsOn: [],
              role: "fact_acquisition",
              skillIds: [],
              requiredCapabilities: ["data_asset.ods_read"],
              evidenceContract: {
                requiredKinds: ["source_summary"],
                caveatPolicy: "mark_unverified_facts",
              },
            }] : [{
              id: "produce-from-prior-result",
              objective: "Read the bound prior Result and produce the requested report.",
              dependsOn: [],
              role: "produce",
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write"],
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty"],
                caveatPolicy: "mark_unverified_facts",
              },
            }],
          },
        }],
      };
    },
  };
  const tools = [{ name: "computer_write_file", description: "Write a workspace artifact." }];
  const task: TaskSpec = {
    runId: "run-prior-result-materialization-regression",
    input: "Continue the prior report.",
    taskUnderstanding: understandTask({
      objective: "Create the requested Markdown report from the prior result.",
      toolNames: tools.map((tool) => tool.name),
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "create_artifact",
        requiresExecution: true,
        deliverables: [{ action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
      },
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
    turnResolution: {
      schema: "agentloop.conversationTurnResolution/v1",
      mode: "execute",
      relation: "continue_prior",
      inputMode: "prior_result",
      targetRunId: "prior-run",
      targetResult: priorResult,
      effectiveGoal: "Create the requested Markdown report from the prior result.",
      taskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "create_artifact",
        requiresExecution: true,
        deliverables: [{ action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
      },
      evidenceStrategy: "none",
      sourceBinding: { mode: "none", visibleDirectoryIds: [] },
      evidenceDemand: "none",
      userConstraints: [],
      source: "model",
    },
    conversationWorkingSet: {
      schema: "conversation.workset/v1",
      conversationId: "conversation-prior-result",
      runCount: 1,
      planCursors: [],
      resultCards: [{
        schema: "agentloop.resultCard/v1",
        result: priorResult,
        kind: "step",
        producer: { runId: "prior-run", planId: "prior-plan", stepId: "prior-step" },
        goal: "Acquire source facts",
        summary: "Previously observed source facts.",
        summaryTruncated: false,
        characters: 34,
        artifactPaths: [],
        evidenceRefs: ["assessment:prior-step"],
      }],
      reusableArtifacts: [],
      failedBoundaries: [],
      recommendedCapabilities: { skillIds: [], capabilityIds: [] },
    },
  };

  const proposal = await new ModelPlanner(model).plan(task);

  assert.equal(calls, 2);
  assert.deepEqual(proposal.steps.map((step) => step.id), ["produce-from-prior-result"]);
  assert.equal(proposal.steps[0]?.role, "produce");
});

function boundPriorResultTask(input: {
  readonly runId: string;
  readonly tools: TaskSpec["availableTools"];
}): TaskSpec {
  const priorResult = { schema: "agentloop.resultRef/v1" as const, resultId: "rr_00000000-0000-4000-8000-000000000456" };
  const tools = input.tools ?? [];
  return {
    runId: input.runId,
    input: "Produce the requested DDM model from the previously acquired result without refreshing source data.",
    taskUnderstanding: understandTask({
      objective: "Produce the requested DDM model from the prior Runtime Result.",
      toolNames: tools.map((tool) => tool.name),
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "create_artifact",
        requiresExecution: true,
        deliverables: [{ action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
      },
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
    turnResolution: {
      schema: "agentloop.conversationTurnResolution/v1",
      mode: "execute",
      relation: "continue_prior",
      inputMode: "prior_result",
      targetRunId: "prior-run",
      targetResult: priorResult,
      effectiveGoal: "Produce the requested DDM model from the prior Runtime Result.",
      taskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "create_artifact",
        requiresExecution: true,
        deliverables: [{ action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
      },
      evidenceStrategy: "none",
      sourceBinding: { mode: "none", visibleDirectoryIds: [] },
      evidenceDemand: "none",
      userConstraints: ["Do not refresh source data."],
      source: "model",
    },
    conversationWorkingSet: {
      schema: "conversation.workset/v1",
      conversationId: "conversation-bound-result-source-constraint",
      runCount: 1,
      planCursors: [],
      resultCards: [{
        schema: "agentloop.resultCard/v1",
        result: priorResult,
        kind: "step",
        producer: { runId: "prior-run", planId: "prior-plan", stepId: "ods-facts" },
        goal: "Acquire ODS facts",
        summary: "Prior ODS schema and record-count observations.",
        summaryTruncated: false,
        characters: 44,
        artifactPaths: [],
        evidenceRefs: ["assessment:ods-facts"],
      }],
      reusableArtifacts: [],
      failedBoundaries: [],
      recommendedCapabilities: { skillIds: [], capabilityIds: [] },
    },
  };
}

function priorResultProducerWithToolSourceModel(requiredCapabilities: readonly string[], evidenceKinds?: readonly "source_summary"[]): ModelAdapter {
  return {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(): Promise<ModelResponse> {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "produce-from-prior-result-with-stale-source",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: "Produce the DDM model from the bound prior Result.",
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: [{
              id: "ddm-modeling",
              objective: "Use the bound prior Result to produce the DDM model.",
              dependsOn: [],
              role: "produce",
              skillIds: [],
              requiredCapabilities,
              sourceConstraint: {
                bindings: [{ kind: "tool_source", ids: ["ontoflow-jtbc"] }],
              },
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty", ...(evidenceKinds ?? [])],
                caveatPolicy: "mark_unverified_facts",
              },
            }],
          },
        }],
      };
    },
  };
}

test("Planner removes an unneeded ToolSource copied onto a bound-Result producer", async () => {
  const tools = [
    {
      name: "mcp_ontoflow_jtbc_call_rdb_sql_api_query",
      description: "Read approved ODS metadata.",
      source: {
        id: "ontoflow-jtbc",
        transport: "mcp" as const,
        capabilities: [{ id: "data_asset.ods_read", category: "data_asset" }],
      },
    },
    { name: "computer_write_file", description: "Write a workspace artifact." },
  ];
  const proposal = await new ModelPlanner(
    priorResultProducerWithToolSourceModel(["workspace_artifact_write"]),
  ).plan(boundPriorResultTask({
    runId: "run-bound-result-stale-tool-source",
    tools,
  }));

  assert.equal(proposal.steps[0]?.sourceConstraint, undefined);
});

test("Planner retains a current source capability without retaining the model ToolSource hint", async () => {
  const tools = [
    {
      name: "mcp_ontoflow_jtbc_call_rdb_sql_api_query",
      description: "Read approved ODS metadata.",
      source: {
        id: "ontoflow-jtbc",
        transport: "mcp" as const,
        capabilities: [{
          id: "data_asset.ods_read",
          category: "data_asset",
          producesEvidenceKinds: ["source_summary"],
          sourceKinds: ["database"],
        }],
      },
    },
    { name: "computer_write_file", description: "Write a workspace artifact." },
  ];
  const proposal = await new ModelPlanner(
    priorResultProducerWithToolSourceModel(["workspace_artifact_write", "data_asset.ods_read"], ["source_summary"]),
  ).plan(boundPriorResultTask({
    runId: "run-bound-result-current-tool-source",
    tools,
  }));

  assert.equal(proposal.steps[0]?.sourceConstraint, undefined);
  assert.deepEqual(proposal.steps[0]?.requiredCapabilities, ["workspace_artifact_write", "data_asset.ods_read"]);
});
