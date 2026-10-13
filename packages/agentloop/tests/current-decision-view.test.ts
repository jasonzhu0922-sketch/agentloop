import assert from "node:assert/strict";
import test from "node:test";
import { deriveCurrentDecisionView, projectCurrentDecisionView } from "../src/runtime/current-decision-view.ts";

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
    context: { canonicalState: { stateId: "state", runId: "run-1", intentId: "intent", revision }, plan: { id: "plan", version: 1 }, stepId: "build" },
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
