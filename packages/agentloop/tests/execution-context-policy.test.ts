import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationWorkingSet, ExecutionPlan, PlanStep } from "../src/planning/contracts.ts";
import { createStepExecutionBinding } from "../src/planning/step-execution-binding.ts";
import { buildTaskProfile } from "../src/runtime/dynamic-prompt.ts";
import { buildStepRuntimeContextSnapshot, buildStepToolProgressPolicy } from "../src/runtime/execution-context-policy.ts";

test("source semantics stay out of the global Runtime progress policy", () => {
  const step = planStep({
    id: "extract-source",
    kind: "leaf",
    position: 0,
    objective: "Extract reusable source facts before producing the report.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["skill_instruction_load", "uploaded_source_read"],
    evidenceContract: {
      requiredKinds: ["source_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats", "delivery_receipt"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "pending",
  });

  const policy = buildStepToolProgressPolicy({
    step,
    requiresFileOutput: false,
  });

  assert.notEqual(policy, undefined);
  assert.deepEqual(policy?.requiredEvidenceKinds, ["delivery_receipt"]);
  assert.equal(policy?.maxExploratoryPrimarySteps, 8);
  assert.equal(policy?.exploratoryToolNames.includes("read_source"), true);
  assert.equal(policy?.evidenceProducingToolNames.includes("computer_write_file"), true);
  assert.match(policy?.repairDirective ?? "", /source-evidence step/);
});

test("execution context binds dependency evidence before downstream reacquisition", () => {
  const inspectStep = planStep({
    id: "inspect_data",
    kind: "leaf",
    position: 0,
    objective: "Inspect the visible directory data and produce reusable analysis evidence.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["visible_directory_read", "workspace_artifact_write"],
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
  });
  const buildStep = planStep({
    id: "build_analysis_xlsx",
    kind: "leaf",
    position: 1,
    objective: "Build the final analysis workbook from the inspected data.",
    dependencies: ["inspect_data"],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "artifact_acceptance"],
    evidenceContract: {
      requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "artifact_openable", "format_matches_request", "delivery_receipt", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "running",
  });
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
  const handoff = payload.planStepHandoffFrame as {
    readonly schema: string;
    readonly mode: string;
    readonly currentStepId: string;
    readonly nextStage?: {
      readonly kind: string;
      readonly steps: readonly Array<{
        readonly id: string;
        readonly dependsOnCurrent: boolean;
        readonly requiredInputsFromCurrent: readonly string[];
      }>;
    };
    readonly handoffContract: {
      readonly reusableEvidenceKinds: readonly string[];
      readonly reusableOutputPolicy: string;
      readonly nextStepBoundary?: string;
      readonly forbiddenMoves: readonly string[];
    };
  };
  assert.equal(handoff.schema, "agentloop.stepHandoffFrame/v1");
  assert.equal(handoff.mode, "terminal_current_only");
  assert.equal(handoff.currentStepId, "build_analysis_xlsx");
  assert.equal(handoff.nextStage, undefined);
  assert.equal(handoff.handoffContract.nextStepBoundary, undefined);
  assert.equal(handoff.handoffContract.reusableEvidenceKinds.includes("artifact_acceptance"), true);
});

test("execution context carries current-to-next handoff for non-terminal steps", () => {
  const extractStep = planStep({
    id: "extract_data",
    kind: "leaf",
    position: 0,
    objective: "Extract spreadsheet rows into a durable source summary.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["visible_directory_read"],
    evidenceContract: {
      requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "running",
  });
  const writeStep = planStep({
    id: "write_report",
    kind: "leaf",
    position: 1,
    objective: "Write the final report from the extracted summary.",
    dependencies: ["extract_data"],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
    evidenceContract: {
      requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request", "delivery_receipt", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "pending",
  });
  const payload = executionContextPayload(buildStepRuntimeContextSnapshot({
    step: extractStep,
    plan: {
      id: "plan-1",
      runId: "run-1",
      version: 1,
      goal: "Extract then report",
      selectedSkillIds: [],
      status: "running",
      steps: [extractStep, writeStep],
      createdAt: 1,
      updatedAt: 1,
    },
    skills: [],
    workspaceRoot: "/workspace",
    visibleDirectories: [{ id: "vis-1", name: "input", path: "/data" }],
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", sourceNeed: "source_grounded" }),
    operationProfile: { id: "data_analysis" },
    requiresFileOutput: false,
  }).content);
  const handoff = payload.planStepHandoffFrame as {
    readonly schema: string;
    readonly mode: string;
    readonly currentStepId: string;
    readonly instruction: string;
    readonly nextStage: {
      readonly kind: string;
      readonly steps: readonly Array<{
        readonly id: string;
        readonly objective: string;
        readonly dependsOnCurrent: boolean;
        readonly requiredInputsFromCurrent: readonly string[];
      }>;
    };
    readonly handoffContract: {
      readonly reusableEvidenceKinds: readonly string[];
      readonly reusableOutputPolicy: string;
      readonly currentStepBoundary: string;
      readonly nextStepBoundary: string;
      readonly forbiddenMoves: readonly string[];
    };
  };

  assert.equal(handoff.schema, "agentloop.stepHandoffFrame/v1");
  assert.equal(handoff.mode, "current_to_next");
  assert.equal(handoff.currentStepId, "extract_data");
  assert.match(handoff.instruction, /Do not execute the next stage/);
  assert.equal(handoff.nextStage.kind, "direct_dependents");
  assert.equal(handoff.nextStage.steps[0]?.id, "write_report");
  assert.equal(handoff.nextStage.steps[0]?.dependsOnCurrent, true);
  assert.equal(handoff.nextStage.steps[0]?.requiredInputsFromCurrent.includes("source_summary"), true);
  assert.equal(handoff.nextStage.steps[0]?.requiredInputsFromCurrent.includes("structured_extraction_artifact"), true);
  assert.equal(handoff.handoffContract.reusableEvidenceKinds.includes("record_counts"), true);
  assert.match(handoff.handoffContract.currentStepBoundary, /phaseRole=evidence_acquisition/);
  assert.match(handoff.handoffContract.nextStepBoundary, /context for semantic continuity only/);
  assert.equal(handoff.handoffContract.forbiddenMoves.some((item) =>
    item.includes("downstream artifact")
  ), true);
});

test("execution context prefers structured JSON reads for table extraction artifacts", () => {
  const extractStep = planStep({
    id: "extract_data",
    kind: "leaf",
    position: 0,
    objective: "Extract visible spreadsheet tables into durable generic evidence.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["visible_directory_read"],
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
  });
  const produceStep = planStep({
    id: "deliver_analysis",
    kind: "leaf",
    position: 1,
    objective: "Produce a conversation answer from the extracted table data.",
    dependencies: ["extract_data"],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_file_read"],
    evidenceContract: {
      requiredKinds: ["derived_aggregation", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "running",
  });
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
  assert.match(payload.structuredArtifactConsumptionDiscipline, /computer_summarize_table_artifact/);
  assert.match(payload.structuredArtifactConsumptionDiscipline, /computer_read_json/);
  assert.match(payload.structuredArtifactConsumptionDiscipline, /Use computer_search_text only/);
  assert.match(payload.derivedAggregationDiscipline, /computer_aggregate_table_artifact/);
  assert.match(payload.derivedAggregationDiscipline, /caveat is not a substitute/i);
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
  const step = planStep({
    id: "profile_xlsx_data",
    kind: "leaf",
    position: 0,
    objective: "Inspect the visible directory XLSX data and produce reusable source summary evidence.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["visible_directory_read", "workspace_artifact_write"],
    evidenceContract: {
      requiredKinds: ["source_summary", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "running",
  });
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

test("execution context asks acquisition steps to batch independent reads in one turn", () => {
  const step = planStep({
    id: "lookup_route",
    kind: "leaf",
    position: 0,
    objective: "Query the route and distance between two places using the map MCP.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["external_api_call"],
    evidenceContract: {
      requiredKinds: ["source_summary", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "running",
  });

  const payload = executionContextPayload(buildStepRuntimeContextSnapshot({
    step,
    plan: {
      id: "plan-1",
      runId: "run-1",
      version: 1,
      goal: "Query a map route",
      selectedSkillIds: [],
      status: "running",
      steps: [step],
      createdAt: 1,
      updatedAt: 1,
    },
    skills: [],
    workspaceRoot: "/workspace",
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", sourceNeed: "source_grounded" }),
    operationProfile: { id: "web_research" },
    requiresFileOutput: false,
  }).content);

  assert.match(
    payload.evidenceAcquisitionDiscipline as string,
    /fetch them in the same turn/i,
  );
  assert.match(
    payload.evidenceAcquisitionDiscipline as string,
    /Do not wait for Assessment to ask for the next obvious fact/i,
  );
});

test("dependency evidence binding keeps missing source summary explicit", () => {
  const inspectStep = planStep({
    id: "inspect_data",
    kind: "leaf",
    position: 0,
    objective: "Inspect files.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write"],
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
  });
  const nextStep = planStep({
    id: "build",
    kind: "leaf",
    position: 1,
    objective: "Build from prior evidence.",
    dependencies: ["inspect_data"],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write"],
    evidenceContract: { requiredKinds: ["artifact_path"], caveatPolicy: "none" },
    successCriteria: [],
    status: "running",
  });
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
  const step = planStep({
    id: "continue",
    kind: "leaf",
    position: 0,
    objective: "Continue from prior evidence.",
    dependencies: [],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write"],
    evidenceContract: { requiredKinds: ["artifact_path"], caveatPolicy: "none" },
    successCriteria: [],
    status: "running",
  });
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
    recommendedCapabilities: { skillIds: [], capabilityIds: ["workspace_artifact_write"] },
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

function planStep(step: Omit<PlanStep, "executionBinding">): PlanStep {
  return {
    ...step,
    executionBinding: createStepExecutionBinding({
      step,
      availableToolNames: new Set([
        "read_source",
        "visible_index_directory",
        "visible_find_files",
        "visible_read_file",
        "visible_read_files",
        "visible_search_text",
        "visible_extract_tables",
        "computer_list_directory",
        "computer_find_files",
        "computer_search_text",
        "computer_read_file",
        "computer_read_json",
        "computer_summarize_table_artifact",
        "computer_write_file",
        "computer_patch_file",
        "computer_run_command",
        "materialize_paginated_html",
        "convert_artifact",
        "verify_artifact_acceptance",
        "load_skill",
        "mcp_route_query",
      ]),
      evidenceContract: step.evidenceContract,
    }),
  };
}

function executionContextPayload(content: string): Record<string, unknown> {
  const match = content.match(/<execution_context source="server">\n(.*?)\n<\/execution_context>/s);
  assert.ok(match?.[1]);
  return JSON.parse(match[1]) as Record<string, unknown>;
}
