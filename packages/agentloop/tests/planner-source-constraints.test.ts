import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_PLANNING_TURNS, MAX_SUPPORTED_PLANNING_TURNS, ModelPlanner } from "../src/planning/planner.ts";
import { admitPlan } from "../src/planning/admission.ts";
import type { TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";
import { planningCapabilitiesFromSkills, planningCapabilitiesFromToolNames, skillSourceProviderCapabilityId } from "../src/planning/step-execution-binding.ts";
import { ModelRecoveryPlanner, type RecoveryPlannerInput } from "../src/runtime/recovery-planning.ts";
import { recoveryProposalSuccessCriteria } from "../src/runtime/run-service.ts";

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

test("Planner previews a proposal against the selected Skill capability closure", async () => {
  const selectedSource = {
    id: "discovered:selected-source",
    name: "selected-source",
    description: "Read the requested source records.",
    instructions: "Read the requested source records.",
    sourceKind: "package",
    version: 1,
    contentHash: "selected-source",
    updatedAt: 1,
    agentLoop: {
      roles: ["source_provider"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
      executionProfiles: ["local_script"], producesEvidenceKinds: ["source_summary"],
    },
  } as PrivateSkill;
  const unselectedSource = {
    id: "discovered:unselected-source",
    name: "unselected-source",
    description: "Read a different source namespace.",
    instructions: "Read a different source namespace.",
    sourceKind: "package",
    version: 1,
    contentHash: "unselected-source",
    updatedAt: 1,
    agentLoop: {
      roles: ["source_provider"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
      executionProfiles: ["local_script"], producesEvidenceKinds: ["source_summary"],
    },
  } as PrivateSkill;
  const selectedCapability = skillSourceProviderCapabilityId(selectedSource.id, "database");
  const unselectedCapability = skillSourceProviderCapabilityId(unselectedSource.id, "database");
  const runId = "run-planner-selected-skill-capability-closure";
  const understanding = understandTask({ objective: "Read the requested source records." });
  const task: TaskSpec = {
    runId,
    canonicalState: createCanonicalRunState({ runId, userInput: "Read the requested source records.", understanding, now: 1 }),
    availableSkills: [selectedSource, unselectedSource],
    selectedSkillRoles: [
      { skillId: selectedSource.id, role: "source_provider", reason: "Candidate source." },
      { skillId: unselectedSource.id, role: "source_provider", reason: "Candidate source." },
    ],
    availableToolNames: ["load_skill", "computer_run_command"],
    availableCapabilities: [
      ...planningCapabilitiesFromToolNames(["load_skill", "computer_run_command"]),
      ...planningCapabilitiesFromSkills([selectedSource, unselectedSource]),
    ],
  };
  let calls = 0;
  const failures: string[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(): Promise<ModelResponse> {
      calls += 1;
      const requiredCapabilities = calls === 1
        ? [selectedCapability, unselectedCapability]
        : [selectedCapability];
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `plan-${calls}`,
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: "Read the requested source records.",
            shape: "single_leaf",
            selectedSkillRoles: [{ skillId: selectedSource.id, role: "source_provider", reason: "Use the requested source." }],
            leaves: [{
              id: "source-facts",
              objective: "Read the requested source records.",
              dependsOn: [],
              role: "fact_acquisition",
              skillIds: [selectedSource.id],
              requiredCapabilities,
              sourceConstraint: null,
              targetIds: [],
              requiredFacts: [],
              evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" },
              successCriteria: [{ id: "source_summary", description: "Source records are observed.", source: "planner" }],
            }],
          },
        }],
      };
    },
  };

  const proposal = await new ModelPlanner(model, { maxPlanningTurns: 2 }).plan(task, undefined, async (event) => {
    if (event.type === "planning.contract_failed") failures.push(String(event.data.validationError));
  });

  assert.equal(calls, 2);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /requires unknown capabilities: .*discovered:unselected-source/);
  assert.deepEqual(proposal.steps[0]?.requiredCapabilities, [selectedCapability]);
});

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
    turnResolution: {
      schema: "agentloop.conversationTurnResolution/v1",
      mode: "reply",
      relation: "new_goal",
      inputMode: "none",
      effectiveGoal: "Explain vertical privilege escalation as a software security risk.",
      taskIntent: {
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
      evidenceStrategy: "none",
      sourceBinding: { mode: "none", visibleDirectoryIds: [] },
      evidenceDemand: "none",
      userConstraints: [],
      source: "model",
    },
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
  assert.deepEqual(Object.keys(canonicalState.targets), [targetId]);
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

test("source-grounded conversation lookup receives a single delivery boundary in its planning schema", async () => {
  const objective = "宝信软件的董事长是谁，总裁又是谁？需给出可核验的来源。";
  const targetId = "company-leadership";
  const tools = [
    { name: "websearch", description: "Search public sources." },
    { name: "webfetch", description: "Read a public source." },
  ];
  const understanding = understandTask({
    objective,
    toolNames: tools.map((tool) => tool.name),
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "lookup",
      requiresExecution: true,
      deliverables: [{
        targetId,
        purpose: "Answer who currently chairs the company and serves as president.",
        expectedArtifactCount: 1,
        action: "none",
        kind: "none",
        surface: "conversation",
      }],
    },
  });
  const runId = "run-source-grounded-single-delivery";
  const task: TaskSpec = {
    runId,
    canonicalState: createCanonicalRunState({ runId, userInput: objective, understanding, now: 1 }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
  };
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    complete: async (request): Promise<ModelResponse> => {
      const schema = request.tools.find((tool) => tool.name === "submit_outcome_plan")?.inputSchema;
      const properties = schema?.properties as Record<string, unknown>;
      const shape = properties?.shape as Record<string, unknown>;
      const leaves = properties?.leaves as Record<string, unknown>;
      const leaf = leaves?.items as Record<string, unknown>;
      const leafProperties = leaf?.properties as Record<string, unknown>;
      assert.deepEqual(shape?.enum, ["single_leaf"]);
      assert.equal(leaves?.minItems, 1);
      assert.equal(leaves?.maxItems, 1);
      assert.deepEqual((leafProperties?.role as Record<string, unknown>)?.enum, ["deliver"]);
      assert.equal((leafProperties?.dependsOn as Record<string, unknown>)?.maxItems, 0);
      assert.equal((leafProperties?.targetIds as Record<string, unknown>)?.minItems, 1);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "single-delivery-plan",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: objective,
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: [{
              id: "answer-with-sources",
              objective: "Research current company leadership and answer the user with source-backed caveats.",
              dependsOn: [],
              role: "deliver",
              skillIds: [],
              requiredCapabilities: ["web_research", "conversation_delivery"],
              sourceConstraint: null,
              evidenceContract: { requiredKinds: ["source_summary", "source_urls", "explicit_caveats"], caveatPolicy: "mark_unverified_facts" },
              targetIds: [targetId],
            }],
          },
        }],
      };
    },
  };

  const proposal = await new ModelPlanner(model, { maxPlanningTurns: 2 }).plan(task);

  assert.equal(proposal.shape, "single_leaf");
  assert.deepEqual(proposal.steps.map((step) => ({ id: step.id, role: step.role, targetIds: step.targetIds })), [{
    id: "answer-with-sources", role: "deliver", targetIds: [targetId],
  }]);
  const coreCriterion = proposal.steps[0]?.successCriteria.find((criterion) => criterion.id === "answer-with-sources-core-result");
  assert.ok(coreCriterion);
  assert.match(coreCriterion.description, /Directly fulfill the user-facing delivery target/i);
  assert.match(coreCriterion.description, /Source extracts, field tables, and raw evidence alone/i);
});

function webpageSummaryPlanningFixture() {
  const objective = "帮我抓取总结一下这个网页的内容https://3499f4649d1e4e1092dd5218afd028ba.app.workbuddy.host/";
  const targetId = "webpage-summary";
  const tools = [
    { name: "websearch", description: "Search public web sources." },
    { name: "webfetch", description: "Fetch a public web page." },
  ];
  const understanding = understandTask({
    objective,
    toolNames: tools.map((tool) => tool.name),
    evidenceDemand: "source_grounded",
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "analysis",
      requiresExecution: true,
      deliverables: [{ targetId, purpose: "抓取并总结网页内容", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
    },
  });
  const runId = "run-webpage-summary-contract-repair";
  const canonicalState = createCanonicalRunState({ runId, userInput: objective, understanding, now: 1 });
  const fact = () => ({
    id: "webpage-content",
    description: "网页正文内容",
    evidenceKinds: ["source_summary"],
    basis: {
      kind: "user_requirement",
      intentId: canonicalState.intent.id,
      targetIds: [targetId],
      rationale: "The fetched page is the evidence needed to summarize the requested webpage.",
    },
  });
  return {
    task: { runId, canonicalState, availableSkills: [], availableTools: tools, availableToolNames: tools.map((tool) => tool.name) },
    response(violation?: "quote" | "ownership", requirement = "向用户提供该网页内容的中文摘要"): ModelResponse {
      const acquisition = {
        id: "fetch-page",
        objective: "抓取网页正文作为总结依据。",
        requiredFacts: [fact()],
        dependsOn: [], role: "fact_acquisition", skillIds: [], requiredCapabilities: ["web_research"],
        sourceConstraint: null, evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" },
        targetIds: violation === "ownership" ? [targetId] : [],
      };
      const delivery = {
        id: "deliver-summary",
        objective: "根据网页正文交付总结。",
        requiredFacts: [{ ...fact(), basis: { ...fact().basis, ...(violation === "quote" ? { requirement } : {}) } }],
        dependsOn: ["fetch-page"], role: "deliver", skillIds: [],
        requiredCapabilities: ["conversation_delivery"], sourceConstraint: null,
        evidenceContract: { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" }, targetIds: [targetId],
      };
      return {
        content: "", finishReason: "tool_calls" as const,
        toolCalls: [{ id: "webpage-plan", name: "submit_outcome_plan", arguments: {
          schema: "agentloop.outcomePlan/v2", goal: objective, shape: "fact_then_produce", selectedSkillRoles: [],
          leaves: [acquisition, delivery],
        } }],
      };
    },
  };
}

test("Recovery Planner retries a duplicate-criterion proposal with parser feedback", async () => {
  const fixture = webpageSummaryPlanningFixture();
  let calls = 0;
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 4_096 },
    complete: async (request) => {
      calls += 1;
      if (calls === 2) assert.match(request.systemPrompt, /duplicate ids/);
      const criterion = { id: "repair-result", description: "Deliver the repaired result.", source: "planner" };
      return {
        content: "",
        finishReason: "tool_calls" as const,
        toolCalls: [{
          id: `recovery-${calls}`,
          name: "submit_recovery_decision",
          arguments: calls === 1 ? {
            actionId: "recovery-action", expectedActionRevision: 1, decision: "revise_plan",
            rationale: "Repair the malformed proposal.", evidenceRefs: [],
            planRevision: {
              goal: fixture.task.canonicalState.intent.userInput,
              shape: "recovery_patch", selectedSkillIds: [],
              steps: [{ id: "repair", objective: "Repair the result.", dependencies: [], skillIds: [],
                requiredCapabilities: [], targetIds: [], successCriteria: [criterion, criterion] }],
            },
          } : {
            actionId: "recovery-action", expectedActionRevision: 1, decision: "fail",
            rationale: "No valid continuation remains.", evidenceRefs: [],
          },
        }],
      };
    },
  };
  const input: RecoveryPlannerInput = {
    runId: fixture.task.runId,
    userInput: fixture.task.canonicalState.intent.userInput,
    action: {
      id: "recovery-action", runId: fixture.task.runId, kind: "recovery_review", state: "recovery_required",
      attempt: 1, maxAttempts: 3, replayPolicy: "safe", fence: 1, revision: 1,
      metadata: {}, effectState: "not_started", createdAt: 1, updatedAt: 1,
    },
    canonicalState: fixture.task.canonicalState,
    events: [], userResponses: [],
  };
  const decision = await new ModelRecoveryPlanner(model).decide(input);
  assert.equal(decision.decision, "fail");
  assert.equal(calls, 2);
});

test("webpage summary provenance is Runtime-bound and both live paraphrases are rejected as model fields", async (t) => {
  for (const requirement of [undefined, "向用户提供该网页内容的中文摘要", "输出为中文摘要"]) {
    await t.test(requirement ?? "model omits the Runtime-owned field", async () => {
      const fixture = webpageSummaryPlanningFixture();
      let calls = 0;
      const failures: string[] = [];
      const proposal = await new ModelPlanner({
        limits: { contextWindowTokens: 40_000, maxOutputTokens: 4_096 },
        async complete(request) {
          calls += 1;
          const schema = request.tools[0]!.inputSchema as any;
          const basisSchema = schema.properties.leaves.items.properties.requiredFacts.items.properties.basis;
          assert.equal(basisSchema.additionalProperties, false);
          assert.equal(Object.hasOwn(basisSchema.properties, "requirement"), false);
          assert.equal(basisSchema.required.includes("requirement"), false);
          return fixture.response(calls === 1 && requirement !== undefined ? "quote" : undefined, requirement);
        },
      }).plan(fixture.task, undefined, async (event) => {
        if (event.type === "planning.contract_failed") failures.push(String(event.data.validationError));
      });
      assert.equal(calls, requirement === undefined ? 1 : 2);
      assert.equal(failures.length, requirement === undefined ? 0 : 1);
      for (const failure of failures) assert.match(failure, /requirement is Runtime-owned and must not be submitted/);
      const plan = admitPlan({ ...fixture.task, proposal, availableToolNames: new Set(fixture.task.availableToolNames) });
      for (const step of plan.steps) {
        assert.equal(step.requiredFacts[0]!.basis!.requirement, fixture.task.canonicalState.intent.userInput);
        assert.equal(step.successCriteria.find((criterion) => criterion.id === "required_fact:webpage-content")!
          .basis!.requirement, fixture.task.canonicalState.intent.userInput);
      }
    });
  }
});

test("Planner repairs independent basis and target-ownership violations without dropping prerequisite provenance", async () => {
  const fixture = webpageSummaryPlanningFixture();
  let calls = 0;
  const failures: string[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 4_096 },
    async complete(request) {
      calls += 1;
      if (calls > 1) {
        assert.match(request.runtimeContext?.content ?? "", /requiredFacts\[\].basis\.targetIds records which canonical targets a fact supports/);
        assert.match(request.runtimeContext?.content ?? "", /Bind every canonical delivery target exactly once across leaves/);
      }
      return fixture.response(calls === 1 ? "quote" : calls === 2 ? "ownership" : undefined);
    },
  };
  const proposal = await new ModelPlanner(model, { maxPlanningTurns: 3 }).plan(fixture.task, undefined, async (event) => {
    if (event.type === "planning.contract_failed") failures.push(String(event.data.validationError));
  });
  assert.equal(calls, 3);
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /requirement is Runtime-owned and must not be submitted/);
  assert.equal(failures[1], "Plan targetIds must cover canonical delivery targets exactly once: multiply owned webpage-summary");
  const admitted = admitPlan({
    ...fixture.task, proposal, availableToolNames: new Set(fixture.task.availableToolNames),
  });
  const acquisition = admitted.steps.find((step) => step.id === "fetch-page")!;
  const delivery = admitted.steps.find((step) => step.id === "deliver-summary")!;
  assert.deepEqual(acquisition.executionBinding.targetIds, []);
  assert.deepEqual(delivery.executionBinding.targetIds, ["webpage-summary"]);
  const acquisitionCore = acquisition.successCriteria.find((criterion) => criterion.id === "fetch-page-core-result");
  assert.ok(acquisitionCore);
  assert.match(acquisitionCore.description, /source facts|fact summary/i);
  assert.doesNotMatch(acquisitionCore.description, /HTML artifact|workspace path|non-empty file/i);
  for (const step of [acquisition, delivery]) {
    assert.deepEqual(step.requiredFacts[0]?.basis?.targetIds, ["webpage-summary"]);
    assert.equal(step.requiredFacts[0]?.basis?.requirement, fixture.task.canonicalState.intent.userInput);
    assert.deepEqual(step.requiredFacts[0]?.evidenceKinds, ["source_summary"]);
  }
});

test("Planner stops repeated ownership failures and respects the total turn budget across distinct failures", async (t) => {
  for (const repeated of [true, false]) {
    await t.test(repeated ? "same violation stops early" : "different violations cannot exceed turn limit", async () => {
      const fixture = webpageSummaryPlanningFixture();
      let calls = 0;
      const planner = new ModelPlanner({
        limits: { contextWindowTokens: 40_000, maxOutputTokens: 4_096 },
        async complete() {
          calls += 1;
          return fixture.response(!repeated && calls === 1 ? "quote" : "ownership");
        },
      }, { maxPlanningTurns: repeated ? 8 : 2 });
      await assert.rejects(planner.plan(fixture.task), /multiply owned webpage-summary/);
      assert.equal(calls, 2);
    });
  }
});

test("Recovery resubmits explicit ownership and downstream fact provenance through Plan admission", async () => {
  const fixture = webpageSummaryPlanningFixture();
  const proposal = await new ModelPlanner({
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 4_096 },
    complete: async () => fixture.response(),
  }).plan(fixture.task);
  const plan = admitPlan({ ...fixture.task, proposal, availableToolNames: new Set(fixture.task.availableToolNames) });
  const input = {
    runId: fixture.task.runId, userInput: fixture.task.canonicalState.intent.userInput,
    plan, canonicalState: fixture.task.canonicalState, events: [], userResponses: [],
    action: { id: "review-webpage-contract", runId: fixture.task.runId, kind: "recovery_review" as const,
      state: "recovery_required" as const, attempt: 1, maxAttempts: 3, replayPolicy: "safe" as const,
      fence: 1, revision: 1, metadata: {}, effectState: "not_started" as const, createdAt: 1, updatedAt: 1 },
  };
  for (const binding of ["explicit", "missing", "duplicate", "foreign", "forged-fact", "forged-criterion", "foreign-intent", "method"] as const) {
    const recovery = new ModelRecoveryPlanner({
      limits: { contextWindowTokens: 40_000, maxOutputTokens: 4_096 },
      complete: async (request) => {
        const schema = request.tools[0]!.inputSchema as any;
        const stepSchema = schema.properties.planRevision.properties.steps.items;
        assert.ok(stepSchema.required.includes("targetIds"));
        assert.ok(stepSchema.required.includes("dependencies"));
        assert.ok(stepSchema.properties.requiredFacts.items.required.includes("basis"));
        assert.equal(Object.hasOwn(stepSchema.properties.requiredFacts.items.properties.basis.properties, "requirement"), false);
        assert.equal(Object.hasOwn(stepSchema.properties.successCriteria.items.properties.basis.properties, "requirement"), false);
        assert.match(request.systemPrompt, /executionBinding.targetIds/);
        assert.match(request.systemPrompt, /complete replacement proposal/);
        const context = JSON.parse(request.runtimeContext!.content);
        assert.deepEqual(context.currentPlan.steps.map((step: any) => step.executionBinding.targetIds), [[], ["webpage-summary"]]);
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "correct-contract", name: "submit_recovery_decision", arguments: {
          actionId: input.action.id, expectedActionRevision: 1, decision: "revise_plan",
          rationale: "Retain source evidence and repair only the unsupported artifact criterion.", evidenceRefs: ["fetch-result"],
          planRevision: { goal: plan.goal, shape: "fact_then_produce", selectedSkillIds: [], steps: plan.steps.map((step) => ({
            id: step.id, objective: step.objective, role: step.role, dependencies: step.dependencies,
            skillIds: step.skillIds, requiredCapabilities: step.requiredCapabilities,
            ...(binding === "missing" ? {} : { targetIds: binding === "duplicate" ? ["webpage-summary"]
              : binding === "foreign" ? ["foreign-target"] : step.executionBinding.targetIds }),
            requiredFacts: step.requiredFacts.map((fact) => ({ ...fact, basis: {
              ...modelBasis(fact.basis!),
              ...(binding === "forged-fact" ? { requirement: "输出为中文摘要" } : {}),
              ...(binding === "foreign-intent" ? { intentId: "foreign" } : {}),
              ...(binding === "method" ? { kind: "execution_method" } : {}),
            } })),
            evidenceContract: step.evidenceContract,
            successCriteria: recoveryProposalSuccessCriteria(step.successCriteria)
              .map((criterion) => ({ ...criterion, basis: { ...modelBasis(criterion.basis!),
                ...(binding === "forged-criterion" ? { requirement: "向用户提供该网页内容的中文摘要" } : {}),
              } })),
          })) },
        } }] };
      },
    });
    if (binding === "missing") {
      await assert.rejects(recovery.decide(input), /planRevision.steps\[0\].targetIds must be an array/);
      continue;
    }
    if (binding === "forged-fact" || binding === "forged-criterion") {
      await assert.rejects(recovery.decide(input), /requirement is Runtime-owned and must not be submitted/);
      continue;
    }
    const decision = await recovery.decide(input);
    const readmit = () => admitPlan({ ...fixture.task, proposal: decision.planRevision!, availableToolNames: new Set(fixture.task.availableToolNames) });
    if (binding !== "explicit") {
      assert.throws(readmit, /canonical targets|canonical delivery targets|unknown.*target|canonical intent|execution method/i);
      continue;
    }
    const revised = readmit();
    assert.deepEqual(revised.steps.map((step) => step.executionBinding.targetIds), [[], ["webpage-summary"]]);
    assert.deepEqual(revised.steps.map((step) => step.requiredFacts), plan.steps.map((step) => step.requiredFacts));
    assert.deepEqual(revised.steps[1]!.dependencies, ["fetch-page"]);
    assert.equal(revised.steps[1]!.successCriteria.filter((criterion) => criterion.id === "delivery_target:webpage-summary").length, 1);
  }
});

function modelBasis(basis: import("../src/planning/contracts.ts").CriterionBasis) {
  const { requirement: _requirement, ...metadata } = basis;
  return metadata;
}

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

for (const useDomainWorkflow of [true, false]) {
  test(`File delivery composes domain work and preserves optional source selection (${useDomainWorkflow ? "database workflow" : "web alternative"})`, async () => {
    const skills: PrivateSkill[] = [
      {
        id: "domain-analysis", ownerUserId: "owner", name: "domain-analysis",
        description: "Analyze workforce distributions using the reporting source; owns metric definitions and numerical conclusions independently of report format.",
        instructions: "PRIVATE ANALYSIS METHOD", sourceKind: "package", version: 1, contentHash: "analysis", updatedAt: 1,
        agentLoop: {
          roles: ["primary_builder"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
          executionProfiles: ["local_script"], requiredSkillNames: ["report-data"],
        },
      },
      {
        id: "report-data", ownerUserId: "owner", name: "report-data",
        description: "Read raw workforce reporting rows and source identity.",
        instructions: "PRIVATE SOURCE PROTOCOL", sourceKind: "package", version: 1, contentHash: "data", updatedAt: 1,
        agentLoop: {
          roles: ["source_provider"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
          executionProfiles: ["local_script"], producesEvidenceKinds: ["source_summary", "structured_extraction_artifact"],
        },
      },
    ];
    const names = ["load_skill", "computer_run_command", "websearch", "webfetch", "computer_write_file", "verify_artifact_acceptance"];
    const objective = "Analyze workforce distributions and deliver the result as an HTML file.";
    const runId = `workflow-format-${useDomainWorkflow}`;
    const canonicalState = createCanonicalRunState({
      runId, userInput: objective, now: 1,
      understanding: understandTask({ objective, toolNames: names, evidenceDemand: "source_grounded", resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1", operation: "composite", requiresExecution: true,
        deliverables: [{ targetId: "report", purpose: objective, expectedArtifactCount: 1, action: "create", kind: "html", format: "html", surface: "workspace_artifact" }],
      } }),
    });
    const selectedSkillRoles = useDomainWorkflow
      ? [{ skillId: "domain-analysis", role: "primary_builder" as const, reason: "Owns analysis method." },
        { skillId: "report-data", role: "source_provider" as const, reason: "Supplies reporting rows." }]
      : [];
    const model: ModelAdapter = {
      limits: { contextWindowTokens: 40_000, maxOutputTokens: 4_096 },
      async complete(request) {
        const context = request.runtimeContext?.content ?? "";
        assert.match(context, /Changing a conversational answer to a file adds production/);
        assert.doesNotMatch(context, /"researchPlanningPolicy"|"maxSearches"|"source_summary_and_source_urls_are_recorded"/);
        assert.match(context, /<required_skill_names>report-data<\/required_skill_names>/);
        assert.match(context, /Planning cannot call load_skill/);
        assert.doesNotMatch(context, /PRIVATE ANALYSIS METHOD|PRIVATE SOURCE PROTOCOL/);
        return {
          content: "", finishReason: "tool_calls", toolCalls: [{ id: "plan", name: "submit_outcome_plan", arguments: {
            schema: "agentloop.outcomePlan/v2", goal: objective, shape: "fact_then_produce", selectedSkillRoles,
            leaves: [
              { id: "facts", objective: "Acquire workforce rows and analyze the requested distributions.", dependsOn: [], role: "fact_acquisition",
                skillIds: useDomainWorkflow ? ["domain-analysis", "report-data"] : [],
                requiredCapabilities: useDomainWorkflow
                  ? ["skill_instruction_load", "skill_local_script_execution", skillSourceProviderCapabilityId(skills[1]!.id, "database")]
                  : ["web_research"],
                targetIds: [], evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" } },
              { id: "html", objective: "Render the dependency analysis as an HTML report.", dependsOn: ["facts"], role: "produce",
                skillIds: [], requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"], targetIds: ["report"],
                evidenceContract: { requiredKinds: ["artifact_path", "artifact_non_empty"], caveatPolicy: "none" } },
            ],
          } }],
        };
      },
    };
    const task: TaskSpec = { runId, canonicalState, availableSkills: skills, availableToolNames: names,
      selectedSkillRoles: [{ skillId: "domain-analysis", role: "primary_builder", reason: "Candidate for analysis." },
        { skillId: "report-data", role: "source_provider", reason: "Companion source." }],
      availableCapabilities: [...planningCapabilitiesFromToolNames(names), ...planningCapabilitiesFromSkills(skills)],
    };
    const proposal = await new ModelPlanner(model).plan(task);
    const admitted = admitPlan({ runId, canonicalState, proposal, availableSkills: skills,
      availableToolNames: new Set(names), availableCapabilities: task.availableCapabilities! });
    const facts = admitted.steps.find((step) => step.id === "facts")!;
    const html = admitted.steps.find((step) => step.id === "html")!;
    assert.deepEqual(new Set(facts.skillIds), new Set(useDomainWorkflow ? ["domain-analysis", "report-data"] : []));
    assert.deepEqual(facts.evidenceContract?.requiredKinds, ["source_summary"]);
    assert.equal(facts.requiredCapabilities.includes("artifact_acceptance"), false);
    assert.equal(facts.successCriteria.some((c) => c.id.startsWith("artifact_")), false);
    assert.deepEqual(facts.executionBinding.targetIds, []);
    assert.equal(html.evidenceContract?.requiredKinds.includes("artifact_acceptance"), true);
    assert.equal(html.evidenceContract?.requiredKinds.includes("artifact_openable"), true);
    assert.deepEqual(html.executionBinding.targetIds, ["report"]);
  });
}
