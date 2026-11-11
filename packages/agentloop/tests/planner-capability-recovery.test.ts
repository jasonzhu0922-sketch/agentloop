import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { ModelPlanner } from "../src/planning/planner.ts";
import type { ConversationTurnResolution, PlanProposal, PlanningCapability, PlanningToolSummary, TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { inspectSkillPackage } from "../src/skills/skill-package.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";
import { selectPlanningSkillRoles } from "../src/runtime/run-service.ts";
import { admitPlan } from "../src/planning/admission.ts";
import { resolveSourceGroundingGap } from "../src/planning/capability-resolution.ts";
import { planningCapabilitiesFromSkills, planningCapabilitiesFromTools, planningCapabilitiesForSelectedSkills } from "../src/planning/step-execution-binding.ts";

const tools: readonly PlanningToolSummary[] = [
  {
    name: "mcp_data_asset_read",
    description: "Read ODS data.",
    source: {
      id: "data-asset",
      transport: "mcp",
      capabilities: [{
        id: "data_asset.ods_read",
        category: "data_asset",
        producesEvidenceKinds: ["source_summary", "schema_summary", "record_counts"],
        sourceKinds: ["database"],
      }],
    },
  },
  { name: "materialize_result_json", description: "Materialize an authorized JSON Result." },
  { name: "computer_aggregate_table_artifact", description: "Calculate a distribution from a structured extraction artifact." },
  { name: "computer_run_command", description: "Compute over a materialized workspace input." },
];

const sourceCapability: PlanningCapability = {
  id: "data_asset.ods_read",
  category: "data_asset",
  produces: ["source_summary", "schema_summary", "record_counts"],
  sourceKinds: ["database"],
  sideEffect: "external_read",
  risk: "medium",
};

const materializationCapability: PlanningCapability = {
  id: "runtime_result_json_materialization",
  category: "structured_extraction",
  produces: ["structured_extraction_artifact"],
  sourceKinds: ["workspace_file"],
  sideEffect: "workspace_write",
  risk: "low",
};

const coverageCapability: PlanningCapability = {
  id: "workspace_structured_artifact_read",
  category: "structured_data",
  produces: ["table_coverage"],
  sourceKinds: ["workspace_file"],
  sideEffect: "workspace_read",
  risk: "low",
};

function proposal(capabilities: readonly string[]): ModelResponse {
  return {
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: `proposal-${capabilities.join("-")}`,
      name: "submit_outcome_plan",
      arguments: {
        schema: "agentloop.outcomePlan/v2",
        goal: "Query an ODS table's structure and calculate field value distributions, null rates, and row counts.",
        shape: "single_leaf",
        selectedSkillRoles: [],
        leaves: [{
          id: "distribution",
          objective: "Read ODS metadata and records, materialize the structured result, then calculate field value distributions and null rates.",
          dependsOn: [],
          role: "fact_acquisition",
          skillIds: [],
          requiredCapabilities: capabilities,
          evidenceContract: {
            requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "table_coverage"],
            caveatPolicy: "mark_unverified_facts",
          },
        }],
      },
    }],
  };
}

test("Planner does not preserve an aggregation process as a completion evidence requirement", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(request: ModelInvocation): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) {
        assert.match(request.runtimeContext?.content ?? "", /"canonicalRunState"/);
        assert.match(request.runtimeContext?.content ?? "", /"userInput":"查询 ODS 表的数据结构/);
        assert.doesNotMatch(request.runtimeContext?.content ?? "", /"planningTask"/);
        return proposal(["data_asset.ods_read", "workspace_structured_artifact_read"]);
      }
      if (calls === 2) {
        assert.match(request.runtimeContext?.content ?? "", /Candidate additions are additive/);
        assert.match(request.runtimeContext?.content ?? "", /runtime_result_json_materialization/);
        return proposal(["data_asset.ods_read", "runtime_result_json_materialization"]);
      }
      throw new Error(`Unexpected Planner call ${calls}`);
    },
  };
  const task: TaskSpec = {
    runId: "run-capability-recovery-preservation",
    canonicalState: createCanonicalRunState({
      runId: "run-capability-recovery-preservation",
      userInput: "查询 ODS 表的数据结构，并分析各字段取值分布、空值率和行数。",
      understanding: understandTask({
        objective: "查询 ODS 表的数据结构，并分析各字段取值分布、空值率和行数。",
        toolNames: tools.map((tool) => tool.name),
      }),
      now: 1,
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
    availableCapabilities: [sourceCapability, coverageCapability],
    capabilityRecovery: {
      availableSkills: [],
      availableCapabilities: [sourceCapability, materializationCapability, coverageCapability],
    },
  };

  const admitted = await new ModelPlanner(model, { maxPlanningTurns: 2 }).plan(task);

  assert.equal(calls, 2);
  assert.deepEqual(admitted.steps[0]?.requiredCapabilities, [
    "data_asset.ods_read",
    "runtime_result_json_materialization",
  ]);
  assert.equal(admitted.steps[0]?.evidenceContract?.requiredKinds.includes("table_coverage"), false);
  assert.deepEqual(admitted.steps[0]?.successCriteria.map((criterion) => criterion.id), ["distribution-core-result"]);
});

test("Planner rejects the removed derived aggregation evidence kind", async () => {
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(): Promise<ModelResponse> {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "legacy-evidence-kind",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: "Produce a report.",
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: [{
              id: "report",
              objective: "Produce a report.",
              dependsOn: [],
              role: "produce",
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write"],
              evidenceContract: {
                requiredKinds: ["derived_aggregation"],
                caveatPolicy: "none",
              },
            }],
          },
        }],
      };
    },
  };
  const runId = "run-reject-removed-evidence-kind";
  const task: TaskSpec = {
    runId,
    canonicalState: createCanonicalRunState({
      runId,
      userInput: "Produce a report.",
      understanding: understandTask({ objective: "Produce a report.", toolNames: ["computer_write_file"] }),
      now: 1,
    }),
    availableSkills: [],
    availableToolNames: ["computer_write_file"],
  };

  await assert.rejects(
    new ModelPlanner(model, { maxPlanningTurns: 1 }).plan(task),
    /unsupported evidence kind derived_aggregation/,
  );
});

async function customSkill(name: string): Promise<PrivateSkill> {
  const inspection = await inspectSkillPackage(resolve(import.meta.dirname, "../../../apps/agentloop-multi-runtime/custom-skills", name));
  return { id: `discovered:${name}`, name, description: inspection.description, agentLoop: inspection.agentLoop } as PrivateSkill;
}

test("the real data-analysis package owns regional sales acquisition and passes first-turn Planner and final Admission without an HR source", async () => {
  const analysis = await customSkill("data-analysis");
  const hr = await customSkill("hr-report-data");
  assert.ok(analysis.agentLoop?.roles.includes("primary_builder"));
  assert.ok(analysis.agentLoop?.roles.includes("source_provider"));
  const goal = "用 data-analysis 分析 demo 场景下的2026 年 6 月份各区域的销售额分布";
  const turnResolution: ConversationTurnResolution = {
    schema: "agentloop.conversationTurnResolution/v1", source: "model", mode: "execute", relation: "new_goal",
    inputMode: "none", effectiveGoal: goal, evidenceDemand: "lookup_lite", memoryAction: "none", userConstraints: [],
    evidenceStrategy: "lookup_lite", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, memoryIntents: [],
    requiredCapabilityReferences: [{ kind: "skill", reference: analysis.name }],
    taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
      deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
  };
  const understanding = understandTask({ objective: goal, evidenceDemand: "lookup_lite", resolvedTaskIntent: turnResolution.taskIntent });
  const selected = selectPlanningSkillRoles([analysis, hr], understanding, [analysis.id]);
  assert.deepEqual(selected.map(({ skill }) => skill.id), [analysis.id]);
  assert.equal(selected[0].selection.role, "primary_builder");
  const availableSkills = selected.map(({ skill }) => skill);
  const localTools = [
    { name: "load_skill", description: "Load a bound Skill" },
    { name: "computer_run_command", description: "Run a bound Skill script" },
  ];
  const runId = "regional-sales-own-source";
  const canonicalState = createCanonicalRunState({ runId, userInput: goal, understanding, turnResolution, now: 1 });
  let calls = 0;
  const proposal = await new ModelPlanner({
    limits: { contextWindowTokens: 40000, maxOutputTokens: 4096 },
    async complete(request) {
      calls += 1;
      assert.match(request.runtimeContext?.content ?? "", /skill_source_provider.database.discovered:data-analysis/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /hr-report-data/);
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "regional-sales", name: "submit_outcome_plan", arguments: {
        schema: "agentloop.outcomePlan/v2", goal, shape: "fact_then_produce",
        selectedSkillRoles: [{ skillId: analysis.id, role: "primary_builder", reason: "Query and analyze the selected scenario." }],
        leaves: [
          { id: "acquire", objective: "Query regional sales in June 2026 and preserve source facts.", role: "fact_acquisition",
            dependsOn: [], skillIds: [analysis.id], targetIds: [], requiredCapabilities: ["skill_local_script_execution"],
            evidenceContract: { requiredKinds: ["source_summary", "record_counts"], caveatPolicy: "mark_unverified_facts" } },
          { id: "answer", objective: "Explain regional sales amounts and shares from the acquired facts.", role: "deliver",
            dependsOn: ["acquire"], skillIds: [], targetIds: ["answer"], requiredCapabilities: ["conversation_delivery"] },
        ],
      } }] };
    },
  }, { maxPlanningTurns: 1 }).plan({ runId, canonicalState, availableSkills, availableTools: localTools,
    availableToolNames: localTools.map((tool) => tool.name), selectedSkillRoles: selected.map(({ selection }) => selection),
    availableCapabilities: [...planningCapabilitiesFromTools(localTools), ...planningCapabilitiesFromSkills(availableSkills)],
  });
  assert.equal(calls, 1);
  const plan = admitPlan({ runId, canonicalState, proposal, availableSkills,
    availableToolNames: new Set(localTools.map((tool) => tool.name)), availableTools: localTools,
    availableCapabilities: planningCapabilitiesForSelectedSkills({ selectedSkillIds: proposal.selectedSkillIds,
      availableSkills, availableTools: localTools, availableToolNames: localTools.map((tool) => tool.name) }),
  });
  const acquire = plan.steps.find((step) => step.id === "acquire")!;
  assert.deepEqual(acquire.skillIds, [analysis.id]);
  assert.deepEqual(acquire.executionBinding.sourceKinds, ["database"]);
  assert.ok(acquire.executionBinding.evidenceProducers.some((producer) => producer.evidenceKind === "source_summary"
    && producer.skillId === analysis.id && producer.resolvedToolNames.includes("computer_run_command")));
  assert.ok(acquire.executionBinding.evidenceProducers.every((producer) => producer.skillId === undefined || producer.skillId === analysis.id));
});

test("ordinary relevance does not force an independent HR provider beside a selected sales workflow", async () => {
  const analysis = await customSkill("data-analysis");
  const hr = await customSkill("hr-report-data");
  for (const objective of [
    "用 data-analysis 分析2026 年 6 月份各区域的销售额分布",
    "使用 data-analysis 技能，分析 2026 年 6 月份各区域的销售额分布（按区域维度统计销售额并给出分布/占比与排名结论）。",
  ]) {
    for (const roles of [["primary_builder"], ["primary_builder", "source_provider"]] as const) {
      const owner = { ...analysis, agentLoop: { ...analysis.agentLoop!, roles } };
      const understanding = understandTask({ objective, evidenceDemand: "lookup_lite" });
      assert.deepEqual(selectPlanningSkillRoles([owner, hr], understanding, [owner.id]).map(({ skill }) => skill.id), [owner.id]);
    }
  }
});

const recoveryOwner = {
  id: "discovered:regional-sales", name: "regional-sales", description: "Query regional sales",
  agentLoop: { roles: ["primary_builder", "source_provider"], artifactKinds: ["none"], sourceKinds: ["database"],
    qaKinds: [], executionProfiles: ["local_script"], producesEvidenceKinds: ["source_summary", "record_counts"] },
} as PrivateSkill;
const otherDatabase = {
  ...recoveryOwner, id: "discovered:unrelated-records", name: "unrelated-records",
} as PrivateSkill;
const webSource: PlanningCapability = { id: "web_research", category: "web", sourceKinds: ["web"],
  produces: ["source_summary", "source_urls"], sideEffect: "external_read", risk: "medium" };

function sourceProposal(skillIds: string[] = []): PlanProposal {
  return { goal: "Analyze regional sales", selectedSkillIds: skillIds, steps: [{ id: "acquire", role: "fact_acquisition",
    objective: "Acquire regional sales", dependencies: [], skillIds, requiredCapabilities: [], successCriteria: [],
    evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" } }] };
}

for (const evidenceDemand of ["lookup_lite", "source_grounded", "strict_user_source"] as const) {
  test(`${evidenceDemand} source recovery preserves the declaring Skill rather than borrowing another database or web source`, () => {
    const capabilities = [...planningCapabilitiesFromSkills([recoveryOwner, otherDatabase]), webSource];
    const gap = resolveSourceGroundingGap({ evidenceDemand, proposal: sourceProposal([recoveryOwner.id]),
      currentSkills: [recoveryOwner], currentCapabilities: capabilities,
      catalog: { availableSkills: [recoveryOwner, otherDatabase], availableCapabilities: capabilities } });
    assert.deepEqual(gap?.candidates.map((candidate) => candidate.requiredSkillIds), [[recoveryOwner.id]]);
    assert.deepEqual(gap?.missingEvidenceKinds, ["source_summary"]);
  });
}

test("source recovery without a selected channel exposes database and web producers without inventing a URL requirement", () => {
  const capabilities = [...planningCapabilitiesFromSkills([recoveryOwner]), webSource];
  const gap = resolveSourceGroundingGap({ evidenceDemand: "lookup_lite", proposal: sourceProposal(),
    currentSkills: [], currentCapabilities: [],
    catalog: { availableSkills: [recoveryOwner], availableCapabilities: capabilities } });
  assert.equal(gap?.candidates.length, 2);
  assert.ok(gap?.candidates.some((candidate) => candidate.sourceKinds.includes("database")));
  assert.deepEqual(gap?.missingEvidenceKinds, ["source_summary"]);
});

test("source recovery honors explicit ToolSource, uploaded-file and visible-directory identities", () => {
  const selectedApi: PlanningCapability = { id: "selected_api", category: "api", sourceIds: ["selected-source"],
    sourceKinds: ["api"], produces: ["source_summary"], sideEffect: "external_read", risk: "medium" };
  const upload: PlanningCapability = { ...selectedApi, id: "uploaded", sourceIds: undefined, sourceKinds: ["uploaded_source"] };
  const directory: PlanningCapability = { ...upload, id: "directory", sourceKinds: ["visible_directory"] };
  const capabilities = [webSource, selectedApi, { ...selectedApi, id: "other_api", sourceIds: ["another-source"] }, upload, directory];
  for (const [constraint, expected] of [
    [{ requiredToolSourceIds: ["selected-source"] }, "selected_api"],
    [{ requiredUploadedSourceIds: ["file-1"] }, "uploaded"],
    [{ requiredVisibleDirectoryIds: ["directory-1"] }, "directory"],
  ] as const) {
    const proposal = sourceProposal();
    const gap = resolveSourceGroundingGap({ evidenceDemand: "lookup_lite",
      proposal: { ...proposal, steps: proposal.steps.map((step) => ({ ...step, sourceConstraint: constraint })) },
      currentSkills: [], currentCapabilities: [], catalog: { availableSkills: [], availableCapabilities: capabilities } });
    assert.deepEqual(gap?.candidates.map((candidate) => candidate.capabilityId), [expected]);
  }
});
