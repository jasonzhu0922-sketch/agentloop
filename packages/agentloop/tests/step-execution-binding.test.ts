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
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";

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

test("Admission rejects an evidence capability that resolves to no producer Tool", () => {
  const runId = "run-empty-evidence-producer";
  assert.throws(() => admitPlan({
    runId,
    proposal: {
      goal: "Compute the required total.",
      selectedSkillIds: [],
      steps: [{
        id: "acquire",
        objective: "Compute the required total.",
        dependencies: [],
        role: "fact_acquisition",
        skillIds: [],
        requiredCapabilities: ["declared_without_tool"],
        evidenceContract: { requiredKinds: ["table_coverage"], caveatPolicy: "none" },
        successCriteria: [{ id: "table_coverage", description: "Complete table coverage is observed.", source: "planner" }],
      }],
    },
    availableSkills: [],
    availableToolNames: new Set(),
    availableCapabilities: [{
      id: "declared_without_tool",
      produces: ["table_coverage"],
      sourceKinds: ["database"],
      sideEffect: "external_read",
      risk: "low",
    }],
    canonicalState: createCanonicalRunState({
      runId,
      userInput: "Compute the required total.",
      understanding: understandTask({ objective: "Compute the required total." }),
      now: 1,
    }),
  }), /bound capabilities cannot produce: table_coverage/);
});

test("Admission derives a user-required ToolSource only for leaves that demand its capability", () => {
  const canonicalState = createCanonicalRunState({
    runId: "run-dynamic-tool-source-binding",
    userInput: "Acquire ODS facts and produce a report.",
    understanding: understandTask({ objective: "Acquire ODS facts and produce a report." }),
    requiredToolSourceIds: ["ontoflow-jtbc"],
    now: 1,
  });
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
          successCriteria: [{ id: "delivered", description: "The report is produced.", source: "planner" }],
        },
      ],
    },
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    availableTools: tools,
    availableCapabilities: planningCapabilitiesFromTools(tools),
    canonicalState,
  });

  const acquisition = plan.steps.find((step) => step.id === "ods-facts");
  const report = plan.steps.find((step) => step.id === "ods-report");

  assert.deepEqual(acquisition?.sourceConstraint?.requiredToolSourceIds, ["ontoflow-jtbc"]);
  assert.deepEqual(acquisition?.executionBinding.requiredToolSourceIds, ["ontoflow-jtbc"]);
  assert.equal(report?.sourceConstraint, undefined);
  assert.equal(report?.executionBinding.requiredToolSourceIds, undefined);
  assert.deepEqual(report?.executionBinding.resolvedToolNames, ["computer_write_file"]);
});

test("Admission transports a dependency-owned source receipt instead of requiring a second leaf to recreate it", () => {
  const runId = "run-dependency-source-receipt";
  const understanding = understandTask({ objective: "Inspect the source facts and prepare the next analysis stage." });
  const plan = admitPlan({
    runId,
    proposal: {
      goal: "Inspect the source facts and prepare the next analysis stage.",
      selectedSkillIds: [],
      steps: [
        {
          id: "source-index",
          objective: "Acquire the bounded source summary.",
          dependencies: [],
          role: "fact_acquisition",
          skillIds: [],
          requiredCapabilities: ["data_asset.ods_read"],
          evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" },
          successCriteria: [{ id: "source_summary", description: "Source summary is committed.", source: "planner" }],
        },
        {
          id: "extract-from-index",
          objective: "Use the committed index as the evidence basis for extraction.",
          dependencies: ["source-index"],
          role: "fact_acquisition",
          skillIds: [],
          requiredCapabilities: ["data_asset.ods_read"],
          evidenceContract: { requiredKinds: ["source_summary", "explicit_caveats"], caveatPolicy: "mark_unverified_facts" },
          successCriteria: [
            { id: "source_summary", description: "Source summary is available through the dependency.", source: "planner" },
            { id: "explicit_caveats", description: "Any remaining uncertainty is stated.", source: "planner", blocking: false },
          ],
        },
      ],
    },
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    availableTools: tools,
    availableCapabilities: planningCapabilitiesFromTools(tools),
    canonicalState: createCanonicalRunState({ runId, userInput: "Inspect the source facts and prepare the next analysis stage.", understanding, now: 1 }),
  });

  const downstream = plan.steps.find((step) => step.id === "extract-from-index");
  assert.deepEqual(downstream?.evidenceContract?.requiredKinds, ["explicit_caveats"]);
  assert.equal(downstream?.successCriteria.some((criterion) => criterion.id === "source_summary"), false);
  assert.equal(downstream?.executionBinding.evidenceProducers.some((producer) => producer.evidenceKind === "source_summary"), false);
  assert.equal(downstream?.executionBinding.evidenceProducers.some((producer) => producer.evidenceKind === "explicit_caveats"), true);
});

test("Admission rejects an incomplete structured artifact binding before execution and materializes the frozen purpose", () => {
  const taskSemantics = understandTask({
    objective: "Produce the ODS analysis and the quality-control report.",
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "composite",
      requiresExecution: true,
      deliverables: [
        { targetId: "ods-analysis", purpose: "ODS analysis report", expectedArtifactCount: 1, action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" },
        { targetId: "ods-quality", purpose: "ODS quality-control report", expectedArtifactCount: 1, action: "create", kind: "document", format: "markdown", surface: "workspace_artifact" },
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
      targetIds: ["ods-analysis"],
      successCriteria: [{ id: "delivered", description: "Reports are produced.", source: "planner" as const }],
    }],
  };
  const admission = () => admitPlan({
    runId: "run-structured-artifact-binding",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    canonicalState: createCanonicalRunState({ runId: "run-structured-artifact-binding", userInput: "Produce the requested ODS reports.", understanding: taskSemantics, now: 1 }),
  });
  assert.throws(admission, /must cover canonical delivery targets exactly once: missing ods-quality/);

  const plan = admitPlan({
    runId: "run-structured-artifact-binding-complete",
    proposal: {
      ...proposal,
      steps: [{ ...proposal.steps[0]!, targetIds: ["ods-analysis", "ods-quality"] }],
    },
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    canonicalState: createCanonicalRunState({ runId: "run-structured-artifact-binding-complete", userInput: "Produce the requested ODS reports.", understanding: taskSemantics, now: 1 }),
  });
  assert.deepEqual(plan.steps[0]?.executionBinding.artifactTargets, [
    { id: "ods-analysis", deliveryTargetId: "ods-analysis", purpose: "ODS analysis report", kind: "document", format: "markdown", terminalRequired: true },
    { id: "ods-quality", deliveryTargetId: "ods-quality", purpose: "ODS quality-control report", kind: "document", format: "markdown", terminalRequired: true },
  ]);

  assert.throws(() => admitPlan({
    runId: "run-duplicate-delivery-owner",
    proposal: {
      ...proposal,
      steps: [
        { ...proposal.steps[0]!, id: "primary-owner", targetIds: ["ods-analysis", "ods-quality"] },
        { ...proposal.steps[0]!, id: "duplicate-owner", targetIds: ["ods-analysis"] },
      ],
    },
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    canonicalState: createCanonicalRunState({ runId: "run-duplicate-delivery-owner", userInput: "Produce the requested ODS reports.", understanding: taskSemantics, now: 1 }),
  }), /multiply owned ods-analysis/);
});

test("one semantic deliverable family expands into the exact canonical artifact cardinality", () => {
  const understanding = understandTask({
    objective: "Split the source document into four PDF files.",
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "transform_artifact",
      requiresExecution: true,
      deliverables: [{
        targetId: "split-pdf-parts",
        purpose: "Deliver four independently accepted PDF parts.",
        expectedArtifactCount: 4,
        action: "transform",
        kind: "document",
        format: "pdf",
        surface: "workspace_artifact",
      }],
    },
  });

  assert.deepEqual(understanding.artifactTargets?.map((target) => target.id), [
    "split-pdf-parts.1",
    "split-pdf-parts.2",
    "split-pdf-parts.3",
    "split-pdf-parts.4",
  ]);
  assert.equal(understanding.artifactTargets?.every((target) => target.format === "pdf"), true);

  const plan = admitPlan({
    runId: "run-four-artifacts-one-target",
    proposal: {
      goal: "Split the source document into four PDF files.",
      selectedSkillIds: [],
      steps: [{
        id: "split-pdfs",
        objective: "Split and deliver four PDF files.",
        dependencies: [],
        role: "produce",
        skillIds: [],
        requiredCapabilities: ["workspace_artifact_write"],
        targetIds: ["split-pdf-parts"],
        successCriteria: [{ id: "delivered", description: "Four PDFs are delivered.", source: "planner" }],
      }],
    },
    availableSkills: [],
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    canonicalState: createCanonicalRunState({
      runId: "run-four-artifacts-one-target",
      userInput: "Split the source document into four PDF files.",
      understanding,
      now: 1,
    }),
  });
  assert.deepEqual(plan.steps[0]?.executionBinding.targetIds, ["split-pdf-parts"]);
  assert.deepEqual(plan.steps[0]?.executionBinding.artifactTargets?.map((target) => target.id), [
    "split-pdf-parts.1",
    "split-pdf-parts.2",
    "split-pdf-parts.3",
    "split-pdf-parts.4",
  ]);
});
