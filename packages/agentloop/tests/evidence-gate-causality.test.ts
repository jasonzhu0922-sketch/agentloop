import assert from "node:assert/strict";
import test from "node:test";
import { ProfiledRuleStepAssessor } from "../src/planning/assessor.ts";
import type { StepAssessmentInput } from "../src/planning/contracts.ts";

function fixture(schema: boolean, caveats: boolean): StepAssessmentInput {
  const requiredKinds = ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"] as const;
  return {
    runId: "run", planId: "plan", attempt: 1, skills: [],
    step: {
      id: "analysis", objective: "Analyze acquired source data", role: "deliver", dependencies: [], skillIds: [], requiredCapabilities: [],
      kind: "leaf", position: 0, status: "running", refinementState: "not_refinable", requiredFacts: [],
      executionBinding: { schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: [], sourceKinds: ["database"], sideEffect: "none", evidenceKinds: requiredKinds },
      evidenceContract: { requiredKinds, caveatPolicy: "mark_unverified_facts" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" })),
    },
    evidence: {
      candidateOutput: "已取得 46 条记录，16 个日期；同日多价格，数据覆盖有限。", modelSteps: 8,
      toolCalls: [{ toolCallId: "acquire", toolName: "computer_run_command", isError: false, result: JSON.stringify({
        schema: "agentloop.steelMarketData/v1",
        evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1",
          evidenceKinds: { satisfied: ["source_summary", "record_counts", "structured_extraction_artifact", ...(schema ? ["schema_summary"] : [])], caveated: caveats ? ["explicit_caveats"] : [], failed: [] },
        },
      }) }],
    },
  };
}

test("64272a5d causal replay: missing preflight receipt does not erase recorded caveats", async () => {
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess(fixture(false, true));
  assert.equal(result.approved, false);
  assert.deepEqual(result.failedBoundary?.missingEvidenceKinds, ["schema_summary"]);
  assert.equal(result.criteria.find((criterion) => criterion.criterionId === "explicit_caveats")?.satisfied, true);
  assert.match(result.feedback, /schema_summary/);
  assert.match(result.feedback, /Rewriting the answer cannot create an operation receipt/);
  assert.doesNotMatch(result.feedback, /repair the failed artifact/);
});

test("independent missing caveat evidence is not approved by unrelated source receipts", async () => {
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess(fixture(true, false));
  assert.equal(result.approved, false);
  assert.deepEqual(result.failedBoundary?.missingEvidenceKinds, ["explicit_caveats"]);
});

test("preserved preflight and caveat evidence removes the artificial failure", async () => {
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess(fixture(true, true));
  assert.equal(result.approved, true);
  assert.equal(result.feedback, "");
});

test("rejected artifact acceptance preserves independently passed path and non-empty facts", async () => {
  const requiredKinds = ["artifact_path", "artifact_non_empty", "format_matches_request"] as const;
  const result = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run-artifact", planId: "plan-artifact", attempt: 1, skills: [],
    expectedArtifactKind: "audio",
    step: {
      id: "render", objective: "Render audio", role: "deliver", dependencies: [], skillIds: [], requiredCapabilities: [],
      kind: "leaf", position: 0, status: "running", refinementState: "not_refinable", requiredFacts: [],
      executionBinding: { schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: ["verify_artifact_acceptance"], sourceKinds: ["generated_artifact"], sideEffect: "workspace_write", evidenceKinds: requiredKinds },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" })),
    },
    evidence: {
      candidateOutput: "artifact exists", modelSteps: 1,
      toolCalls: [{ toolCallId: "verify", toolName: "verify_artifact_acceptance", isError: false, result: JSON.stringify({
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
    runId: "run-producer-receipt", planId: "plan-producer-receipt", attempt: 1,
    expectedArtifactKind: "document",
    skills: [],
    step: {
      id: "produce", objective: "Produce report", role: "deliver", dependencies: [], skillIds: [], requiredCapabilities: [],
      kind: "leaf", position: 0, status: "running", refinementState: "not_refinable", requiredFacts: [],
      executionBinding: { schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: ["computer_write_file"], sourceKinds: ["generated_artifact"], sideEffect: "workspace_write", evidenceKinds: requiredKinds },
      evidenceContract: { requiredKinds, caveatPolicy: "none" },
      successCriteria: requiredKinds.map((id) => ({ id, description: id, source: "planner" })),
    },
    evidence: {
      candidateOutput: "已生成报告", modelSteps: 1,
      toolCalls: [{ toolCallId: "write", toolName: "computer_write_file", isError: false, result: JSON.stringify({
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
