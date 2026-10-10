import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationWorkingSet, ExecutionPlan, PlanStep } from "../src/planning/contracts.ts";
import { createStepExecutionBinding } from "../src/planning/step-execution-binding.ts";
import { buildTaskProfile } from "../src/runtime/dynamic-prompt.ts";
import { buildStepRuntimeContextSnapshot, buildStepToolProgressPolicy } from "../src/runtime/execution-context-policy.ts";
import { deriveRuntimeStepEvidenceState } from "../src/runtime/tool-progress-policy.ts";

test("fact-acquisition progress policy keeps observable source evidence obligations", () => {
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
  assert.deepEqual(policy?.requiredEvidenceKinds, ["source_summary", "record_counts", "structured_extraction_artifact", "delivery_receipt"]);
  assert.equal(policy?.maxExploratoryPrimarySteps, 8);
  assert.equal(policy?.exploratoryToolNames.includes("read_source"), true);
  assert.equal(policy?.evidenceProducingToolNames.includes("computer_write_file"), true);
  assert.match(policy?.repairDirective ?? "", /source-evidence step/);
});

test("fact-acquisition policy directs an admitted Runtime evidence materializer after source facts exist", () => {
  const step = planStep({
    id: "materialize-source-evidence",
    kind: "leaf",
    position: 0,
    objective: "Preserve extracted source facts as a Runtime-owned evidence bundle.",
    dependencies: [],
    role: "fact_acquisition",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["visible_directory_read", "runtime_result_json_materialization"],
    evidenceContract: {
      requiredKinds: ["source_summary", "schema_summary", "structured_extraction_artifact", "explicit_caveats"],
      caveatPolicy: "mark_unverified_facts",
    },
    successCriteria: [],
    status: "pending",
  });
  const policy = buildStepToolProgressPolicy({ step, requiresFileOutput: false });

  const state = deriveRuntimeStepEvidenceState({
    policy,
    evidence: [{
      toolCallId: "inspect-source",
      toolName: "visible_extract_tables",
      isError: false,
      result: JSON.stringify({
        schema: "agentloop.sourceSummary/v1",
        evidenceKinds: {
          satisfied: ["source_summary", "schema_summary"],
          caveated: [],
          failed: [],
        },
      }),
    }],
  });

  assert.equal(state?.nextAction, "materialize_runtime_result_evidence");
  assert.deepEqual(state?.evidenceProducingToolNames, ["materialize_result_json"]);
  assert.match(state?.instruction ?? "", /Do not recreate or aggregate/);
});

test("artifact progress policy retains the admitted concrete format beside its semantic kind", () => {
  const step = planStep({
    id: "merge-pdfs",
    kind: "leaf",
    position: 0,
    objective: "Merge the uploaded PDFs.",
    dependencies: [],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
    evidenceContract: {
      requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "artifact_acceptance"],
      caveatPolicy: "none",
    },
    successCriteria: [],
    status: "pending",
  });

  const policy = buildStepToolProgressPolicy({
    step,
    requiresFileOutput: true,
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", artifactKind: "document" }),
    expectedArtifactFormat: "pdf",
  });

  assert.equal(policy?.expectedArtifactKind, "document");
  assert.equal(policy?.expectedArtifactFormat, "pdf");
});

test("step-local artifact targets override a task-wide legacy format and require coverage for every target", () => {
  const step = planStep({
    id: "ods-report-qc",
    kind: "leaf",
    position: 0,
    objective: "Verify the Markdown QC report and the workbook delivery.",
    dependencies: [],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
    artifactTargets: [
      { id: "qc-report", kind: "document", format: "markdown", terminalRequired: true },
      { id: "ods-workbook", kind: "spreadsheet", format: "xlsx", terminalRequired: true },
    ],
    evidenceContract: {
      requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
      caveatPolicy: "none",
    },
    successCriteria: [],
    status: "pending",
  });
  const policy = buildStepToolProgressPolicy({
    step,
    requiresFileOutput: true,
    // This is the same stale single-value projection that affected Run 41ef8e7b.
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", artifactKind: "spreadsheet" }),
    expectedArtifactFormat: "xlsx",
    artifactTargets: step.executionBinding.artifactTargets,
  });

  assert.deepEqual(policy?.artifactTargets?.map((target) => target.format), ["markdown", "xlsx"]);
  const xlsxOnly = deriveRuntimeStepEvidenceState({
    policy,
    evidence: [artifactEvidence("write-xlsx", "ods_delivery.xlsx", "spreadsheet", 128), acceptanceEvidence("verify-xlsx", "ods_delivery.xlsx", "spreadsheet")],
  });
  assert.equal(xlsxOnly?.missingRequiredEvidenceKinds.includes("artifact_path"), true);
  assert.equal(xlsxOnly?.missingRequiredEvidenceKinds.includes("artifact_acceptance"), true);

  const complete = deriveRuntimeStepEvidenceState({
    policy,
    evidence: [
      artifactEvidence("write-qc", "ods_report_qc.md", "document", 64),
      acceptanceEvidence("verify-qc", "ods_report_qc.md", "document"),
      artifactEvidence("write-xlsx", "ods_delivery.xlsx", "spreadsheet", 128),
      acceptanceEvidence("verify-xlsx", "ods_delivery.xlsx", "spreadsheet"),
    ],
  });
  assert.deepEqual(complete?.missingRequiredEvidenceKinds, []);
});

test("two same-format targets need two distinct artifact paths", () => {
  const step = planStep({
    id: "two-markdown-deliverables",
    kind: "leaf",
    position: 0,
    objective: "Deliver the analysis and quality-control reports.",
    dependencies: [],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
    artifactTargets: [
      { id: "analysis-report", purpose: "ODS analysis report", kind: "document", format: "markdown", terminalRequired: true },
      { id: "quality-report", purpose: "Quality-control report", kind: "document", format: "markdown", terminalRequired: true },
    ],
    evidenceContract: {
      requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
      caveatPolicy: "none",
    },
    successCriteria: [],
    status: "pending",
  });
  const policy = buildStepToolProgressPolicy({
    step,
    requiresFileOutput: true,
    artifactTargets: step.executionBinding.artifactTargets,
  });
  const reusedOnePath = deriveRuntimeStepEvidenceState({
    policy,
    evidence: [
      artifactEvidence("write-one", "analysis.md", "document", 64),
      acceptanceEvidence("verify-one", "analysis.md", "document"),
    ],
  });
  assert.equal(reusedOnePath?.missingRequiredEvidenceKinds.includes("artifact_path"), true);
  const distinctPaths = deriveRuntimeStepEvidenceState({
    policy,
    evidence: [
      artifactEvidence("write-analysis", "analysis.md", "document", 64),
      acceptanceEvidence("verify-analysis", "analysis.md", "document"),
      artifactEvidence("write-qc", "quality.md", "document", 64),
      acceptanceEvidence("verify-qc", "quality.md", "document"),
    ],
  });
  assert.deepEqual(distinctPaths?.missingRequiredEvidenceKinds, []);
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
      publishedResult: {
        schema: "agentloop.runtimeResult/v1",
        ref: { schema: "agentloop.resultRef/v1", resultId: "rr_inspect_data" },
        kind: "step",
        producer: { runId: "run-1", planId: "plan-1", stepId: "inspect_data" },
        inputs: [],
        publication: { status: "published", decision: "approved" },
        payload: {
          content: "Inspection found 18 staff and 90 tasks.",
          contentFormat: "text",
          characters: 37,
          bytes: 37,
          sha256: "a".repeat(64),
        },
        createdAt: 1,
      },
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
  const bindings = payload.stepDependencyContexts as {
    readonly schema: string;
    readonly dependencies: readonly [{
      readonly stepId: string;
      readonly resultBinding?: { readonly result: { readonly resultId: string } };
      readonly satisfiedEvidenceKinds: readonly string[];
      readonly missingRequiredEvidenceKinds: readonly string[];
      readonly evidenceMetadata: readonly Array<{
        readonly toolName: string;
        readonly resultSchemas: readonly string[];
        readonly artifacts?: readonly Array<{ readonly path: string }>;
      }>;
    }];
  };

  assert.equal(bindings.schema, "agentloop.stepDependencyContexts/v1");
  assert.equal(bindings.dependencies[0]?.stepId, "inspect_data");
  assert.equal(bindings.dependencies[0]?.resultBinding?.result.resultId, "rr_inspect_data");
  assert.equal("output" in (bindings.dependencies[0] as object), false);
  assert.equal(bindings.dependencies[0]?.satisfiedEvidenceKinds.includes("source_summary"), true);
  assert.equal(bindings.dependencies[0]?.satisfiedEvidenceKinds.includes("artifact_path"), true);
  assert.equal(bindings.dependencies[0]?.missingRequiredEvidenceKinds.includes("source_summary"), false);
  assert.equal(bindings.dependencies[0]?.evidenceMetadata.some((item) =>
    item.toolName === "visible_index_directory"
    && item.resultSchemas.includes("agentloop.sourceSummary/v1")
  ), true);
  assert.equal(bindings.dependencies[0]?.evidenceMetadata.some((item) =>
    item.toolName === "computer_run_command"
  ), true);
  assert.equal(bindings.dependencies[0]?.evidenceMetadata.some((item) =>
    item.artifacts?.some((artifact) => artifact.path === "data_inspection_report.md") === true
  ), true);
  assert.equal("preview" in (bindings.dependencies[0]?.evidenceMetadata[0] ?? {}), false);
  assert.equal("sourceRefs" in (bindings.dependencies[0]?.evidenceMetadata[0] ?? {}), false);
  assert.match(payload.toolSelectionPolicy.beforeAcquiringEvidence, /Reuse existing satisfied receipts/);
  const frame = payload.stepSemanticFrame as {
    readonly schema: string;
    readonly phaseRole: string;
    readonly operation: string;
    readonly evidenceMode: string;
    readonly firstAction: string;
    readonly evidenceSources: readonly Array<{ readonly kind: string; readonly reusePolicy?: string }>;
    readonly completionBoundary: readonly string[];
    readonly outcomePolicy: {
      readonly primaryResult: string;
      readonly earlyDownstreamArtifactPolicy: string;
      readonly currentStepInstruction: string;
    };
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
  assert.equal(frame.outcomePolicy.primaryResult, "artifact");
  assert.equal(frame.outcomePolicy.earlyDownstreamArtifactPolicy, "current_step_owned");
  const dependencyContexts = payload.stepDependencyContexts as {
    readonly earlyArtifactCandidates?: {
      readonly instruction: string;
      readonly artifacts: readonly Array<{
        readonly sourceStepId: string;
        readonly resultBinding?: { readonly result: { readonly resultId: string } };
        readonly artifact: { readonly path: string };
      }>;
    };
  };
  assert.equal(dependencyContexts.earlyArtifactCandidates?.artifacts.some((candidate) =>
    candidate.sourceStepId === "inspect_data"
    && candidate.resultBinding?.result.resultId === "rr_inspect_data"
    && candidate.artifact.path === "data_inspection_report.md"
  ), true);
  assert.match(dependencyContexts.earlyArtifactCandidates?.instruction ?? "", /Before recreating or overwriting/i);
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
      readonly resultPublicationPolicy: string;
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

test("execution context dynamically requires Markdown materialization for bound Outcome conversions", () => {
  const conversionStep = planStep({
    id: "convert-prior-result",
    kind: "leaf",
    position: 0,
    objective: "Convert the prior Markdown analysis to a PDF workspace artifact.",
    dependencies: [],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
    evidenceContract: {
      requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
      caveatPolicy: "none",
    },
    successCriteria: [],
    status: "pending",
  });
  const plan: ExecutionPlan = {
    id: "plan-bound-result-conversion",
    runId: "run-bound-result-conversion",
    version: 1,
    goal: "Export prior analysis as PDF.",
    selectedSkillIds: [],
    resultBindings: [{
      schema: "agentloop.resultBinding/v1",
      relation: "continue_prior",
      result: {
        schema: "agentloop.resultRef/v1",
        resultId: "rr_00000000-0000-4000-8000-000000000010",
      },
    }],
    status: "running",
    steps: [conversionStep],
    createdAt: 1,
    updatedAt: 1,
  };
  const snapshot = buildStepRuntimeContextSnapshot({
    step: conversionStep,
    plan,
    skills: [],
    workspaceRoot: "/workspace",
    taskProfile: buildTaskProfile({
      phase: "execution",
      intent: "execute",
      artifactKind: "document",
      deliverySurface: "workspace_artifact",
      skillBound: false,
    }),
    operationProfile: { id: "artifact_build" },
    requiresFileOutput: true,
  });
  const payload = executionContextPayload(snapshot.content);
  const directive = payload.boundOutcomeConversion as {
    readonly schema: string;
    readonly source: string;
    readonly sourceMaterializationFormat: string;
    readonly requiredWorkflow: readonly string[];
    readonly instruction: string;
  };

  assert.equal(directive.schema, "agentloop.boundOutcomeConversion/v1");
  assert.equal(directive.source, "runtime_result");
  assert.equal(directive.sourceMaterializationFormat, "markdown");
  assert.deepEqual(directive.requiredWorkflow, ["computer_write_file", "convert_artifact", "verify_artifact_acceptance"]);
  assert.match(directive.instruction, /Do not bypass this conversion boundary/);
});

test("execution context does not impose a create-then-append protocol on authored files", () => {
  const step = planStep({
    id: "write-deck-spec",
    kind: "leaf",
    position: 0,
    objective: "Write the authored deck specification as a workspace file.",
    dependencies: [],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write"],
    evidenceContract: { requiredKinds: ["artifact_path"], caveatPolicy: "none" },
    successCriteria: [],
    status: "pending",
  });
  const payload = executionContextPayload(buildStepRuntimeContextSnapshot({
    step,
    plan: {
      id: "plan-large-write",
      runId: "run-large-write",
      version: 1,
      goal: "Write a large authored file",
      selectedSkillIds: [],
      status: "running",
      steps: [step],
      createdAt: 1,
      updatedAt: 1,
    },
    skills: [],
    workspaceRoot: "/workspace",
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", artifactKind: "document" }),
    operationProfile: { id: "artifact_build" },
    requiresFileOutput: true,
  }).content);

  assert.equal(payload.largeWriteDiscipline, undefined);
});

test("execution context omits bound Outcome conversion rules outside the conversion contract", () => {
  const directPdfStep = planStep({
    id: "generate-pdf",
    kind: "leaf",
    position: 0,
    objective: "Generate a PDF from current source data.",
    dependencies: [],
    role: "produce",
    refinementState: "not_refinable",
    requiredFacts: [],
    skillIds: [],
    requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
    evidenceContract: {
      requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
      caveatPolicy: "none",
    },
    successCriteria: [],
    status: "pending",
  });
  const plan: ExecutionPlan = {
    id: "plan-direct-pdf",
    runId: "run-direct-pdf",
    version: 1,
    goal: "Generate a PDF.",
    selectedSkillIds: [],
    status: "running",
    steps: [directPdfStep],
    createdAt: 1,
    updatedAt: 1,
  };
  const payload = executionContextPayload(buildStepRuntimeContextSnapshot({
    step: directPdfStep,
    plan,
    skills: [],
    workspaceRoot: "/workspace",
    taskProfile: buildTaskProfile({
      phase: "execution",
      intent: "execute",
      artifactKind: "document",
      deliverySurface: "workspace_artifact",
      skillBound: false,
    }),
    operationProfile: { id: "artifact_build" },
    requiresFileOutput: true,
  }).content);

  assert.equal(payload.boundOutcomeConversion, undefined);
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
      readonly resultPublicationPolicy: string;
      readonly currentStepBoundary: string;
      readonly nextStepBoundary: string;
      readonly earlyDownstreamArtifactPolicy: string;
      readonly forbiddenMoves: readonly string[];
    };
  };

  assert.equal(handoff.schema, "agentloop.stepHandoffFrame/v1");
  assert.equal(handoff.mode, "current_to_next");
  assert.equal(handoff.currentStepId, "extract_data");
  assert.match(handoff.instruction, /current step's primary result/);
  assert.equal(handoff.nextStage.kind, "direct_dependents");
  assert.equal(handoff.nextStage.steps[0]?.id, "write_report");
  assert.equal(handoff.nextStage.steps[0]?.dependsOnCurrent, true);
  assert.equal(handoff.nextStage.steps[0]?.requiredInputsFromCurrent.includes("source_summary"), true);
  assert.equal(handoff.nextStage.steps[0]?.requiredInputsFromCurrent.includes("structured_extraction_artifact"), true);
  assert.equal(handoff.handoffContract.reusableEvidenceKinds.includes("record_counts"), true);
  assert.match(handoff.handoffContract.currentStepBoundary, /phaseRole=evidence_acquisition/);
  assert.match(handoff.handoffContract.nextStepBoundary, /context for semantic continuity only/);
  assert.match(handoff.handoffContract.earlyDownstreamArtifactPolicy, /candidate work product/);
  assert.equal(handoff.handoffContract.forbiddenMoves.some((item) =>
    item.includes("downstream-looking artifact")
  ), true);
  const acquisitionFrame = payload.stepSemanticFrame as {
    readonly outcomePolicy: {
      readonly primaryResult: string;
      readonly earlyDownstreamArtifactPolicy: string;
      readonly currentStepInstruction: string;
    };
  };
  assert.equal(acquisitionFrame.outcomePolicy.primaryResult, "source_evidence");
  assert.equal(acquisitionFrame.outcomePolicy.earlyDownstreamArtifactPolicy, "preserve_as_candidate");
  assert.match(acquisitionFrame.outcomePolicy.currentStepInstruction, /global final deliverable/i);
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
  assert.match(payload.toolSelectionPolicy.beforeAcquiringEvidence, /current-stage evidence for this stage/i);
  assert.match(payload.stageEvidencePrecedence, /dependency evidence is input, not a veto/i);
  assert.match(payload.stageEvidencePrecedence, /do not re-fetch or revalidate solely to reconcile/i);
  assert.match((payload.stepDependencyContexts as { readonly instruction: string }).instruction, /current step resolves a conflict/i);
  const bindings = payload.stepDependencyContexts as {
    readonly dependencies: readonly Array<{
      readonly evidenceMetadata: readonly Array<{
        readonly artifacts?: readonly Array<{
          readonly path: string;
          readonly schema?: string;
        }>;
      }>;
    }>;
  };
  assert.equal(bindings.dependencies[0]?.evidenceMetadata[0]?.artifacts?.[0]?.schema, "agentloop.tableExtractionArtifact/v1");
  assert.equal("manifest" in (bindings.dependencies[0]?.evidenceMetadata[0]?.artifacts?.[0] ?? {}), false);
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
  assert.match(
    (payload.toolSelectionPolicy as { readonly marginalBenefitDecision: string }).marginalBenefitDecision,
    /material expected benefit/i,
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
  const binding = (payload.stepDependencyContexts as {
    readonly dependencies: readonly [{
      readonly missingRequiredEvidenceKinds: readonly string[];
      readonly completionCaveat?: { readonly reason: string };
    }];
  }).dependencies[0];

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
        "materialize_result_json",
        "computer_write_file",
        "computer_patch_file",
        "computer_run_command",
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

function artifactEvidence(toolCallId: string, path: string, artifactKind: string, bytes: number) {
  return {
    toolCallId,
    toolName: "computer_write_file",
    isError: false,
    result: JSON.stringify({
      schema: "agentloop.artifactReceipt/v1",
      artifact: { path, kind: artifactKind, bytes, sha256: `${toolCallId}-digest` },
      evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "format_matches_request"], caveated: [], failed: [] },
    }),
  };
}

function acceptanceEvidence(toolCallId: string, artifactPath: string, artifactKind: string) {
  return {
    toolCallId,
    toolName: "verify_artifact_acceptance",
    isError: false,
    result: JSON.stringify({
      schema: "agentloop.artifactAcceptance/v1",
      artifactPath,
      artifactKind,
      verdict: "accepted",
      evidenceKinds: { satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"], caveated: [], failed: [] },
    }),
  };
}
