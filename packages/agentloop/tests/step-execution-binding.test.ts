import assert from "node:assert/strict";
import test from "node:test";
import { admitPlan } from "../src/planning/admission.ts";
import {
  planningCapabilitiesFromTools,
  resolveToolNamesForCapabilities,
  unsatisfiedToolCapabilities,
} from "../src/planning/step-execution-binding.ts";
import type { PlanningToolSummary } from "../src/planning/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";

const tools: readonly PlanningToolSummary[] = [
  {
    name: "mcp_ontoflow_jtbc_call_rdb_sql_api_query",
    description: "Read ODS metadata",
    source: {
      id: "ontoflow-jtbc",
      transport: "mcp",
      capabilities: [{
        id: "data_asset.ods_read",
        category: "data_asset",
        producesEvidenceKinds: ["source_summary", "schema_summary", "record_counts", "explicit_caveats"],
        sourceKinds: ["database"],
      }],
    },
  },
  { name: "load_skill", description: "Load the selected Skill" },
  { name: "computer_write_file", description: "Write an artifact" },
  { name: "materialize_result_json", description: "Materialize an authorized JSON Runtime Result" },
];

test("ToolSource constraints retain Runtime-owned capabilities beside the bound MCP Tool", () => {
  const available = new Set(tools.map((tool) => tool.name));
  const capabilities = ["data_asset.ods_read", "skill_instruction_load", "workspace_artifact_write", "runtime_result_json_materialization"];

  assert.deepEqual(
    resolveToolNamesForCapabilities(capabilities, available, tools, ["ontoflow-jtbc"]),
    ["mcp_ontoflow_jtbc_call_rdb_sql_api_query", "load_skill", "computer_write_file", "materialize_result_json"],
  );
  assert.deepEqual(
    unsatisfiedToolCapabilities(capabilities, available, tools, ["ontoflow-jtbc"]),
    [],
  );
});

test("ToolSource capability declarations carry their host-owned evidence semantics into planning", () => {
  const capability = planningCapabilitiesFromTools(tools).find((item) => item.id === "data_asset.ods_read");
  assert.deepEqual(capability?.produces, ["source_summary", "schema_summary", "record_counts", "explicit_caveats"]);
  assert.deepEqual(capability?.sourceKinds, ["database"]);
});

test("Admission derives a user-required ToolSource only for leaves that demand its capability", () => {
  const plan = admitPlan({
    runId: "run-dynamic-tool-source-binding",
    proposal: {
      goal: "Acquire ODS facts and produce a report.",
      selectedSkillIds: [],
      steps: [
        {
          id: "ods-facts",
          objective: "Acquire ODS facts.",
          dependencies: [],
          role: "fact_acquisition",
          skillIds: [],
          requiredCapabilities: ["data_asset.ods_read"],
          // Legacy/model output may still carry this value. Admission derives
          // the same binding from the declared capability and user policy.
          sourceConstraint: { requiredToolSourceIds: ["ontoflow-jtbc"] },
          evidenceContract: {
            requiredKinds: ["source_summary"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [{ id: "source_summary", description: "ODS facts are observed.", source: "planner" }],
        },
        {
          id: "ods-report",
          objective: "Produce the report from the acquired facts.",
          dependencies: ["ods-facts"],
          role: "produce",
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
          // This stale model hint must not grant or constrain an MCP Tool.
          sourceConstraint: { requiredToolSourceIds: ["ontoflow-jtbc"] },
          successCriteria: [{ id: "delivered", description: "The report is produced.", source: "planner" }],
        },
      ],
    },
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    availableTools: tools,
    availableCapabilities: planningCapabilitiesFromTools(tools),
    requiredToolSourceIds: ["ontoflow-jtbc"],
  });

  const acquisition = plan.steps.find((step) => step.id === "ods-facts");
  const report = plan.steps.find((step) => step.id === "ods-report");

  assert.deepEqual(acquisition?.sourceConstraint?.requiredToolSourceIds, ["ontoflow-jtbc"]);
  assert.deepEqual(acquisition?.executionBinding.requiredToolSourceIds, ["ontoflow-jtbc"]);
  assert.equal(report?.sourceConstraint, undefined);
  assert.equal(report?.executionBinding.requiredToolSourceIds, undefined);
  assert.deepEqual(report?.executionBinding.resolvedToolNames, ["computer_write_file"]);
});

test("Admission rejects an incomplete structured artifact binding before execution and materializes the frozen purpose", () => {
  const taskSemantics = understandTask({
    objective: "Produce the ODS analysis and the quality-control report.",
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "composite",
      requiresExecution: true,
      deliverables: [
        { targetId: "ods-analysis", purpose: "ODS analysis report", action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" },
        { targetId: "ods-quality", purpose: "ODS quality-control report", action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" },
      ],
    },
  });
  const proposal = {
    goal: "Produce the requested ODS reports.",
    selectedSkillIds: [],
    steps: [{
      id: "produce-reports",
      objective: "Produce the reports.",
      dependencies: [],
      role: "produce" as const,
      skillIds: [],
      requiredCapabilities: ["workspace_artifact_write"],
      artifactTargetIds: ["ods-analysis"],
      successCriteria: [{ id: "delivered", description: "Reports are produced.", source: "planner" as const }],
    }],
  };
  const admission = () => admitPlan({
    runId: "run-structured-artifact-binding",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    taskSemantics,
  });
  assert.throws(admission, /must cover the requested targets exactly: missing ods-quality/);

  const plan = admitPlan({
    runId: "run-structured-artifact-binding-complete",
    proposal: {
      ...proposal,
      steps: [{ ...proposal.steps[0]!, artifactTargetIds: ["ods-analysis", "ods-quality"] }],
    },
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    taskSemantics,
  });
  assert.deepEqual(plan.steps[0]?.executionBinding.artifactTargets, [
    { id: "ods-analysis", purpose: "ODS analysis report", kind: "document", format: "markdown", terminalRequired: true },
    { id: "ods-quality", purpose: "ODS quality-control report", kind: "document", format: "markdown", terminalRequired: true },
  ]);
});
