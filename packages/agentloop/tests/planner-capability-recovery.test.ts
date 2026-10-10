import assert from "node:assert/strict";
import test from "node:test";
import { ModelPlanner } from "../src/planning/planner.ts";
import type { PlanningCapability, PlanningToolSummary, TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";

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

const aggregationCapability: PlanningCapability = {
  id: "workspace_command_computation",
  category: "structured_data",
  produces: ["derived_aggregation"],
  sourceKinds: ["workspace_file"],
  sideEffect: "workspace_write",
  risk: "medium",
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
            requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "derived_aggregation"],
            caveatPolicy: "mark_unverified_facts",
          },
        }],
      },
    }],
  };
}

test("capability recovery preserves prior evidence producers across successive gaps", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(request: ModelInvocation): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) return proposal(["data_asset.ods_read", "workspace_command_computation"]);
      if (calls === 2) {
        assert.match(request.runtimeContext?.content ?? "", /Candidate additions are additive/);
        assert.match(request.runtimeContext?.content ?? "", /runtime_result_json_materialization/);
        return proposal(["data_asset.ods_read", "runtime_result_json_materialization"]);
      }
      if (calls === 3) {
        assert.match(request.runtimeContext?.content ?? "", /preserveCapabilityIds/);
        assert.match(request.runtimeContext?.content ?? "", /runtime_result_json_materialization/);
        assert.match(request.runtimeContext?.content ?? "", /workspace_command_computation/);
        // Repeating the first mistake requires a third capability recovery.
        return proposal(["data_asset.ods_read", "workspace_command_computation"]);
      }
      assert.equal(calls, 4);
      assert.match(request.runtimeContext?.content ?? "", /runtime_result_json_materialization/);
      return proposal([
        "data_asset.ods_read",
        "runtime_result_json_materialization",
        "workspace_command_computation",
      ]);
    },
  };
  const task: TaskSpec = {
    runId: "run-capability-recovery-preservation",
    input: "查询 ODS 表的数据结构，并分析各字段取值分布、空值率和行数。",
    taskUnderstanding: understandTask({
      objective: "查询 ODS 表的数据结构，并分析各字段取值分布、空值率和行数。",
      toolNames: tools.map((tool) => tool.name),
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
    availableCapabilities: [sourceCapability, aggregationCapability],
    capabilityRecovery: {
      availableSkills: [],
      availableCapabilities: [sourceCapability, materializationCapability, aggregationCapability],
    },
  };

  const admitted = await new ModelPlanner(model, { maxPlanningTurns: 4 }).plan(task);

  assert.equal(calls, 4);
  assert.deepEqual(admitted.steps[0]?.requiredCapabilities, [
    "data_asset.ods_read",
    "runtime_result_json_materialization",
    "workspace_command_computation",
  ]);
});
