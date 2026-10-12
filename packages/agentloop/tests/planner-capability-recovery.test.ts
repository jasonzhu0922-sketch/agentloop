import assert from "node:assert/strict";
import test from "node:test";
import { ModelPlanner } from "../src/planning/planner.ts";
import type { PlanningCapability, PlanningToolSummary, TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";

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
