import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_PLANNING_TURNS, MAX_SUPPORTED_PLANNING_TURNS, ModelPlanner } from "../src/planning/planner.ts";
import { admitPlan } from "../src/planning/admission.ts";
import type { TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";

class RedundantSourceConstraintPlannerModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 40_000, maxOutputTokens: 2_048 } as const;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    assert.equal(request.phase, "planning");
    assert.match(JSON.stringify(request.tools[0]?.inputSchema), /"sourceConstraint":\{"type":"null"\}/);
    assert.match(request.runtimeContext?.content ?? "", /"requiredToolSourceIds":\["ontoflow-jtbc"\]/);
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
              sourceConstraint: null,
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
              sourceConstraint: null,
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
  const runId = "run-planning-turn-limit";
  return {
    runId,
    canonicalState: createCanonicalRunState({ runId, userInput: "Create a Markdown report from the approved inputs.", understanding: understandTask({
      objective: "Create a Markdown report from the approved inputs.",
      toolNames: tools.map((tool) => tool.name),
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "create_artifact",
        requiresExecution: true,
        deliverables: [{ targetId: "markdown-report", purpose: "Deliver the requested Markdown report.", expectedArtifactCount: 1, action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
      },
    }), now: 1 }),
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
          targetIds: ["markdown-report"],
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

test("submit_outcome_plan uses the provider-supported strict schema subset for dynamic bindings", async () => {
  const source = {
    id: "source-design",
    originalName: "design.md",
    mimeType: "text/markdown",
    extension: ".md",
    byteSize: 128,
    sha256: "abc123",
    status: "ready" as const,
    chunkCount: 1,
    truncated: false,
  };
  const runId = "run-provider-supported-planning-schema";
  const tools = [{ name: "computer_write_file", description: "Write a workspace artifact." }];
  const understanding = understandTask({
    objective: "Create a Markdown report from the uploaded design.",
    toolNames: tools.map((tool) => tool.name),
    uploadedSources: [source],
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "create_artifact",
      requiresExecution: true,
      deliverables: [{
        targetId: "design-report",
        purpose: "Deliver the requested design report.",
        expectedArtifactCount: 1,
        action: "create",
        kind: "document",
        format: "markdown",
        surface: "workspace_artifact",
      }],
    },
  });
  const task: TaskSpec = {
    runId,
    canonicalState: createCanonicalRunState({ runId, userInput: "Create a Markdown report from the uploaded design.", understanding, now: 1 }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
    sources: [source],
    visibleDirectories: [{ id: "visible-designs", path: "/workspace/designs", name: "designs" }],
  };
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(request): Promise<ModelResponse> {
      const schema = request.tools.find((tool) => tool.name === "submit_outcome_plan")?.inputSchema;
      assert.equal(JSON.stringify(schema).includes('"uniqueItems"'), false);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "provider-supported-plan",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: "Create a Markdown report from the uploaded design.",
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: [{
              id: "create-report",
              objective: "Create the report from the uploaded design.",
              dependsOn: [],
              role: "produce",
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write"],
              sourceConstraint: { bindings: [{ kind: "uploaded_source", ids: [source.id, source.id] }] },
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty"],
                caveatPolicy: "mark_unverified_facts",
              },
              targetIds: ["design-report", "design-report"],
            }],
          },
        }],
      };
    },
  };

  const proposal = await new ModelPlanner(model).plan(task);
  assert.deepEqual(proposal.steps[0]?.sourceConstraint?.requiredUploadedSourceIds, [source.id]);
  assert.deepEqual(proposal.steps[0]?.targetIds, ["design-report"]);
});

test("deterministic response plan owns every canonical conversation delivery target", async () => {
  const runId = "run-deterministic-response-target";
  const targetId = "vertical-privilege-escalation-explanation";
  const canonicalState = createCanonicalRunState({
    runId,
    userInput: "IT 软件安全里面有一个名词叫垂直越权，这个是什么风险？",
    understanding: understandTask({
      objective: "Explain vertical privilege escalation as a software security risk.",
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "answer",
        requiresExecution: false,
        deliverables: [{
          targetId,
          purpose: "Explain vertical privilege escalation as a software security risk.",
          expectedArtifactCount: 1,
          action: "none",
          kind: "none",
          surface: "conversation",
        }],
      },
    }),
    now: 1,
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    complete: async () => { throw new Error("response-only planning must remain deterministic"); },
  };
  const task: TaskSpec = {
    runId,
    canonicalState,
    responseOnly: true,
    availableSkills: [],
    availableToolNames: [],
    availableTools: [],
  };

  const proposal = await new ModelPlanner(model).plan(task);
  assert.deepEqual(proposal.steps[0]?.targetIds, [targetId]);

  const admitted = admitPlan({
    runId,
    proposal,
    availableSkills: [],
    availableToolNames: new Set(),
    availableTools: [],
    canonicalState,
  });
  assert.deepEqual(admitted.steps[0]?.executionBinding.targetIds, [targetId]);
});

test("Admission scopes artifact evidence to the leaf that owns the workspace target", () => {
  const runId = "run-mixed-delivery-targets";
  const tools = [{ name: "computer_write_file", description: "Write a workspace artifact." }];
  const canonicalState = createCanonicalRunState({
    runId,
    userInput: "Create the requested DDM artifacts and summarize the execution evidence in chat.",
    understanding: understandTask({
      objective: "Create the requested DDM artifacts and summarize the execution evidence in chat.",
      toolNames: tools.map((tool) => tool.name),
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "composite",
        requiresExecution: true,
        deliverables: [
          {
            targetId: "ddm-artifact",
            purpose: "Deliver the requested DDM workspace artifact.",
            expectedArtifactCount: 1,
            action: "create",
            kind: "document",
            format: "markdown",
            surface: "workspace_artifact",
          },
          {
            targetId: "execution-evidence-summary",
            purpose: "Summarize the execution evidence in the conversation.",
            expectedArtifactCount: 1,
            action: "none",
            kind: "none",
            surface: "conversation",
          },
        ],
      },
    }),
    now: 1,
  });

  const admitted = admitPlan({
    runId,
    canonicalState,
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    availableTools: tools,
    proposal: {
      schema: "agentloop.outcomePlan/v2",
      goal: "Create the DDM artifact and summarize evidence.",
      shape: "fact_then_produce",
      selectedSkillRoles: [],
      selectedSkillIds: [],
      steps: [
        {
          id: "produce-ddm-artifact",
          objective: "Create the requested DDM artifact in the workspace.",
          dependencies: [],
          role: "produce",
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
          targetIds: ["ddm-artifact"],
          successCriteria: [{ id: "artifact_non_empty", description: "The DDM artifact is non-empty.", source: "planner" }],
          evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty"],
            caveatPolicy: "mark_unverified_facts",
          },
        },
        {
          id: "final-evidence-summary",
          objective: "Summarize the execution evidence in the conversation.",
          dependencies: ["produce-ddm-artifact"],
          role: "deliver",
          skillIds: [],
          requiredCapabilities: ["conversation_delivery"],
          targetIds: ["execution-evidence-summary"],
          successCriteria: [{ id: "conversation_delivery", description: "The evidence summary is delivered in chat.", source: "planner" }],
          evidenceContract: {
            requiredKinds: ["delivery_receipt"],
            caveatPolicy: "none",
          },
        },
      ],
    },
  });

  const artifactLeaf = admitted.steps.find((step) => step.id === "produce-ddm-artifact");
  const summaryLeaf = admitted.steps.find((step) => step.id === "final-evidence-summary");

  assert.deepEqual(artifactLeaf?.executionBinding.targetIds, ["ddm-artifact"]);
  assert.deepEqual(summaryLeaf?.executionBinding.targetIds, ["execution-evidence-summary"]);
  assert.equal(artifactLeaf?.executionBinding.requiredCapabilities.includes("workspace_artifact_write"), true);
  assert.equal(artifactLeaf?.evidenceContract?.requiredKinds.includes("artifact_path"), true);
  assert.equal(artifactLeaf?.evidenceContract?.requiredKinds.includes("artifact_non_empty"), true);
  assert.equal(summaryLeaf?.executionBinding.requiredCapabilities.includes("workspace_artifact_write"), false);
  assert.equal(summaryLeaf?.executionBinding.requiredCapabilities.includes("artifact_acceptance"), false);
  assert.equal((summaryLeaf?.evidenceContract?.requiredKinds ?? []).some((kind) => kind.startsWith("artifact_") || kind === "format_matches_request"), false);
  assert.deepEqual(summaryLeaf?.successCriteria.map((criterion) => criterion.id), [
    "conversation_delivery",
    "delivery_target:execution-evidence-summary",
  ]);
});

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

test("Planner schema exposes no sourceConstraint namespace when canonical inputs contain only a ToolSource", async () => {
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
    canonicalState: createCanonicalRunState({
      runId: "run-source-constraint-regression",
      userInput: "Read approved ODS metadata and deliver a DDM-ready summary.",
      understanding: understandTask({
        objective: "Read approved ODS metadata and deliver a DDM-ready summary.",
        toolNames: tools.map((tool) => tool.name),
      }),
      requiredToolSourceIds: ["ontoflow-jtbc"],
      now: 1,
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

test("externally grounded data analysis cannot collapse acquisition and delivery into one leaf", async () => {
  const objective = "使用已接入的数据资产 MCP 查询 ODS 表结构并分析数据分布。";
  const deliverables = [
    { targetId: "table-schema", purpose: "ODS 表字段与类型说明", expectedArtifactCount: 1, action: "create" as const, kind: "document" as const, surface: "conversation" as const },
    { targetId: "data-distribution", purpose: "ODS 表数据分布分析", expectedArtifactCount: 1, action: "create" as const, kind: "document" as const, surface: "conversation" as const },
  ];
  const tools = [{
    name: "mcp_database_query",
    description: "Query approved database metadata and data evidence.",
    source: {
      id: "database-connector",
      transport: "mcp" as const,
      capabilities: [{
        id: "data_asset.read",
        category: "data_asset",
        producesEvidenceKinds: ["source_summary", "schema_summary", "record_counts"],
        sourceKinds: ["database"],
      }],
    },
  }];
  const understanding = understandTask({
    objective,
    toolNames: tools.map((tool) => tool.name),
    evidenceDemand: "lookup_lite",
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "composite",
      requiresExecution: true,
      deliverables,
    },
  });
  const runId = "run-external-data-analysis-topology";
  const task: TaskSpec = {
    runId,
    canonicalState: createCanonicalRunState({ runId, userInput: objective, understanding, now: 1 }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
  };
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    complete: async (request) => {
      const submitTool = request.tools.find((tool) => tool.name === "submit_outcome_plan");
      const leaves = submitTool?.inputSchema.properties?.leaves as Record<string, unknown> | undefined;
      const leafItems = leaves?.items as Record<string, unknown> | undefined;
      const leafProperties = leafItems?.properties as Record<string, unknown> | undefined;
      const targetIdsSchema = leafProperties?.targetIds as Record<string, unknown> | undefined;
      assert.equal(targetIdsSchema?.minItems, 0);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "collapsed-analysis-plan",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: objective,
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: [{
              id: "acquire-and-analyze",
              objective,
              dependsOn: [],
              role: "fact_acquisition",
              skillIds: [],
              requiredCapabilities: ["data_asset.read"],
              sourceConstraint: null,
              evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" },
              targetIds: deliverables.map((target) => target.targetId),
            }],
          },
        }],
      };
    },
  };

  await assert.rejects(
    new ModelPlanner(model, { maxPlanningTurns: 1 }).plan(task),
    /violates required plan topology.*fact_then_produce.*deliver/,
  );
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
            shape: reacquisition ? "pipeline" : "single_leaf",
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
            }, {
              id: "produce-after-reacquisition",
              objective: "Produce the requested report from the reacquired facts.",
              dependsOn: ["repeated-acquisition"],
              role: "produce",
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write"],
              targetIds: ["markdown-report"],
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty"],
                caveatPolicy: "mark_unverified_facts",
              },
            }] : [{
              id: "produce-from-prior-result",
              objective: "Read the bound prior Result and produce the requested report.",
              dependsOn: [],
              role: "produce",
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write"],
              targetIds: ["markdown-report"],
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
    canonicalState: createCanonicalRunState({
      runId: "run-prior-result-materialization-regression",
      userInput: "Continue the prior report.",
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
          deliverables: [{ targetId: "markdown-report", purpose: "Deliver the requested Markdown report.", expectedArtifactCount: 1, action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
        },
        evidenceStrategy: "none",
        sourceBinding: { mode: "none", visibleDirectoryIds: [] },
        evidenceDemand: "none",
        userConstraints: [],
        source: "model",
      },
      understanding: understandTask({
      objective: "Create the requested Markdown report from the prior result.",
      toolNames: tools.map((tool) => tool.name),
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "create_artifact",
        requiresExecution: true,
        deliverables: [{ targetId: "markdown-report", purpose: "Deliver the requested Markdown report.", expectedArtifactCount: 1, action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
      },
      }),
      now: 1,
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
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
    canonicalState: createCanonicalRunState({
      runId: input.runId,
      userInput: "Produce the requested DDM model from the previously acquired result without refreshing source data.",
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
          deliverables: [{ targetId: "ddm-model", purpose: "Deliver the requested DDM model.", expectedArtifactCount: 1, action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
        },
        evidenceStrategy: "none",
        sourceBinding: { mode: "none", visibleDirectoryIds: [] },
        evidenceDemand: "none",
        userConstraints: ["Do not refresh source data."],
        source: "model",
      },
      understanding: understandTask({
      objective: "Produce the requested DDM model from the prior Runtime Result.",
      toolNames: tools.map((tool) => tool.name),
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "create_artifact",
        requiresExecution: true,
        deliverables: [{ targetId: "ddm-model", purpose: "Deliver the requested DDM model.", expectedArtifactCount: 1, action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" }],
      },
      }),
      now: 1,
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
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

function priorResultProducerModel(requiredCapabilities: readonly string[], evidenceKinds?: readonly "source_summary"[]): ModelAdapter {
  return {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(): Promise<ModelResponse> {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "produce-from-prior-result",
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
              targetIds: ["ddm-model"],
              sourceConstraint: null,
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

test("a bound-Result producer leaves ToolSource selection to canonical Runtime intent", async () => {
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
    priorResultProducerModel(["workspace_artifact_write"]),
  ).plan(boundPriorResultTask({
    runId: "run-bound-result-stale-tool-source",
    tools,
  }));

  assert.equal(proposal.steps[0]?.sourceConstraint, undefined);
});

test("Planner retains a current source capability without a model-owned ToolSource binding", async () => {
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
    priorResultProducerModel(["workspace_artifact_write", "data_asset.ods_read"], ["source_summary"]),
  ).plan(boundPriorResultTask({
    runId: "run-bound-result-current-tool-source",
    tools,
  }));

  assert.equal(proposal.steps[0]?.sourceConstraint, undefined);
  assert.deepEqual(proposal.steps[0]?.requiredCapabilities, ["workspace_artifact_write", "data_asset.ods_read"]);
});

test("Planner rejects a ToolSource ID masquerading as a visible directory", async () => {
  const tools = [{
    name: "mcp_ontoflow_jtbc_call_rdb_sql_api_query",
    description: "Read approved ODS metadata.",
    source: {
      id: "ontoflow-jtbc",
      transport: "mcp" as const,
      capabilities: [{ id: "data_asset.ods_read", category: "data_asset" }],
    },
  }];
  const task: TaskSpec = {
    runId: "run-tool-source-as-visible-directory",
    canonicalState: createCanonicalRunState({
      runId: "run-tool-source-as-visible-directory",
      userInput: "Read approved ODS metadata.",
      understanding: understandTask({
        objective: "Read approved ODS metadata.",
        toolNames: tools.map((tool) => tool.name),
      }),
      requiredToolSourceIds: ["ontoflow-jtbc"],
      now: 1,
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
  };
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(): Promise<ModelResponse> {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "misclassified-tool-source",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: "Read approved ODS metadata.",
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: [{
              id: "ods-facts",
              objective: "Read approved ODS metadata.",
              dependsOn: [],
              role: "fact_acquisition",
              skillIds: [],
              requiredCapabilities: ["data_asset.ods_read"],
              sourceConstraint: {
                bindings: [{ kind: "visible_directory", ids: ["ontoflow-jtbc"] }],
              },
              evidenceContract: {
                requiredKinds: ["source_summary"],
                caveatPolicy: "strict_fail_on_missing_source",
              },
            }],
          },
        }],
      };
    },
  };

  await assert.rejects(
    new ModelPlanner(model, { maxPlanningTurns: 1 }).plan(task),
    /sourceConstraint namespaces do not match canonical Runtime inputs; invalid visible_directory IDs: ontoflow-jtbc/,
  );
});
