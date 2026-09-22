import assert from "node:assert/strict";
import test from "node:test";
import {
  createDecisionCommit,
  decisionClaimsFromEvidence,
  decisionCommitsFromEvents,
  assessDecisionBindings,
  decisionSatisfied,
} from "../src/runtime/decision-ledger.ts";
import { ModelStepAssessor } from "../src/planning/assessor.ts";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { isCaveatedStepResult } from "../src/runtime/step-result-committer.ts";
import type { StepAssessmentInput } from "../src/planning/contracts.ts";

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

test("an answered exact decision does not require a duplicate downstream claim", () => {
  const assessment = assessDecisionBindings({
    assessment: {
      id: "assessment-1", planId: "plan-1", stepId: "step-1", attempt: 1, approved: true,
      criteria: [{ criterionId: "source_summary", satisfied: true, rationale: "source present", evidenceRefs: [] }],
      skills: [], evidenceDigest: "original", feedback: "", createdAt: 1,
    },
    planId: "plan-1",
    stepId: "step-1",
    ledger: [commit],
    evidence: [],
  });
  assert.equal(assessment.approved, true);
  assert.deepEqual(assessment.decisionBindings?.map((binding) => ({ status: binding.status, blocking: binding.blocking })), [
    { status: "satisfied", blocking: false },
  ]);
});

test("a demonstrated conflicting decision is retained as a delivery caveat", () => {
  const assessment = assessDecisionBindings({
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
  assert.equal(assessment.approved, true);
  assert.deepEqual(assessment.decisionBindings?.map((binding) => ({ status: binding.status, blocking: binding.blocking })), [
    { status: "conflict", blocking: false },
  ]);
  assert.equal(assessment.failedBoundary, undefined);
});

test("a decision conflict remains terminally caveatable when Skill observation is unavailable", () => {
  assert.equal(isCaveatedStepResult({
    id: "assessment-1", planId: "plan-1", stepId: "step-1", attempt: 1, approved: true,
    criteria: [{ criterionId: "delivered", satisfied: true, rationale: "delivered", evidenceRefs: [] }],
    decisionBindings: [{
      decisionId: commit.id, status: "conflict", blocking: false,
      rationale: "A downstream identity differs from the selected identity.", evidenceRefs: [commit.id],
    }],
    skills: [{ skillId: "optional-skill", skillName: "optional-skill", followed: false, status: "not_assessed", rationale: "No Skill-specific observation." }],
    evidenceDigest: "digest", feedback: "The result carries a decision conflict warning.", createdAt: 1,
  }, {}), true);
});

test("a non-blocking model-judged criterion is retained as unverified without rejecting delivery", async () => {
  const model = {
    limits: { maxOutputTokens: 1_024 },
    async complete() {
      return {
        content: "",
        finishReason: "tool_calls" as const,
        toolCalls: [{
          id: "assessment-call",
          name: "submit_assessment",
          arguments: {
            criteria: [{ criterionId: "visual-quality", satisfied: false, rationale: "Cannot objectively verify aesthetic quality.", evidenceRefs: [] }],
            skills: [], feedback: "Visual quality should be reviewed by the user.",
          },
        }],
      };
    },
  } as unknown as ModelAdapter;
  const input = {
    runId: "run-1", planId: "plan-1", attempt: 1,
    step: {
      id: "step-1",
      objective: "Deliver a visual artifact.",
      role: "deliver",
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1",
        requiredCapabilities: [], resolvedToolNames: [], sourceKinds: [], sideEffect: "none", evidenceKinds: [],
      },
      successCriteria: [{
        id: "visual-quality", description: "The visual direction is appropriate.", source: "task",
        verification: "model_judged", blocking: false,
      }],
    },
    skills: [], evidence: { candidateOutput: "A PNG was delivered.", toolCalls: [], modelSteps: 1 },
  } as unknown as StepAssessmentInput;
  const assessment = await new ModelStepAssessor(model).assess(input);
  assert.equal(assessment.approved, true);
  assert.deepEqual(assessment.criteria.map((criterion) => ({ status: criterion.status, blocking: criterion.blocking })), [
    { status: "unverified", blocking: false },
  ]);
});
