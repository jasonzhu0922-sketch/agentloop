import assert from "node:assert/strict";
import test from "node:test";
import {
  createDecisionCommit,
  decisionClaimsFromEvidence,
  decisionCommitsFromEvents,
  enforceDecisionGate,
  decisionSatisfied,
} from "../src/runtime/decision-ledger.ts";

const commit = createDecisionCommit({
  requestId: "request-1",
  requestRevision: 1,
  planId: "plan-1",
  stepId: "step-1",
  selectedOptions: [{ id: "shanghai-branch", label: "上海分公司", identityRefs: ["91310113MA1GPM325T"] }],
});

test("decision ledger persists exact selections and restores them from durable events", () => {
  assert.deepEqual(decisionCommitsFromEvents([{ type: "decision.committed", data: { commit } }]), [commit]);
});

test("a conflicting identity claim cannot satisfy an exact decision", () => {
  const claims = decisionClaimsFromEvidence([{
    toolCallId: "detail-parent",
    toolName: "detail",
    isError: false,
    result: JSON.stringify({
      schema: "agentloop.commandOutputProjection/v1",
      decisionClaim: {
        schema: "agentloop.runtimeDecisionClaim/v1",
        status: "satisfied",
        identityRefs: ["91310000MA1FL7GN6D"],
      },
    }),
  }]);
  assert.equal(decisionSatisfied(commit, claims), false);
});

test("a matching identity claim satisfies an exact decision", () => {
  const claims = decisionClaimsFromEvidence([{
    toolCallId: "detail-branch",
    toolName: "detail",
    isError: false,
    result: JSON.stringify({
      decisionClaim: {
        schema: "agentloop.runtimeDecisionClaim/v1",
        status: "satisfied",
        identityRefs: ["91310113MA1GPM325T"],
      },
    }),
  }]);
  assert.equal(decisionSatisfied(commit, claims), true);
});

test("the minimal assessment gate rejects an otherwise approved conflicting delivery", () => {
  const assessment = enforceDecisionGate({
    assessment: {
      id: "assessment-1", planId: "plan-1", stepId: "step-1", attempt: 1, approved: true,
      criteria: [{ criterionId: "source_summary", satisfied: true, rationale: "source present", evidenceRefs: [] }],
      skills: [], evidenceDigest: "original", feedback: "", createdAt: 1,
    },
    planId: "plan-1",
    stepId: "step-1",
    ledger: [commit],
    evidence: [{
      toolCallId: "detail-parent", toolName: "detail", isError: false,
      result: JSON.stringify({ decisionClaim: {
        schema: "agentloop.runtimeDecisionClaim/v1", status: "satisfied", identityRefs: ["91310000MA1FL7GN6D"],
      } }),
    }],
  });
  assert.equal(assessment.approved, false);
  assert.deepEqual(assessment.failedBoundary?.missingEvidenceKinds, ["decision_binding"]);
});
