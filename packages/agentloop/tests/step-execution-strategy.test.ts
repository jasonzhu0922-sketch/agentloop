import assert from "node:assert/strict";
import test from "node:test";
import {
  createStepExecutionStrategyProfile,
  DefaultToolExposurePolicy,
  DefaultStepExecutionStrategy,
} from "../src/runtime/step-execution-strategy.ts";
import type { RuntimeStepEvidenceState } from "../src/runtime/tool-progress-policy.ts";

test("action-aware step execution strategy recommends artifact acceptance without hiding granted tools", () => {
  const strategy = new DefaultStepExecutionStrategy({ toolExposurePolicy: new DefaultToolExposurePolicy() });
  const decision = strategy.prepareModelStep({
    modelStep: 2,
    maxSteps: 4,
    hardLimit: 4,
    convergenceOnly: false,
    availableTools: tools([
      "computer_read_file",
      "computer_write_file",
      "computer_run_command",
      "verify_artifact_acceptance",
    ]),
    priorToolEvidence: [],
    stepEvidenceState: state({
      nextAction: "verify_existing_artifact",
      evidenceProducingToolNames: ["verify_artifact_acceptance"],
      exploratoryToolNames: [],
      workProductStatus: "deliverable_available",
      deliverableArtifactPaths: ["poster.png"],
      missingRequiredEvidenceKinds: ["artifact_acceptance"],
    }),
  });

  assert.equal(decision.toolCatalog.mode, "full");
  assert.deepEqual(decision.toolCatalog.availableToolNames, [
    "computer_read_file",
    "computer_write_file",
    "computer_run_command",
    "verify_artifact_acceptance",
  ]);
  assert.deepEqual(decision.toolCatalog.preferredToolNames, ["verify_artifact_acceptance"]);
  assert.equal(decision.loopStepFrame.currentStage.availableToolCount, 4);
  assert.equal(decision.loopStepFrame.toolCatalog?.preferredToolCount, 1);
  assert.equal(decision.loopStepFrame.currentEvidenceState?.nextAction, "verify_existing_artifact");
  assert.equal(decision.promptProjection.largeToolResultProjectionCharacters, 2048);
});

test("action-aware step execution strategy deprioritizes read-only tools during diagnostic repair", () => {
  const strategy = new DefaultStepExecutionStrategy({ toolExposurePolicy: new DefaultToolExposurePolicy() });
  const decision = strategy.prepareModelStep({
    modelStep: 3,
    maxSteps: 6,
    hardLimit: 6,
    convergenceOnly: false,
    availableTools: tools([
      "computer_read_file",
      "computer_search_text",
      "computer_write_file",
      "computer_run_command",
    ]),
    priorToolEvidence: [],
    stepEvidenceState: state({
      nextAction: "repair_artifact_source",
      evidenceProducingToolNames: ["computer_write_file", "computer_run_command"],
      exploratoryToolNames: [],
      recentActionableDiagnostic: true,
      workProductStatus: "process_artifact_available",
      processArtifactPaths: ["outline.json"],
      missingRequiredEvidenceKinds: ["artifact_path", "artifact_acceptance"],
    }),
  });

  assert.deepEqual(decision.toolCatalog.preferredToolNames, ["computer_write_file", "computer_run_command"]);
  assert.deepEqual(
    decision.toolCatalog.deprioritizedToolGroups.flatMap((group) => group.toolNames).sort(),
    ["computer_read_file", "computer_search_text"],
  );
  assert.equal(decision.promptProjection.largeToolResultProjectionCharacters, 4096);
  assert.equal(decision.promptProjection.largeToolResultPreviewCharacters, 1200);
});

test("full-catalog step execution profile keeps all granted tools visible", () => {
  const strategy = createStepExecutionStrategyProfile("full-catalog");
  const decision = strategy.prepareModelStep({
    modelStep: 2,
    maxSteps: 4,
    hardLimit: 4,
    convergenceOnly: false,
    availableTools: tools(["computer_read_file", "computer_write_file", "computer_run_command", "verify_artifact_acceptance"]),
    priorToolEvidence: [],
    stepEvidenceState: state({
      nextAction: "verify_existing_artifact",
      evidenceProducingToolNames: ["verify_artifact_acceptance"],
      exploratoryToolNames: [],
      workProductStatus: "deliverable_available",
      deliverableArtifactPaths: ["poster.png"],
      missingRequiredEvidenceKinds: ["artifact_acceptance"],
    }),
  });

  assert.equal(decision.toolCatalog.policyId, "agentloop.fullCatalogToolExposurePolicy/v1");
  assert.equal(decision.toolCatalog.mode, "full");
  assert.deepEqual(decision.toolCatalog.availableToolNames, [
    "computer_read_file",
    "computer_write_file",
    "computer_run_command",
    "verify_artifact_acceptance",
  ]);
});

test("default step execution strategy keeps every Plan-granted tool visible", () => {
  const strategy = new DefaultStepExecutionStrategy();
  const decision = strategy.prepareModelStep({
    modelStep: 4,
    maxSteps: 6,
    hardLimit: 6,
    convergenceOnly: false,
    availableTools: tools(["load_skill", "computer_write_file", "computer_run_command", "verify_artifact_acceptance"]),
    priorToolEvidence: [{ toolCallId: "source", toolName: "read_source", result: "{}", isError: false }],
    stepEvidenceState: state({
      nextAction: "submit_completion_candidate",
      evidenceProducingToolNames: ["computer_write_file", "computer_run_command"],
      exploratoryToolNames: ["read_source"],
      workProductStatus: "process_artifact_available",
      processArtifactPaths: ["report.py"],
      missingRequiredEvidenceKinds: ["artifact_path"],
    }),
  });

  assert.equal(decision.toolCatalog.mode, "full");
  assert.deepEqual(decision.toolCatalog.availableToolNames, [
    "load_skill",
    "computer_write_file",
    "computer_run_command",
    "verify_artifact_acceptance",
  ]);
});

test("action-aware delivery-only submit stage keeps tools visible before non-setup evidence exists", () => {
  const strategy = new DefaultStepExecutionStrategy({ toolExposurePolicy: new DefaultToolExposurePolicy() });
  const decision = strategy.prepareModelStep({
    modelStep: 1,
    maxSteps: 4,
    hardLimit: 4,
    convergenceOnly: false,
    availableTools: tools(["load_skill", "computer_write_file", "webfetch"]),
    priorToolEvidence: [],
    stepEvidenceState: state({
      nextAction: "submit_completion_candidate",
      evidenceProducingToolNames: ["computer_write_file"],
      exploratoryToolNames: ["webfetch"],
      workProductStatus: "none",
      missingRequiredEvidenceKinds: ["delivery_receipt"],
    }),
  });

  assert.equal(decision.toolCatalog.mode, "full");
  assert.deepEqual(decision.toolCatalog.availableToolNames, ["load_skill", "computer_write_file", "webfetch"]);
});

test("action-aware submit stage keeps production tools callable after non-setup evidence exists", () => {
  const strategy = new DefaultStepExecutionStrategy({ toolExposurePolicy: new DefaultToolExposurePolicy() });
  const decision = strategy.prepareModelStep({
    modelStep: 3,
    maxSteps: 4,
    hardLimit: 4,
    convergenceOnly: false,
    availableTools: tools(["load_skill", "computer_write_file", "webfetch"]),
    priorToolEvidence: [{
      toolCallId: "fetch",
      toolName: "webfetch",
      result: "{}",
      isError: false,
    }],
    stepEvidenceState: state({
      nextAction: "submit_completion_candidate",
      evidenceProducingToolNames: ["computer_write_file"],
      exploratoryToolNames: ["webfetch"],
      workProductStatus: "none",
      missingRequiredEvidenceKinds: ["delivery_receipt"],
    }),
  });

  assert.equal(decision.toolCatalog.mode, "full");
  assert.deepEqual(decision.toolCatalog.availableToolNames, ["load_skill", "computer_write_file", "webfetch"]);
  assert.deepEqual(decision.toolCatalog.preferredToolNames, ["load_skill", "webfetch"]);
  assert.deepEqual(decision.toolCatalog.deprioritizedToolGroups.flatMap((group) => group.toolNames), ["computer_write_file"]);
});

function tools(names: readonly string[]): Array<{ name: string; description: string; inputSchema: { type: "object" } }> {
  return names.map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
}

function state(input: {
  readonly nextAction: RuntimeStepEvidenceState["nextAction"];
  readonly evidenceProducingToolNames: readonly string[];
  readonly exploratoryToolNames: readonly string[];
  readonly missingRequiredEvidenceKinds: readonly string[];
  readonly workProductStatus: RuntimeStepEvidenceState["workProduct"]["status"];
  readonly deliverableArtifactPaths?: readonly string[];
  readonly processArtifactPaths?: readonly string[];
  readonly recentActionableDiagnostic?: boolean;
}): RuntimeStepEvidenceState {
  return {
    schema: "agentloop.runtimeStepEvidenceState/v1",
    requiredEvidenceKinds: ["artifact_path", "artifact_acceptance"],
    satisfiedEvidenceKinds: [],
    caveatedEvidenceKinds: [],
    failedEvidenceKinds: [],
    missingRequiredEvidenceKinds: input.missingRequiredEvidenceKinds,
    pendingCandidateEvidenceKinds: [],
    missingToolEvidenceKinds: input.missingRequiredEvidenceKinds,
    workProduct: {
      schema: "agentloop.runtimeStepWorkProductState/v1",
      status: input.workProductStatus,
      acceptanceRequired: true,
      expectedArtifactKind: "image",
      deliverableArtifacts: (input.deliverableArtifactPaths ?? []).map((path) => ({
        path,
        sourceTool: "computer_write_file",
        toolCallId: "write",
        artifactKind: "image",
      })),
      processArtifacts: (input.processArtifactPaths ?? []).map((path) => ({
        path,
        sourceTool: "computer_write_file",
        toolCallId: "write",
      })),
    },
    knownArtifacts: [],
    processArtifacts: [],
    recentActionableDiagnostic: input.recentActionableDiagnostic ?? false,
    recentPatchPreconditionFailure: false,
    nextAction: input.nextAction,
    evidenceProducingToolNames: input.evidenceProducingToolNames,
    exploratoryToolNames: input.exploratoryToolNames,
    instruction: "Use the current-step semantic state.",
  };
}
