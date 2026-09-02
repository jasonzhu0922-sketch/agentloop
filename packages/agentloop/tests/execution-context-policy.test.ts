import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationWorkingSet, ExecutionPlan, PlanStep } from "../src/planning/contracts.ts";
import { buildTaskProfile } from "../src/runtime/dynamic-prompt.ts";
import { buildStepRuntimeContextSnapshot } from "../src/runtime/execution-context-policy.ts";

test("execution context binds dependency evidence before downstream reacquisition", () => {
  const inspectStep: PlanStep = {
    id: "inspect_data",
    kind: "leaf",
    position: 0,
    objective: "Inspect the visible directory data and produce reusable analysis evidence.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    recommendedToolNames: ["visible_index_directory", "computer_run_command", "computer_write_file"],
    evidenceContract: {
      requiredKinds: ["source_summary", "artifact_path", "artifact_non_empty", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "completed",
    output: "Inspection found 18 staff and 90 tasks. Reuse summary_data.json and data_inspection_report.md before reading the xlsx files again.",
    evidence: {
      candidateOutput: "Inspection report delivered.",
      modelSteps: 4,
      toolCalls: [{
        toolCallId: "index-visible",
        toolName: "visible_index_directory",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.sourceSummary/v1",
          evidenceKinds: {
            satisfied: ["source_summary"],
            caveated: ["explicit_caveats"],
            failed: [],
          },
          totalFiles: 19,
          samplePaths: ["2026年7月研发组绩效总分统计与分析.xlsx"],
          caveats: ["Directory profile is bounded."],
        }),
      }, {
        toolCallId: "export-summary",
        toolName: "computer_run_command",
        isError: false,
        result: JSON.stringify({
          exitCode: 0,
          signal: null,
          stdout: "Saved to /workspace/conversations/c1/summary_data.json\n",
          stderr: "",
        }),
      }, {
        toolCallId: "write-report",
        toolName: "computer_write_file",
        isError: false,
        result: JSON.stringify({
          path: "data_inspection_report.md",
          bytes: 4904,
          artifactReceipt: {
            schema: "agentloop.artifactReceipt/v1",
            artifact: {
              path: "data_inspection_report.md",
              bytes: 4904,
              sha256: "abc123",
            },
            evidenceKinds: {
              satisfied: ["artifact_path", "artifact_non_empty"],
              caveated: [],
              failed: [],
            },
          },
        }),
      }, {
        toolCallId: "accept-report",
        toolName: "verify_artifact_acceptance",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: {
            path: "data_inspection_report.md",
            bytes: 4904,
            sha256: "abc123",
            kind: "markdown",
          },
          evidenceKinds: {
            satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"],
            caveated: [],
            failed: [],
          },
        }),
      }],
    },
  };
  const buildStep: PlanStep = {
    id: "build_analysis_xlsx",
    kind: "leaf",
    position: 1,
    objective: "Build the final analysis workbook from the inspected data.",
    dependencies: ["inspect_data"],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    recommendedToolNames: ["load_skill", "computer_write_file", "verify_artifact_acceptance"],
    evidenceContract: {
      requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "artifact_openable", "format_matches_request", "delivery_receipt", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "running",
  };
  const plan: ExecutionPlan = {
    id: "plan-1",
    runId: "run-1",
    version: 1,
    goal: "Analyze the directory data.",
    selectedSkillIds: [],
    status: "running",
    steps: [inspectStep, buildStep],
    createdAt: 1,
    updatedAt: 1,
  };

  const snapshot = buildStepRuntimeContextSnapshot({
    step: buildStep,
    plan,
    skills: [],
    workspaceRoot: "/workspace",
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute" }),
    operationProfile: { id: "spreadsheet-production" },
    requiresFileOutput: true,
  });
  const payload = executionContextPayload(snapshot.content);
  const bindings = payload.dependencyEvidenceBindings as {
    readonly schema: string;
    readonly bindings: readonly [{
      readonly stepId: string;
      readonly satisfiedEvidenceKinds: readonly string[];
      readonly missingRequiredEvidenceKinds: readonly string[];
      readonly toolEvidence: readonly Array<{
        readonly toolName: string;
        readonly resultSchemas: readonly string[];
        readonly preview: string;
        readonly artifacts?: readonly Array<{ readonly path: string }>;
      }>;
    }];
  };

  assert.equal(bindings.schema, "agentloop.dependencyEvidenceBindings/v1");
  assert.equal(bindings.bindings[0]?.stepId, "inspect_data");
  assert.equal(bindings.bindings[0]?.satisfiedEvidenceKinds.includes("source_summary"), true);
  assert.equal(bindings.bindings[0]?.satisfiedEvidenceKinds.includes("artifact_path"), true);
  assert.equal(bindings.bindings[0]?.missingRequiredEvidenceKinds.includes("source_summary"), false);
  assert.equal(bindings.bindings[0]?.toolEvidence.some((item) =>
    item.toolName === "visible_index_directory"
    && item.resultSchemas.includes("agentloop.sourceSummary/v1")
  ), true);
  assert.equal(bindings.bindings[0]?.toolEvidence.some((item) =>
    item.toolName === "computer_run_command"
    && item.preview.includes("summary_data.json")
  ), true);
  assert.equal(bindings.bindings[0]?.toolEvidence.some((item) =>
    item.artifacts?.some((artifact) => artifact.path === "data_inspection_report.md") === true
  ), true);
  assert.match(payload.toolSelectionPolicy.beforeAcquiringEvidence, /Reuse existing satisfied receipts/);
  const frame = payload.stepSemanticFrame as {
    readonly schema: string;
    readonly phaseRole: string;
    readonly operation: string;
    readonly evidenceMode: string;
    readonly firstAction: string;
    readonly evidenceSources: readonly Array<{ readonly kind: string; readonly reusePolicy?: string }>;
    readonly completionBoundary: readonly string[];
  };
  assert.equal(frame.schema, "agentloop.stepSemanticFrame/v1");
  assert.equal(frame.phaseRole, "artifact_production");
  assert.equal(frame.operation, "artifact_build");
  assert.equal(frame.evidenceMode, "reuse_dependency_evidence");
  assert.equal(frame.firstAction, "reuse_prior_summary");
  assert.equal(frame.evidenceSources.some((source) =>
    source.kind === "dependency_step" && source.reusePolicy === "must_reuse_first"
  ), true);
  assert.equal(frame.completionBoundary.includes("artifact_acceptance"), true);
});

test("execution context prefers structured JSON reads for table extraction artifacts", () => {
  const extractStep: PlanStep = {
    id: "extract_data",
    kind: "leaf",
    position: 0,
    objective: "Extract visible spreadsheet tables into durable generic evidence.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    recommendedToolNames: ["visible_index_directory", "visible_extract_tables"],
    evidenceContract: {
      requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "completed",
    output: "Structured extraction artifact: .agentloop/table-extractions/aa/artifact.json",
    evidence: {
      candidateOutput: JSON.stringify({
        schema: "agentloop.sourceSummaryCandidate/v1",
        facts: [{ claim: "20 spreadsheet files extracted.", sourceRefs: ["extract-tables"] }],
      }),
      modelSteps: 2,
      toolCalls: [{
        toolCallId: "extract-tables",
        toolName: "visible_extract_tables",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.visibleTableExtraction/v1",
          totalRows: 673,
          totalRecords: 633,
          totalCells: 4012,
          artifact: {
            schema: "agentloop.tableExtractionArtifact/v1",
            path: ".agentloop/table-extractions/aa/artifact.json",
            bytes: 1447549,
            sha256: "a".repeat(64),
            manifest: {
              schema: "agentloop.tableExtractionArtifactManifest/v1",
              artifactSchema: "agentloop.visibleTableExtraction/v1",
              totalFiles: 20,
              totalTables: 20,
              totalRows: 673,
              totalRecords: 633,
              totalCells: 4012,
              tables: [{
                tableId: "file:0:sheet:0",
                filePath: "scores.xlsx",
                fileIndex: 0,
                sheetName: "Scores",
                sheetIndex: 0,
                sheetPointer: "/files/0/sheets/0",
                rowsPointer: "/files/0/sheets/0/rows",
                recordsPointer: "/files/0/sheets/0/records",
                columnsPointer: "/files/0/sheets/0/columns",
                sourceRange: "A1:B3",
                headerRange: "A1:B1",
                rowCount: 3,
                recordCount: 2,
                cellCount: 6,
                recordRows: { first: 2, last: 3 },
                fields: [{ name: "Name", address: "A", index: 1, nonEmptyCellCount: 3, valueKinds: { text: 3 } }],
                sampleRecords: [{ row: 2, sourceRange: "A2:B2", values: { Name: "Alice", Score: 91 } }],
                sourceRanges: ["A1:B3", "A1:B1", "A2:B2"],
                truncated: false,
              }],
            },
          },
          evidenceReceipt: {
            schema: "agentloop.toolEvidenceReceipt/v1",
            evidenceKinds: {
              satisfied: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
              caveated: [],
              failed: [],
            },
          },
        }),
      }],
    },
  };
  const produceStep: PlanStep = {
    id: "deliver_analysis",
    kind: "leaf",
    position: 1,
    objective: "Produce a conversation answer from the extracted table data.",
    dependencies: ["extract_data"],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    recommendedToolNames: [],
    evidenceContract: {
      requiredKinds: ["delivery_receipt", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "running",
  };
  const payload = executionContextPayload(buildStepRuntimeContextSnapshot({
    step: produceStep,
    plan: {
      id: "plan-1",
      runId: "run-1",
      version: 1,
      goal: "Analyze spreadsheet performance data",
      selectedSkillIds: [],
      status: "running",
      steps: [extractStep, produceStep],
      createdAt: 1,
      updatedAt: 1,
    },
    skills: [],
    workspaceRoot: "/workspace",
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", sourceNeed: "source_grounded" }),
    operationProfile: { id: "data_analysis" },
    requiresFileOutput: false,
  }).content);

  assert.match(payload.structuredArtifactConsumptionDiscipline, /manifest table entries/);
  assert.match(payload.structuredArtifactConsumptionDiscipline, /computer_read_json/);
  assert.match(payload.structuredArtifactConsumptionDiscipline, /Use computer_search_text only/);
  const bindings = payload.dependencyEvidenceBindings as {
    readonly bindings: readonly Array<{
      readonly toolEvidence: readonly Array<{
        readonly artifacts?: readonly Array<{
          readonly path: string;
          readonly schema?: string;
          readonly manifest?: { readonly tables: readonly Array<{ readonly recordsPointer: string }> };
        }>;
      }>;
    }>;
  };
  assert.equal(bindings.bindings[0]?.toolEvidence[0]?.artifacts?.[0]?.schema, "agentloop.tableExtractionArtifact/v1");
  assert.equal(bindings.bindings[0]?.toolEvidence[0]?.artifacts?.[0]?.manifest?.tables[0]?.recordsPointer, "/files/0/sheets/0/records");
});

test("step semantic frame classifies visible directory analysis as source acquisition", () => {
  const step: PlanStep = {
    id: "profile_xlsx_data",
    kind: "leaf",
    position: 0,
    objective: "Inspect the visible directory XLSX data and produce reusable source summary evidence.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    recommendedToolNames: ["visible_find_files", "visible_read_files", "computer_run_command"],
    evidenceContract: {
      requiredKinds: ["source_summary", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "running",
  };
  const payload = executionContextPayload(buildStepRuntimeContextSnapshot({
    step,
    plan: {
      id: "plan-1",
      runId: "run-1",
      version: 1,
      goal: "Analyze visible XLSX data",
      selectedSkillIds: [],
      status: "running",
      steps: [step],
      createdAt: 1,
      updatedAt: 1,
    },
    skills: [],
    workspaceRoot: "/workspace",
    visibleDirectories: [{ id: "visible_dir_1", name: "user data", path: "/external/data" }],
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", sourceNeed: "source_grounded" }),
    operationProfile: { id: "data_analysis" },
    requiresFileOutput: false,
  }).content);
  const frame = payload.stepSemanticFrame as {
    readonly phaseRole: string;
    readonly operation: string;
    readonly evidenceMode: string;
    readonly firstAction: string;
    readonly evidenceSources: readonly Array<{
      readonly kind: string;
      readonly required: boolean;
      readonly refs?: readonly string[];
      readonly reusePolicy?: string;
    }>;
    readonly forbiddenMoves: readonly string[];
  };

  assert.equal(frame.phaseRole, "evidence_acquisition");
  assert.equal(frame.operation, "data_analysis");
  assert.equal(frame.evidenceMode, "acquire_new_evidence");
  assert.equal(frame.firstAction, "inspect_available_sources");
  assert.equal(frame.evidenceSources.some((source) =>
    source.kind === "visible_directory"
    && source.required
    && source.refs?.includes("visible_dir_1") === true
    && source.reusePolicy === "fresh_required"
  ), true);
  assert.equal(frame.forbiddenMoves.some((move) => /do not answer from assumptions/.test(move)), true);
});

test("dependency evidence binding keeps missing source summary explicit", () => {
  const inspectStep: PlanStep = {
    id: "inspect_data",
    kind: "leaf",
    position: 0,
    objective: "Inspect files.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    recommendedToolNames: ["computer_write_file"],
    evidenceContract: {
      requiredKinds: ["source_summary", "artifact_path", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "completed",
    output: "Prose says the data was inspected.",
    evidence: {
      candidateOutput: "Prose says the data was inspected.",
      modelSteps: 1,
      toolCalls: [{
        toolCallId: "write-report",
        toolName: "computer_write_file",
        isError: false,
        result: JSON.stringify({
          path: "data_inspection_report.md",
          artifactReceipt: {
            schema: "agentloop.artifactReceipt/v1",
            artifact: { path: "data_inspection_report.md", bytes: 100 },
            evidenceKinds: { satisfied: ["artifact_path"], caveated: [], failed: [] },
          },
        }),
      }],
      completionCaveat: {
        reason: "repair_limit",
        feedback: "Missing source summary receipt.",
      },
    },
  };
  const nextStep: PlanStep = {
    id: "build",
    kind: "leaf",
    position: 1,
    objective: "Build from prior evidence.",
    dependencies: ["inspect_data"],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    recommendedToolNames: ["computer_write_file"],
    evidenceContract: { requiredKinds: ["artifact_path"], caveatPolicy: "none" },
    successCriteria: [],
    status: "running",
  };
  const payload = executionContextPayload(buildStepRuntimeContextSnapshot({
    step: nextStep,
    plan: {
      id: "plan-1",
      runId: "run-1",
      version: 1,
      goal: "Continue",
      selectedSkillIds: [],
      status: "running",
      steps: [inspectStep, nextStep],
      createdAt: 1,
      updatedAt: 1,
    },
    skills: [],
    workspaceRoot: "/workspace",
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute" }),
    operationProfile: { id: "produce" },
    requiresFileOutput: true,
  }).content);
  const binding = (payload.dependencyEvidenceBindings as {
    readonly bindings: readonly [{
      readonly missingRequiredEvidenceKinds: readonly string[];
      readonly completionCaveat?: { readonly reason: string };
    }];
  }).bindings[0];

  assert.equal(binding?.missingRequiredEvidenceKinds.includes("source_summary"), true);
  assert.equal(binding?.completionCaveat?.reason, "repair_limit");
});

test("execution context exposes prior conversation artifacts as reusable context", () => {
  const step: PlanStep = {
    id: "continue",
    kind: "leaf",
    position: 0,
    objective: "Continue from prior evidence.",
    dependencies: [],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    recommendedToolNames: ["computer_write_file"],
    evidenceContract: { requiredKinds: ["artifact_path"], caveatPolicy: "none" },
    successCriteria: [],
    status: "running",
  };
  const workset: ConversationWorkingSet = {
    schema: "conversation.workset/v1",
    conversationId: "conversation-1",
    runCount: 2,
    planCursors: [],
    reusableArtifacts: [{
      runId: "prior-run",
      path: "summary_data.json",
      name: "summary_data.json",
      bytes: 1024,
      mimeType: "application/json",
      sourceTool: "computer_run_command",
      sourcePlanStepId: "inspect_data",
      reusable: true,
    }],
    failedBoundaries: [],
    recommendedCapabilities: { skillIds: [], toolNames: ["computer_write_file"] },
    evidenceLedger: {
      schema: "conversation.evidenceLedger/v1",
      sourceSummaries: [{
        runId: "prior-run",
        planId: "prior-plan",
        stepId: "inspect_data",
        schema: "agentloop.sourceSummaryCandidate/v1",
        coveredTopics: ["研发组绩效"],
        facts: [{
          claim: "Prior inspection summarized 18 staff and 90 tasks.",
          sourceRefs: [{ sourceRefId: "summary_data.json" }],
          confidence: "source_supported",
        }],
        missingOrUnverified: [],
      }],
    },
  };

  const payload = executionContextPayload(buildStepRuntimeContextSnapshot({
    step,
    plan: {
      id: "plan-1",
      runId: "run-1",
      version: 1,
      goal: "Continue",
      selectedSkillIds: [],
      status: "running",
      steps: [step],
      createdAt: 1,
      updatedAt: 1,
    },
    skills: [],
    workspaceRoot: "/workspace",
    taskProfile: buildTaskProfile({ phase: "execution", intent: "continue" }),
    operationProfile: { id: "produce" },
    requiresFileOutput: true,
    conversationWorkingSet: workset,
  }).content);
  const reuseContext = payload.conversationReuseContext as {
    readonly schema: string;
    readonly reusableArtifacts: readonly Array<{ readonly path: string }>;
    readonly sourceSummaries: readonly Array<{ readonly facts: readonly Array<{ readonly claim: string }> }>;
  };

  assert.equal(reuseContext.schema, "agentloop.conversationReuseContext/v1");
  assert.equal(reuseContext.reusableArtifacts[0]?.path, "summary_data.json");
  assert.equal(reuseContext.sourceSummaries[0]?.facts[0]?.claim.includes("18 staff"), true);
});

function executionContextPayload(content: string): Record<string, unknown> {
  const match = content.match(/<execution_context source="server">\n(.*?)\n<\/execution_context>/s);
  assert.ok(match?.[1]);
  return JSON.parse(match[1]) as Record<string, unknown>;
}
