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
