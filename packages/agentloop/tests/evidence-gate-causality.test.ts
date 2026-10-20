import assert from "node:assert/strict";
import test from "node:test";
import { enforceAdmittedAssessment, ProfiledRuleStepAssessor } from "../src/planning/assessor.ts";
import type { EvidenceKind, StepAssessmentInput, StepEvidenceProducerBinding } from "../src/planning/contracts.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { admittedEvidenceKindsForCommittedResult, deriveRuntimeStepEvidenceState, runtimeStepToolProgressPolicy } from "../src/runtime/tool-progress-policy.ts";

const canonicalState = createCanonicalRunState({
  runId: "run",
  userInput: "analyze source data",
  understanding: understandTask({ objective: "analyze source data", toolNames: [] }),
  now: 1,
});

function producerBindings(
  toolName: string,
  kinds: readonly EvidenceKind[],
  capabilityId = `test:${toolName}`,
): StepEvidenceProducerBinding[] {
  return kinds.map((evidenceKind) => ({ evidenceKind, capabilityId, resolvedToolNames: [toolName] }));
}

test("a command-backed source requires the bound Skill's authenticated workflow receipt", () => {
  const policy = runtimeStepToolProgressPolicy(["source_summary"], {
    evidenceProducers: [{ evidenceKind: "source_summary", capabilityId: "skill_source_provider.api.records", skillId: "records",
      resolvedToolNames: ["computer_run_command"] }],
  });
  const kinds = { satisfied: ["source_summary"], caveated: [], failed: [] };
  for (const skillId of [undefined, "unrelated", "records"]) {
    const state = deriveRuntimeStepEvidenceState({ policy, evidence: [{ toolCallId: "query", toolName: "computer_run_command", isError: false,
      result: JSON.stringify({ exitCode: 0, evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", evidenceKinds: kinds },
        ...(skillId === undefined ? {} : { workflowEvidenceReceipt: { schema: "agentloop.skillWorkflowEvidenceReceipt/v1",
          skill: { skillId, skillName: skillId, executorId: "query", actionId: "read" }, evidenceKinds: kinds } }) }),
    }] });
    assert.equal(state?.satisfiedEvidenceKinds.includes("source_summary"), skillId === "records");
  }
});

function fixture(schema: boolean, caveats: boolean): StepAssessmentInput {
  const requiredKinds = ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"] as const;
  return {
    runId: "run", planId: "plan", attempt: 1, skills: [], canonicalState,
    runtimeEvidenceBundles: {
      schema: "agentloop.assessmentEvidenceBundles/v1",
      materializationAttempted: true,
      verified: [{
        toolCallId: "materialize",
        materializationResultRef: { schema: "agentloop.resultRef/v1", resultId: "rr_00000000-0000-4000-8000-000000000001" },
        sourceResultRefs: [{ schema: "agentloop.resultRef/v1", resultId: "rr_00000000-0000-4000-8000-000000000002" }],
        artifact: { path: "evidence/source.json", bytes: 128, sha256: "a".repeat(64) },
      }],
      rejected: [],
    },
    step: {
      id: "analysis", objective: "Analyze acquired source data", role: "deliver", dependencies: [], skillIds: [], requiredCapabilities: [],
      kind: "leaf", position: 0, status: "running", refinementState: "not_refinable", requiredFacts: [],
      executionBinding: { schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: ["computer_run_command"], evidenceProducers: producerBindings("computer_run_command", requiredKinds), sourceKinds: ["database"], sideEffect: "none", evidenceKinds: requiredKinds, targetIds: [] },
      evidenceContract: { requiredKinds, caveatPolicy: "mark_unverified_facts" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" })),
    },
    evidence: {
      candidateOutput: "已取得 46 条记录，16 个日期；同日多价格，数据覆盖有限。", modelSteps: 8,
      toolCalls: [{ toolCallId: "acquire", toolName: "computer_run_command", isError: false,
        admittedEvidenceKinds: ["source_summary", "record_counts", "structured_extraction_artifact", ...(schema ? ["schema_summary"] : []), ...(caveats ? ["explicit_caveats"] : [])],
        result: JSON.stringify({
        schema: "agentloop.steelMarketData/v1",
        evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1",
          evidenceKinds: { satisfied: ["source_summary", "record_counts", "structured_extraction_artifact", ...(schema ? ["schema_summary"] : [])], caveated: caveats ? ["explicit_caveats"] : [], failed: [] },
        },
      }) }],
    },
  };
}

test("missing source receipts do not reject a produced result", async () => {
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess(fixture(false, true));
  assert.equal(result.approved, true);
  assert.equal(result.failedBoundary, undefined);
  assert.equal(result.criteria.find((criterion) => criterion.criterionId === "explicit_caveats")?.satisfied, true);
  assert.equal(result.feedback, "");
});

test("missing source caveat receipts do not reject a produced result", async () => {
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess(fixture(true, false));
  assert.equal(result.approved, true);
  assert.equal(result.failedBoundary, undefined);
});

test("preserved preflight and caveat evidence removes the artificial failure", async () => {
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess(fixture(true, true));
  assert.equal(result.approved, true);
  assert.equal(result.feedback, "");
});

test("admitted target criteria cannot be approved without a matching delivery claim", () => {
  const targetState = createCanonicalRunState({
    runId: "run-target-claim",
    userInput: "Analyze the data distribution.",
    understanding: understandTask({
      objective: "Analyze the data distribution.",
      resolvedTaskIntent: {
        schema: "agentloop.conversationTaskIntent/v1",
        operation: "analysis",
        requiresExecution: true,
        deliverables: [{
          targetId: "data-distribution-analysis",
          purpose: "Deliver the data distribution analysis.",
          expectedArtifactCount: 1,
          action: "create",
          kind: "none",
          surface: "conversation",
        }],
      },
    }),
    now: 1,
  });
  const input: StepAssessmentInput = {
    runId: "run-target-claim",
    planId: "plan-target-claim",
    attempt: 1,
    skills: [],
    canonicalState: targetState,
    step: {
      id: "analyze",
      objective: "Analyze the data distribution.",
      role: "deliver",
      dependencies: [],
      skillIds: [],
      requiredCapabilities: [],
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1",
        requiredCapabilities: [],
        resolvedToolNames: [],
        evidenceProducers: [],
        sourceKinds: [],
        sideEffect: "none",
        evidenceKinds: [],
        targetIds: ["data-distribution-analysis"],
      },
      successCriteria: [{
        id: "delivery_target:data-distribution-analysis",
        targetId: "data-distribution-analysis",
        description: "Deliver the data distribution analysis.",
        source: "task",
        verification: "model_judged",
        blocking: true,
      }],
    },
    evidence: {
      candidateOutput: "The analysis is complete.",
      deliveryCandidate: {
        schema: "agentloop.runtimeDeliveryCandidate/v1",
        output: "The analysis is complete.",
        caveats: [],
        evidenceKinds: { satisfied: [], caveated: [], failed: [] },
        sourceToolCallIds: [],
        deliveryClaims: [],
      },
      toolCalls: [],
      modelSteps: 1,
    },
  };
  const enforced = enforceAdmittedAssessment(input, {
    id: "assessment-target-claim",
    planId: input.planId,
    stepId: input.step.id,
    attempt: 1,
    approved: true,
    criteria: [{
      criterionId: "delivery_target:data-distribution-analysis",
      satisfied: true,
      rationale: "Approved without a target claim.",
      evidenceRefs: ["candidateOutput"],
    }],
    skills: [],
    evidenceDigest: "digest",
    feedback: "",
    createdAt: 1,
  });

  assert.equal(enforced.approved, false);
  assert.equal(enforced.criteria[0]?.targetId, "data-distribution-analysis");
  assert.equal(enforced.criteria[0]?.satisfied, false);
  assert.equal(enforced.criteria[0]?.status, "unverified");
  assert.deepEqual(enforced.failedBoundary?.missingEvidenceKinds, []);
  assert.equal(enforced.failedBoundary?.unmetCriteria?.[0]?.criterionId, "delivery_target:data-distribution-analysis");
  assert.equal(enforced.failedBoundary?.unmetCriteria?.[0]?.targetId, "data-distribution-analysis");
});

test("Assessment consumes a committed source fact rather than rechecking the producing Tool name", async () => {
  const input = fixture(true, true);
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    ...input,
    workflowEvidenceActions: [],
  });
  assert.equal(result.approved, true);
});

test("a bound source workflow receipt remains execution provenance, not an Assessment gate", async () => {
  const input = fixture(true, true);
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    ...input,
    evidence: {
      ...input.evidence,
      toolCalls: input.evidence.toolCalls.map((toolCall) => ({
        ...toolCall,
        admittedEvidenceKinds: toolCall.admittedEvidenceKinds?.filter((kind) => kind !== "source_summary"),
      })),
    },
    workflowEvidenceActions: [{
      skillName: "data-platform-query",
      executorId: "query",
      actionId: "query",
      command: "python3",
      script: "scripts/data_platform_query.py",
      args: ["--request", "{{request}}"],
      producesEvidenceKinds: ["source_summary"],
    }],
  });
  assert.equal(result.approved, true);
  assert.equal(result.failedBoundary, undefined);
});

test("aggregation provenance cannot complete an artifact leaf without the artifact receipts", async () => {
  const requiredKinds = ["artifact_path", "artifact_non_empty", "artifact_acceptance"] as const;
  const input: StepAssessmentInput = {
    runId: "run", planId: "plan", attempt: 1, skills: [], canonicalState, expectedArtifactKind: "document",
    step: {
      id: "deliver", objective: "Deliver the aggregation report", role: "deliver", dependencies: [], skillIds: [],
      requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"], kind: "leaf", position: 0, status: "running",
      refinementState: "not_refinable", requiredFacts: [],
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1",
        requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
        resolvedToolNames: ["computer_write_file", "verify_artifact_acceptance"],
        evidenceProducers: [
          ...producerBindings("computer_write_file", ["artifact_path", "artifact_non_empty"], "workspace_artifact_write"),
          ...producerBindings("verify_artifact_acceptance", requiredKinds, "artifact_acceptance"),
        ],
        sourceKinds: ["workspace_file", "generated_artifact"], sideEffect: "workspace_write", evidenceKinds: requiredKinds, targetIds: [],
      },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" as const })),
    },
    evidence: {
      candidateOutput: "Aggregation complete.", modelSteps: 1,
      toolCalls: [{
        toolCallId: "aggregate",
        toolName: "computer_aggregate_table_artifact",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.toolEvidenceReceipt/v1",
          facts: [{ kind: "table_artifact_aggregation", totalRecords: 18 }],
          evidenceKinds: { satisfied: ["table_coverage"], caveated: [], failed: [] },
        }),
      }],
    },
  };

  const processOnly = await new ProfiledRuleStepAssessor("evidence_gate").assess(input);
  assert.equal(processOnly.approved, false);
  assert.deepEqual(processOnly.failedBoundary?.missingEvidenceKinds, requiredKinds);

  const delivered = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    ...input,
    evidence: {
      ...input.evidence,
      candidateOutput: "analysis/report.md",
      toolCalls: [
        ...input.evidence.toolCalls,
        {
          toolCallId: "write",
          toolName: "computer_write_file",
          isError: false,
          admittedEvidenceKinds: ["artifact_path", "artifact_non_empty"],
          result: JSON.stringify({
            artifactReceipt: {
              schema: "agentloop.artifactReceipt/v1",
              artifact: { path: "analysis/report.md", artifactKind: "markdown", bytes: 128 },
              evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty"], caveated: [], failed: [] },
            },
          }),
        },
        {
          toolCallId: "verify",
          toolName: "verify_artifact_acceptance",
          isError: false,
          admittedEvidenceKinds: requiredKinds,
          result: JSON.stringify({
            schema: "agentloop.artifactAcceptance/v1",
            artifact: { path: "analysis/report.md", kind: "document", bytes: 128 },
            verdict: "accepted",
            evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "artifact_acceptance"], caveated: [], failed: [] },
          }),
        },
      ],
    },
  });
  assert.equal(delivered.approved, true, JSON.stringify(delivered));
});

test("Assessment preserves a committed Runtime acceptance fact when audit tool labels are rewritten", async () => {
  const requiredKinds = ["artifact_path", "artifact_non_empty", "format_matches_request", "artifact_openable", "artifact_acceptance"] as const;
  const input: StepAssessmentInput = {
    runId: "run-split-artifact-authority",
    planId: "plan-split-artifact-authority",
    attempt: 1,
    skills: [],
    canonicalState,
    expectedArtifactKind: "document",
    expectedArtifactFormat: "pdf",
    artifactTargets: [{ id: "merged-pdf", kind: "document", format: "pdf", terminalRequired: true }],
    step: {
      id: "merge-pdf",
      objective: "Merge the source PDFs.",
      role: "deliver",
      dependencies: [],
      skillIds: [],
      requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1",
        requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
        resolvedToolNames: ["computer_run_command", "verify_artifact_acceptance"],
        evidenceProducers: [
          ...producerBindings("computer_run_command", ["artifact_path", "artifact_non_empty", "format_matches_request"], "workspace_artifact_write"),
          ...producerBindings("verify_artifact_acceptance", ["artifact_openable", "artifact_acceptance"], "artifact_acceptance"),
        ],
        sourceKinds: ["generated_artifact"],
        sideEffect: "workspace_write",
        evidenceKinds: requiredKinds,
        targetIds: ["merged-pdf"],
        artifactTargets: [{ id: "merged-pdf", kind: "document", format: "pdf", terminalRequired: true }],
      },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" as const })),
    },
    evidence: {
      candidateOutput: "merged.pdf was created and verified.",
      modelSteps: 1,
      toolCalls: [{
        toolCallId: "verify-merged-pdf",
        toolName: "verify_artifact_acceptance",
        isError: false,
        admittedEvidenceKinds: requiredKinds,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "merged.pdf", kind: "pdf", bytes: 1_651_582 },
          verdict: "accepted",
          evidenceKinds: { satisfied: requiredKinds, caveated: [], failed: [] },
        }),
      }],
    },
  };

  const accepted = await new ProfiledRuleStepAssessor("evidence_gate").assess(input);
  assert.equal(accepted.approved, true, JSON.stringify(accepted));

  const relabeledAudit = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    ...input,
    evidence: {
      ...input.evidence,
      toolCalls: input.evidence.toolCalls.map((toolCall) => ({ ...toolCall, toolName: "unbound_acceptance_probe" })),
    },
  });
  assert.equal(relabeledAudit.approved, true);
  assert.equal(relabeledAudit.failedBoundary, undefined);
});

test("tool progress accepts a neutral source receipt unless the current step explicitly binds a workflow action", () => {
  const neutralEvidence = [{
    toolCallId: "mcp-query",
    toolName: "mcp_database_query",
    isError: false,
    result: JSON.stringify({
      evidenceReceipt: {
        schema: "agentloop.toolEvidenceReceipt/v1",
        evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] },
      },
    }),
  }];
  const unbound = deriveRuntimeStepEvidenceState({
    policy: runtimeStepToolProgressPolicy(["source_summary"], { scope: "source" }),
    evidence: neutralEvidence,
  });
  assert.deepEqual(unbound?.missingToolEvidenceKinds, []);

  const bound = deriveRuntimeStepEvidenceState({
    policy: runtimeStepToolProgressPolicy(["source_summary"], {
      scope: "source",
      workflowEvidenceActions: [{
        skillName: "data-platform-query",
        executorId: "query",
        actionId: "query",
        command: "python3",
        script: "scripts/data_platform_query.py",
        args: ["--request", "{{request}}"],
        producesEvidenceKinds: ["source_summary"],
      }],
    }),
    evidence: neutralEvidence,
  });
  assert.deepEqual(bound?.missingToolEvidenceKinds, ["source_summary"]);
  assert.equal(bound?.requiredWorkflowAction?.actionId, "query");
});

test("structured extraction provenance is not an Assessment completion gate", async () => {
  const input = fixture(true, true);
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    ...input,
    runtimeEvidenceBundles: {
      schema: "agentloop.assessmentEvidenceBundles/v1",
      materializationAttempted: false,
      verified: [],
      rejected: [],
    },
  });
  assert.equal(result.approved, true);
  assert.equal(result.failedBoundary, undefined);
});

test("rejected artifact acceptance preserves independently passed path and non-empty facts", async () => {
  const requiredKinds = ["artifact_path", "artifact_non_empty", "format_matches_request"] as const;
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run-artifact", planId: "plan-artifact", attempt: 1, skills: [], canonicalState,
    expectedArtifactKind: "audio",
    step: {
      id: "render", objective: "Render audio", role: "deliver", dependencies: [], skillIds: [], requiredCapabilities: [],
      kind: "leaf", position: 0, status: "running", refinementState: "not_refinable", requiredFacts: [],
      executionBinding: { schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: ["verify_artifact_acceptance"], evidenceProducers: producerBindings("verify_artifact_acceptance", requiredKinds), sourceKinds: ["generated_artifact"], sideEffect: "workspace_write", evidenceKinds: requiredKinds, targetIds: [] },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" })),
    },
    evidence: {
      candidateOutput: "artifact exists", modelSteps: 1,
      toolCalls: [{ toolCallId: "verify", toolName: "verify_artifact_acceptance", isError: false,
        admittedEvidenceKinds: ["artifact_path", "artifact_non_empty", "format_matches_request"], result: JSON.stringify({
        schema: "agentloop.artifactAcceptance/v1",
        artifact: { path: "song.wav", bytes: 21_168_044, kind: "audio" },
        verdict: "rejected",
        evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty"], caveated: [], failed: ["artifact_acceptance", "format_matches_request"] },
      }) }],
    },
  });
  assert.equal(result.criteria.find((criterion) => criterion.criterionId === "artifact_path")?.satisfied, true);
  assert.equal(result.criteria.find((criterion) => criterion.criterionId === "artifact_non_empty")?.satisfied, true);
  assert.equal(result.criteria.find((criterion) => criterion.criterionId === "format_matches_request")?.satisfied, false);
  assert.deepEqual(result.failedBoundary?.missingEvidenceKinds, ["format_matches_request"]);
});

test("producer artifact receipts remain bound to semantic document targets", async () => {
  const requiredKinds = ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt"] as const;
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run-producer-receipt", planId: "plan-producer-receipt", attempt: 1, canonicalState,
    expectedArtifactKind: "document",
    skills: [],
    step: {
      id: "produce", objective: "Produce report", role: "deliver", dependencies: [], skillIds: [], requiredCapabilities: [],
      kind: "leaf", position: 0, status: "running", refinementState: "not_refinable", requiredFacts: [],
      executionBinding: { schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: ["computer_write_file"], evidenceProducers: producerBindings("computer_write_file", requiredKinds), sourceKinds: ["generated_artifact"], sideEffect: "workspace_write", evidenceKinds: requiredKinds, targetIds: [] },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" })),
    },
    evidence: {
      candidateOutput: "已生成报告", modelSteps: 1,
      toolCalls: [{ toolCallId: "write", toolName: "computer_write_file", isError: false,
        admittedEvidenceKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt"], result: JSON.stringify({
        path: "analysis/report.md",
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path: "analysis/report.md", artifactKind: "markdown", bytes: 12 },
          evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "format_matches_request"], caveated: [], failed: [] },
        },
      }) }],
    },
  });
  assert.equal(result.approved, true);
  assert.deepEqual(result.failedBoundary, undefined);
});

const fourPdfTargets = [1, 2, 3, 4].map((ordinal) => ({
  id: `split-pdf-parts.${ordinal}`,
  purpose: "Deliver four independently accepted PDF parts.",
  kind: "document",
  format: "pdf",
  terminalRequired: true,
}));

function acceptedPdfEvidence(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    toolCallId: `verify-part-${index + 1}`,
    toolName: "verify_artifact_acceptance",
    isError: false,
    admittedEvidenceKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "artifact_openable", "format_matches_request"],
    result: JSON.stringify({
      schema: "agentloop.artifactAcceptance/v1",
      artifact: {
        path: `outputs/part-${index + 1}.pdf`,
        kind: "pdf",
        bytes: 100 + index,
        sha256: `${index + 1}`.repeat(64),
      },
      verdict: "accepted",
      evidenceKinds: {
        satisfied: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "artifact_openable", "format_matches_request"],
        caveated: [],
        failed: [],
      },
    }),
  }));
}

test("four canonical artifact targets require four distinct accepted paths in Runtime progress", () => {
  const policy = runtimeStepToolProgressPolicy(
    ["artifact_acceptance", "artifact_openable", "format_matches_request"],
    { artifactTargets: fourPdfTargets },
  );
  const partial = deriveRuntimeStepEvidenceState({ policy, evidence: acceptedPdfEvidence(1) });
  assert.deepEqual(partial?.missingToolEvidenceKinds, ["artifact_acceptance", "artifact_openable", "format_matches_request"]);
  assert.notEqual(partial?.workProduct.status, "accepted");

  const complete = deriveRuntimeStepEvidenceState({ policy, evidence: acceptedPdfEvidence(4) });
  assert.deepEqual(complete?.missingToolEvidenceKinds, []);
  assert.equal(complete?.workProduct.status, "accepted");
  assert.deepEqual(complete?.workProduct.deliverableArtifacts.map((artifact) => artifact.path).sort(), [
    "outputs/part-1.pdf",
    "outputs/part-2.pdf",
    "outputs/part-3.pdf",
    "outputs/part-4.pdf",
  ]);
});

test("Assessor cannot reuse one accepted path across four canonical artifact targets", async () => {
  const requiredKinds = ["artifact_acceptance", "artifact_openable", "format_matches_request"] as const;
  const assess = (count: number) => new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run-four-pdfs",
    planId: "plan-four-pdfs",
    attempt: 1,
    skills: [],
    canonicalState,
    artifactTargets: fourPdfTargets,
    step: {
      id: "split-pdfs",
      objective: "Split into four PDFs",
      role: "deliver",
      dependencies: [],
      skillIds: [],
      requiredCapabilities: [],
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1",
        requiredCapabilities: [],
        resolvedToolNames: ["verify_artifact_acceptance"],
        evidenceProducers: producerBindings("verify_artifact_acceptance", requiredKinds),
        sourceKinds: ["generated_artifact"],
        sideEffect: "workspace_write",
        evidenceKinds: requiredKinds,
        targetIds: [],
        artifactTargets: fourPdfTargets,
      },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "task" as const })),
    },
    evidence: {
      candidateOutput: "Four PDF parts are delivered.",
      modelSteps: 1,
      toolCalls: acceptedPdfEvidence(count),
    },
  });

  const partial = await assess(1);
  assert.equal(partial.approved, false);
  assert.deepEqual(partial.failedBoundary?.missingEvidenceKinds, requiredKinds);

  const complete = await assess(4);
  assert.equal(complete.approved, true);
  assert.equal(complete.failedBoundary, undefined);
});

test("Assessment cannot reject receipt-proven mixed-format targets through one singular expected format", () => {
  const requiredKinds = ["artifact_path", "artifact_non_empty", "format_matches_request", "artifact_openable", "artifact_acceptance"] as const;
  const artifactTargets = [
    { id: "ddm-model", purpose: "DDM modeling report", kind: "document", format: "markdown", terminalRequired: true },
    { id: "collection-standard", purpose: "Collection standard", kind: "spreadsheet", format: "xlsx", terminalRequired: true },
  ];
  const acceptance = (toolCallId: string, path: string, kind: string) => ({
    toolCallId,
    toolName: "verify_artifact_acceptance",
    isError: false,
    admittedEvidenceKinds: requiredKinds,
    result: JSON.stringify({
      schema: "agentloop.artifactAcceptance/v1",
      artifact: { path, kind, bytes: 100, sha256: toolCallId.slice(-1).repeat(64) },
      verdict: "accepted",
      evidenceKinds: { satisfied: requiredKinds, caveated: [], failed: [] },
    }),
  });
  const input: StepAssessmentInput = {
    runId: "run-mixed-format", planId: "plan-mixed-format", attempt: 1, skills: [], canonicalState,
    // This singular compatibility hint reflects the exact composite-leaf
    // shape that previously vetoed the valid Markdown sibling receipt.
    expectedArtifactFormat: "xlsx",
    artifactTargets,
    step: {
      id: "produce-ddm-and-standard", objective: "Produce a DDM report and collection standard", role: "deliver", dependencies: [], skillIds: [], requiredCapabilities: [],
      kind: "leaf", position: 0, status: "running", refinementState: "not_refinable", requiredFacts: [],
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: ["verify_artifact_acceptance"],
        evidenceProducers: producerBindings("verify_artifact_acceptance", requiredKinds), sourceKinds: ["generated_artifact"], sideEffect: "workspace_write",
        evidenceKinds: requiredKinds, targetIds: [], artifactTargets,
      },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" as const })),
    },
    evidence: {
      candidateOutput: "DDM report and collection standard are delivered.", modelSteps: 1,
      toolCalls: [
        acceptance("verify-markdown-1", "results/ddm-model.md", "markdown"),
        acceptance("verify-xlsx-2", "results/collection-standard.xlsx", "xlsx"),
      ],
    },
  };
  const modelRejectedOnlyRuntimeFact = {
    id: "assessment-mixed-format", planId: input.planId, stepId: input.step.id, attempt: input.attempt,
    approved: false,
    criteria: requiredKinds.map((criterionId) => ({
      criterionId,
      satisfied: criterionId !== "format_matches_request",
      rationale: criterionId === "format_matches_request" ? "No accepted artifact matches the required spreadsheet format." : "satisfied",
      evidenceRefs: ["verify-markdown-1", "verify-xlsx-2"],
    })),
    skills: [], evidenceDigest: "mixed-format", feedback: "format mismatch", createdAt: 1,
  };

  const enforced = enforceAdmittedAssessment(input, modelRejectedOnlyRuntimeFact);
  assert.equal(enforced.approved, true);
  assert.equal(enforced.criteria.find((criterion) => criterion.criterionId === "format_matches_request")?.satisfied, true);
  assert.equal(enforced.failedBoundary, undefined);
});

test("per-receipt admission preserves distinct Markdown attestations for generic document targets", async () => {
  const requiredKinds = ["artifact_path", "artifact_non_empty", "format_matches_request", "artifact_openable", "artifact_acceptance"] as const;
  const artifactTargets = [
    { id: "validation-result", purpose: "Validation result", kind: "document", terminalRequired: true },
    { id: "qc-result", purpose: "QC result", kind: "document", terminalRequired: true },
  ];
  const policy = runtimeStepToolProgressPolicy(requiredKinds, {
    scope: "artifact",
    artifactTargets,
    evidenceProducers: producerBindings("verify_artifact_acceptance", requiredKinds),
  });
  const acceptance = (toolCallId: string, path: string) => {
    const evidence = {
      toolCallId,
      toolName: "verify_artifact_acceptance",
      isError: false,
      result: JSON.stringify({
        schema: "agentloop.artifactAcceptance/v1",
        artifact: { path, kind: "markdown", bytes: 100, sha256: toolCallId.slice(-1).repeat(64) },
        verdict: "accepted",
        evidenceKinds: { satisfied: requiredKinds, caveated: [], failed: [] },
      }),
    };
    return { ...evidence, admittedEvidenceKinds: admittedEvidenceKindsForCommittedResult({ evidence, policy }) };
  };
  const toolCalls = [
    acceptance("verify-validation-1", "results/validation.md"),
    acceptance("verify-qc-2", "results/qc.md"),
  ];
  for (const toolCall of toolCalls) {
    assert.deepEqual(new Set(toolCall.admittedEvidenceKinds), new Set(requiredKinds));
  }

  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run-generic-document-targets", planId: "plan-generic-document-targets", attempt: 1, skills: [], canonicalState,
    artifactTargets,
    step: {
      id: "validate-and-qc", objective: "Produce a validation result and a QC result", role: "deliver", dependencies: [], skillIds: [], requiredCapabilities: [],
      kind: "leaf", position: 0, status: "running", refinementState: "not_refinable", requiredFacts: [],
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: ["verify_artifact_acceptance"],
        evidenceProducers: producerBindings("verify_artifact_acceptance", requiredKinds), sourceKinds: ["generated_artifact"], sideEffect: "workspace_write",
        evidenceKinds: requiredKinds, targetIds: [], artifactTargets,
      },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" as const })),
    },
    evidence: { candidateOutput: "Validation and QC results are delivered.", modelSteps: 1, toolCalls },
  });
  assert.equal(result.approved, true, JSON.stringify(result));
  assert.equal(result.failedBoundary, undefined);
});
