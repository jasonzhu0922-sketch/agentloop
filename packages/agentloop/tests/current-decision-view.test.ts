import assert from "node:assert/strict";
import test from "node:test";
import { deriveCurrentDecisionView, projectCurrentDecisionView } from "../src/runtime/current-decision-view.ts";
import { createCanonicalRunState, type CanonicalGoalGap } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";

function evidence(nextAction: string): any {
  return {
    schema: "agentloop.runtimeStepEvidenceState/v1",
    requiredEvidenceKinds: ["artifact_path", "artifact_acceptance"],
    satisfiedEvidenceKinds: [], caveatedEvidenceKinds: [], failedEvidenceKinds: [],
    missingRequiredEvidenceKinds: ["artifact_path", "artifact_acceptance"],
    pendingCandidateEvidenceKinds: [], missingToolEvidenceKinds: ["artifact_path", "artifact_acceptance"],
    workProduct: { schema: "agentloop.runtimeStepWorkProductState/v1", status: "process_artifact_available", acceptanceRequired: true,
      deliverableArtifacts: [], processArtifacts: [] },
    knownArtifacts: [], processArtifacts: [], recentActionableDiagnostic: false,
    recentComputationBindingMismatch: false, recentPatchPreconditionFailure: false,
    nextAction, evidenceProducingToolNames: ["computer_run_command"], exploratoryToolNames: [], instruction: "execute current source",
  };
}

function input(revision = 1): any {
  const v1 = { id: "v1", presence: "present", sha256: "a".repeat(64), observationIds: ["obs-v1"] };
  const v2 = { id: "v2", presence: "present", sha256: "b".repeat(64), observationIds: ["obs-v2"] };
  return {
    runId: "run-1",
    context: { canonicalState: { ...createCanonicalRunState({ runId: "run-1", userInput: "Build the requested result",
      understanding: understandTask({ objective: "Build the requested result" }), now: 1 }),
      stateId: "state", revision, plan: { id: "plan", version: 1 } }, stepId: "build" },
    stepSemanticFrame: { stepId: "build", phaseRole: "artifact_production", evidenceMode: "produce_without_external_evidence", completionBoundary: ["artifact_path", "artifact_acceptance"] },
    evidence: evidence("produce_artifact"),
    workProducts: {
      observations: {
        schema: "agentloop.workProductObservations/v1", runId: "run-1", workspaceId: "workspace", throughSeq: 4,
        operations: [],
        observations: [
          { id: "obs-v1", objectId: "spec", path: "deck-spec.json", kind: "created", basis: "file_metadata", operationStatus: "succeeded", source: { runId: "run-1", workspaceId: "workspace", seq: 1, toolCallId: "write-v1", toolName: "computer_write_file", resultSha256: "x", pointer: "" }, checks: [] },
          { id: "obs-v2", objectId: "spec", path: "deck-spec.json", kind: "modified", basis: "file_metadata", operationStatus: "succeeded", source: { runId: "run-1", workspaceId: "workspace", seq: 3, toolCallId: "write-v2", toolName: "computer_write_file", resultSha256: "y", pointer: "" }, checks: [] },
        ],
        objects: [{ id: "spec", path: "deck-spec.json", presence: "present", currentVersionId: "v2", versions: [v1, v2], observationIds: ["obs-v1", "obs-v2"], checks: [] }],
        issues: [],
      },
      semantics: {
        schema: "agentloop.workProductSemantics/v1", goalId: "goal", declarations: [], rejected: [], roles: [],
        issues: [{ id: "issue-1", kind: "issue", issueId: "bad-font", path: "deck-spec.json", versionId: "v1", source: { runId: "run-1", workspaceId: "workspace", goalId: "goal", modelStep: 2, throughSeq: 2, contentSha256: "z", authority: "model", index: 0 }, symptom: "invalid font", evidenceToolCallIds: ["build-v1"], attemptedToolCallIds: [], pendingActions: ["repair source"], claimedStatus: "open", resolutionToolCallIds: [], applicability: "historical", resolutionSupport: "none" }],
      },
      diagnostics: [{ toolCallId: "build-v1", toolName: "computer_run_command", diagnosticPreview: "fontSize: thirty" }],
    },
  };
}

test("a diagnostic bound to a superseded version is historical and cannot replace current nextAction", () => {
  const view = deriveCurrentDecisionView(input());
  assert.equal(view.nextAction, "produce_artifact");
  assert.equal(view.workProducts.diagnostics[0].applicability, "historical");
  assert.equal(view.workProducts.diagnostics[0].binding, "declared_version");
  assert.equal(view.workProducts.objects[0].currentVersionId, "v2");
  assert.equal(projectCurrentDecisionView(view).workProducts.diagnostics.length, 0);
});

test("assessment bookkeeping changes audit identity but not the current decision basis", () => {
  const before = deriveCurrentDecisionView(input(1));
  const after = deriveCurrentDecisionView(input(2));
  assert.equal(after.identity.decisionBasisDigest, before.identity.decisionBasisDigest);
  assert.notEqual(after.identity.viewId, before.identity.viewId);
});

test("a newly committed generic tool fact changes the decision basis without counting duplicate calls", () => {
  const before = deriveCurrentDecisionView(input());
  const afterRead = deriveCurrentDecisionView({
    ...input(),
    toolEvidence: [{ toolCallId: "read-1", toolName: "read_evidence", result: '{"source":"current"}', operationStatus: "succeeded", isError: false }],
  });
  const afterDuplicateRead = deriveCurrentDecisionView({
    ...input(),
    toolEvidence: [
      { toolCallId: "read-1", toolName: "read_evidence", result: '{"source":"current"}', operationStatus: "succeeded", isError: false },
      { toolCallId: "read-2", toolName: "read_evidence", result: '{"source":"current"}', operationStatus: "succeeded", isError: false },
    ],
  });
  assert.notEqual(afterRead.identity.decisionBasisDigest, before.identity.decisionBasisDigest);
  assert.equal(afterDuplicateRead.identity.decisionBasisDigest, afterRead.identity.decisionBasisDigest);
});

test("new publication IDs cannot masquerade as new evidence, but source identity and content remain material", () => {
  const originalRef = { schema: "agentloop.resultRef/v1", resultId: "rr_11111111-1111-4111-8111-111111111111" };
  const freshRef = { ...originalRef, resultId: "rr_22222222-2222-4222-8222-222222222222" };
  const digest = (resultRef: unknown, content: string, sourceResultRef = originalRef) => deriveCurrentDecisionView({
    ...input(),
    toolEvidence: [{ toolCallId: "read", toolName: "read_result", resultRef,
      result: JSON.stringify({ resultRef, sourceResultRef, content }), isError: false }],
  }).identity.decisionBasisDigest;
  assert.equal(digest(originalRef, "observed"), digest(freshRef, "observed"));
  assert.notEqual(digest(originalRef, "observed"), digest(freshRef, "changed"));
  assert.notEqual(digest(originalRef, "observed"), digest(freshRef, "observed", freshRef));
});

function gap(overrides: Partial<CanonicalGoalGap> = {}): CanonicalGoalGap {
  return { id: "gap", stepId: "build", status: "open", missingEvidenceKinds: ["source_summary"],
    violatedSkillRequirements: [], evidenceRefs: ["source"], suggestedAction: "repair_leaf", openedAt: 2,
    unmetCriteria: [{ criterionId: "requested_fact", status: "unverified", rationale: "The source does not establish the requested fact.", evidenceRefs: ["source"] }],
    ...overrides };
}

test("canonical assessment gaps remain visible after receipt prerequisites are satisfied and after new observations", () => {
  const data = input();
  data.evidence = { ...data.evidence, missingRequiredEvidenceKinds: [], missingToolEvidenceKinds: [], nextAction: "submit_completion_candidate" };
  data.context.canonicalState.gaps = [gap()];
  const before = deriveCurrentDecisionView(data);
  assert.deepEqual(before.currentGap.receipts.missingRequiredEvidenceKinds, []);
  assert.equal(before.currentGap.assessmentGaps[0].unmetCriteria?.[0].criterionId, "requested_fact");
  assert.equal(before.nextAction, "resolve_evidence_gap");
  const after = deriveCurrentDecisionView({ ...data, toolEvidence: [{ toolCallId: "new-read", toolName: "read_source", result: "new observation", isError: false }] });
  assert.equal(after.nextAction, "resolve_evidence_gap", "new observations require assessment before closing a goal gap");
  const projection = projectCurrentDecisionView(after);
  assert.equal(projection.evidence?.receiptNextAction, "submit_completion_candidate");
  assert.equal(projection.nextAction, "resolve_evidence_gap");
  data.context.canonicalState.gaps = [gap({ status: "resolved", resolvedAt: 3 })];
  assert.equal(deriveCurrentDecisionView(data).nextAction, "submit_completion_candidate");
});

test("canonical gap direction distinguishes evidence, synthesis, plan revision and input without borrowing other steps' gaps", () => {
  const data = input();
  data.context.canonicalState.gaps = [gap({ stepId: "other-step" }), gap({ status: "resolved" })];
  assert.equal(deriveCurrentDecisionView(data).nextAction, "produce_artifact");
  for (const [overrides, expected] of [
    [{ stepId: "retired-step", repairScopeStepIds: ["build"] }, "resolve_evidence_gap"],
    [{ missingEvidenceKinds: [] }, "revise_completion_candidate"],
    [{ suggestedAction: "revise_plan" }, "revise_plan"],
    [{ suggestedAction: "ask_user" }, "request_input"],
    [{ suggestedAction: "fail" }, "stop"],
  ] as const) {
    data.context.canonicalState.gaps = [gap(overrides)];
    assert.equal(deriveCurrentDecisionView(data).nextAction, expected);
  }
});
