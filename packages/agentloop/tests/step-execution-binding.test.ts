import assert from "node:assert/strict";
import test from "node:test";
import { admitPlan } from "../src/planning/admission.ts";
import {
  planningCapabilitiesFromSkills,
  planningCapabilitiesFromTools,
  requiredToolSourceIdsForConversationTurn,
  resolveToolNamesForCapabilities,
  reusableToolSourceIdsForContinuation,
  unsatisfiedToolCapabilities,
} from "../src/planning/step-execution-binding.ts";
import type { ConversationTurnResolution, ConversationWorkingSet, PlanningToolSummary } from "../src/planning/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { createRuntimeResult, createRuntimeResultCard } from "../src/runtime/runtime-result.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";

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

test("a local-script source provider executes in a conversation leaf without requiring artifact writing", () => {
  const runId = "run-local-script-source-answer";
  const skill = {
    id: "discovered:company-registry",
    name: "company-registry",
    description: "Read company registration facts from a bounded API script.",
    agentLoop: {
      roles: ["source_provider"],
      artifactKinds: ["none"],
      sourceKinds: ["api"],
      qaKinds: [],
      executionProfiles: ["local_script"],
      producesEvidenceKinds: ["source_summary", "explicit_caveats"],
    },
  } as PrivateSkill;
  const capabilityId = `skill_source_provider.api.${skill.id}`;
  const localTools = [
    { name: "load_skill", description: "Load the selected Skill" },
    { name: "computer_run_command", description: "Run a selected Skill script" },
  ];
  const understanding = understandTask({
    objective: "What kind of company is Example Industrial Supply?",
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "lookup",
      requiresExecution: true,
      deliverables: [{
        targetId: "company-explanation",
        purpose: "Explain the company's nature, main business, and market role.",
        expectedArtifactCount: 1,
        action: "none",
        kind: "none",
        surface: "conversation",
      }],
    },
  });

  const plan = admitPlan({
    runId,
    canonicalState: createCanonicalRunState({ runId, userInput: "What kind of company is Example Industrial Supply?", understanding, now: 1 }),
    proposal: {
      goal: "Explain the company using the selected registry source.",
      selectedSkillIds: [skill.id],
      steps: [{
        id: "explain-company",
        objective: "Use registration evidence to answer the user's company question.",
        dependencies: [],
        skillIds: [skill.id],
        targetIds: ["company-explanation"],
        role: "deliver",
        requiredCapabilities: [capabilityId, "conversation_delivery"],
        evidenceContract: { requiredKinds: ["source_summary", "explicit_caveats"], caveatPolicy: "mark_unverified_facts" },
        successCriteria: [{ id: "explained", description: "Explain the company directly.", source: "planner" }],
      }],
    },
    availableSkills: [skill],
    availableToolNames: new Set(localTools.map((tool) => tool.name)),
    availableTools: localTools,
    availableCapabilities: [
      ...planningCapabilitiesFromTools(localTools),
      ...planningCapabilitiesFromSkills([skill]),
    ],
  });

  assert.deepEqual(plan.steps[0]?.requiredCapabilities.sort(), [
    "conversation_delivery",
    "skill_instruction_load",
    "skill_local_script_execution",
    capabilityId,
  ].sort());
  assert.equal(plan.steps[0]?.requiredCapabilities.includes("workspace_artifact_write"), false);
  assert.equal(plan.steps[0]?.executionBinding.resolvedToolNames.includes("computer_run_command"), true);
  assert.equal(plan.steps[0]?.executionBinding.sideEffect, "external_read");
  assert.deepEqual(plan.steps[0]?.executionBinding.evidenceProducers.filter((producer) => producer.evidenceKind === "source_summary"), [{
    evidenceKind: "source_summary", capabilityId, resolvedToolNames: ["computer_run_command"], skillId: skill.id,
  }]);
});

test("continued Runs reuse only ToolSources backed by published completed Step Results", () => {
  const sourceResult = createRuntimeResult({
    kind: "step",
    producer: { runId: "failed-run", planId: "failed-plan", stepId: "source-step" },
    value: "accepted source evidence",
    publication: { status: "published", assessmentRef: "source-assessment", decision: "approved" },
    createdAt: 1,
  });
  const resolution = {
    schema: "agentloop.conversationTurnResolution/v1",
    mode: "execute",
    relation: "continue_prior",
    inputMode: "none",
    targetRunId: "failed-run",
    effectiveGoal: "Continue the failed goal.",
    taskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "composite",
      requiresExecution: true,
      deliverables: [],
    },
    evidenceStrategy: "source_grounded",
    sourceBinding: { mode: "none", visibleDirectoryIds: [] },
    evidenceDemand: "source_grounded",
    userConstraints: [],
    source: "model_guarded",
  } as const satisfies ConversationTurnResolution;
  const sourceBinding = {
    schema: "agentloop.stepExecutionBinding/v1",
    requiredCapabilities: ["data_asset.ods_read"],
    resolvedToolNames: ["mcp_ontoflow_jtbc_call_rdb_sql_api_query"],
    evidenceProducers: [],
    sourceKinds: ["database"],
    sideEffect: "external_read",
    evidenceKinds: ["source_summary"],
    targetIds: [],
    requiredToolSourceIds: ["ontoflow-jtbc"],
  } as const;
  const workset: ConversationWorkingSet = {
    schema: "conversation.workset/v1",
    conversationId: "conversation",
    runCount: 1,
    planCursors: [{
      runId: "failed-run",
      planId: "failed-plan",
      goal: "Acquire ODS evidence and deliver reports.",
      status: "failed",
      selectedSkillIds: [],
      steps: [{
        id: "source-step",
        position: 0,
        status: "completed",
        objective: "Acquire ODS evidence.",
        dependencies: [],
        skillIds: [],
        requiredCapabilities: ["data_asset.ods_read"],
        executionBinding: sourceBinding,
      }, {
        id: "failed-step",
        position: 1,
        status: "failed",
        objective: "Produce the remaining report.",
        dependencies: ["source-step"],
        skillIds: [],
        requiredCapabilities: [],
        executionBinding: { ...sourceBinding, requiredToolSourceIds: ["unpublished-source"] },
      }],
    }],
    resultCards: [createRuntimeResultCard({
      result: sourceResult,
      goal: "Acquire ODS evidence.",
      summary: "accepted source evidence",
      summaryTruncated: false,
    })],
    reusableArtifacts: [],
    failedBoundaries: [],
    recommendedCapabilities: { skillIds: [], capabilityIds: [] },
  };

  assert.deepEqual(reusableToolSourceIdsForContinuation({ resolution, workset }), ["ontoflow-jtbc"]);
  assert.deepEqual(requiredToolSourceIdsForConversationTurn({
    input: "继续",
    effectiveGoal: "Continue the ODS task using ontoflow-jtbc evidence.",
    allowedTools: tools,
    resolution,
    workset,
  }), []);
  assert.deepEqual(reusableToolSourceIdsForContinuation({
    resolution: { ...resolution, inputMode: "refresh_sources" },
    workset,
  }), []);
  assert.deepEqual(requiredToolSourceIdsForConversationTurn({
    input: "Refresh source data with ontoflow-jtbc.",
    effectiveGoal: "Refresh the ODS evidence.",
    allowedTools: tools,
    resolution: { ...resolution, inputMode: "refresh_sources" },
    workset,
  }), ["ontoflow-jtbc"]);
  assert.deepEqual(reusableToolSourceIdsForContinuation({
    resolution,
    workset: { ...workset, resultCards: [] },
  }), []);
});

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
