import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/storage/database.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { admitPlan } from "../src/planning/admission.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import { acceptedCanonicalDelivery, canonicalDeliveryPlanScope, createCanonicalRunState,
  reconcileCanonicalDeliveryTargetBindings } from "../src/runtime/canonical-run-state.ts";
import type { CanonicalDeliveryTarget } from "../src/runtime/canonical-run-state.ts";
import { buildRuntimeDeliveryCandidate } from "../src/runtime/delivery-candidate.ts";
import { deriveWorkProductObservations } from "../src/runtime/work-product-observations.ts";
import { approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

const deliverables = [
  { targetId: "figure", purpose: "A complete HTML figure", expectedArtifactCount: 1, action: "create" as const,
    kind: "html" as const, surface: "workspace_artifact" as const },
  { targetId: "findings", purpose: "Explain the supplied observations", expectedArtifactCount: 1, action: "none" as const,
    kind: "none" as const, surface: "conversation" as const },
];
const goal = "Produce an HTML figure and explain the supplied observations: first=1, second=3.";
const originalAnswer = "The second observation exceeds the first by 2.";
const html = "<!doctype html><html lang='en'><meta charset='utf-8'><title>Observations</title><body><h1>Observations</h1><p>First: 1; second: 3.</p></body></html>";
const fileCapabilities = ["workspace_artifact_write", "artifact_acceptance"];

function initialState() {
  return createCanonicalRunState({ runId: "delivery-lifecycle", userInput: goal,
    understanding: understandTask({ objective: goal, resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true, deliverables,
    } }) });
}

test("candidate claims enumerate the canonical surfaces without letting prose replace file identity", () => {
  const binding = { targetId: "figure", deliveryTargetId: "figure", path: "figure.html", versionId: "v1", bytes: 100,
    sha256: "a".repeat(64), observedByToolCallId: "write", declarationId: "binding", bindingAuthority: "runtime" as const };
  const receipt = { toolCallId: "verify", toolName: "verify_artifact_acceptance", isError: false,
    result: JSON.stringify({ schema: "agentloop.artifactAcceptance/v1", verdict: "accepted", artifact: { path: binding.path, sha256: binding.sha256 } }) };
  const input = { output: originalAnswer, deliveryTargets: Object.values(initialState().targets),
    artifactBindings: [binding], artifactTargets: [{ targetId: "figure", purpose: "figure", kind: "html" }], toolEvidence: [receipt] };
  assert.deepEqual(buildRuntimeDeliveryCandidate(input).deliveryClaims.map((claim) => claim.targetId), ["figure", "findings"]);
  assert.deepEqual(buildRuntimeDeliveryCandidate({ ...input, toolEvidence: [] }).deliveryClaims.map((claim) => claim.targetId), ["findings"]);
  assert.deepEqual(buildRuntimeDeliveryCandidate({ ...input, output: " " }).deliveryClaims.map((claim) => claim.targetId), ["figure"]);
  assert.deepEqual(buildRuntimeDeliveryCandidate({ ...input, artifactBindings: [{ ...binding, sha256: "b".repeat(64) }] })
    .deliveryClaims.map((claim) => claim.targetId), ["findings"]);
});

for (const { repair, sequential } of [
  { repair: undefined, sequential: false }, { repair: "figure", sequential: false },
  { repair: "findings", sequential: false }, { repair: undefined, sequential: true },
] as const) {
  test(`Run delivery persists every target and repairs only the unresolved surface (${sequential ? "separate sequential producers" : repair ?? "no repair"})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentloop-delivery-lifecycle-"));
    const database = new AppDatabase(":memory:");
    let recoveries = 0;
    let writes = 0;
    const writtenSteps = new Set<string>();
    let acceptedBefore: CanonicalDeliveryTarget | undefined;
    try {
      const runs = new RunService({ database, workspaceRoot: root, skills: new SkillService(database), maxSteps: 5,
        plannerFactory: () => ({ plan: async () => ({ goal, selectedSkillIds: [], steps: sequential ? [
          { id: "figure-producer", objective: "Produce the HTML figure.", dependencies: [], skillIds: [],
            requiredCapabilities: fileCapabilities, targetIds: ["figure"],
            successCriteria: [{ id: "figure", description: "Deliver the requested figure.", source: "task" }] },
          { id: "findings-producer", objective: "Explain the observations using the published figure result.", dependencies: ["figure-producer"],
            skillIds: [], requiredCapabilities: ["conversation_delivery"], targetIds: ["findings"],
            successCriteria: [{ id: "findings", description: "Explain the supplied observations.", source: "task" }] },
        ] : [{ id: "mixed", objective: goal, dependencies: [], skillIds: [],
          requiredCapabilities: [...fileCapabilities, "conversation_delivery"], targetIds: ["figure", "findings"],
          successCriteria: [{ id: "request", description: goal, source: "task" }] }] }) }),
        assessorFactory: () => ({ assess: async input => {
          const base = await approvingTestAssessor().assess(input);
          assert.deepEqual(input.evidence.deliveryCandidate?.deliveryClaims.map((claim) => claim.targetId), input.step.executionBinding.targetIds, JSON.stringify({step:input.step.id,candidate:input.evidence.deliveryCandidate}));
          if (repair === undefined || input.step.id !== "mixed") return base;
          return { ...base, approved: false, criteria: base.criteria.map((criterion) => criterion.targetId === repair
            ? { ...criterion, satisfied: false, rationale: "The requested meaning is incomplete." } : criterion),
            feedback: "Repair only the unresolved result, keeping the independently accepted delivery.",
            failedBoundary: { stepId: "mixed", missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [],
              suggestedRepairShape: "revise_plan" as const, unmetCriteria: [{ criterionId: `delivery_target:${repair}`, targetId: repair,
                status: "unverified" as const, rationale: "The requested meaning is incomplete.", evidenceRefs: [] }] } };
        } }),
        recoveryPlannerFactory: () => ({ decide: async input => {
          recoveries += 1;
          const scope = canonicalDeliveryPlanScope(input.canonicalState);
          assert.deepEqual(scope.outstandingTargets.map((target) => target.targetId), [repair]);
          assert.equal(scope.acceptedTargets.length, 1);
          acceptedBefore = scope.acceptedTargets[0];
          assert.ok(acceptedCanonicalDelivery(acceptedBefore));
          const proposal = { shape: "recovery_patch" as const, goal, selectedSkillIds: [], retainedStepIds: [], steps: [{
            id: "repair", objective: "Complete the outstanding result using existing accepted deliveries.", dependencies: [], skillIds: [],
            requiredCapabilities: repair === "figure" ? fileCapabilities : ["conversation_delivery"], targetIds: [repair!],
            successCriteria: [{ id: "remaining-result", description: "Fulfill the remaining requirement.", source: "task" as const }],
          }] };
          // Missing open targets and reassigning accepted ones remain forbidden.
          for (const targetIds of [[], ["figure", "findings"]]) assert.throws(() => admitPlan({ runId: input.runId,
            canonicalState: input.canonicalState, currentPlan: input.plan, availableSkills: [],
            availableToolNames: new Set(["computer_write_file", "verify_artifact_acceptance"]),
            proposal: { ...proposal, steps: [{ ...proposal.steps[0], targetIds }] } }), /missing|already has an assessed realization/);
          return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan" as const,
            rationale: "The accepted delivery is Run-owned; repair only the open target.", evidenceRefs: [], planRevision: proposal };
        } }),
        planRevisionAssessorFactory: () => ({ assess: async input => {
          assert.deepEqual(input.proposal.steps.map((step) => step.id), ["repair"]);
          assert.deepEqual(input.canonicalState!.targets[acceptedBefore!.targetId], acceptedBefore);
          return { approved: true, feedback: "", evidenceRefs: [] };
        } }),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          if (request.runId.startsWith("conversation-turn:")) return { content: "", finishReason: "tool_calls", toolCalls: [{
            id: "resolve", name: "resolve_conversation_turn", arguments: { mode: "execute", relation: "new_goal", inputMode: "none",
              effectiveGoal: goal, evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
              userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [], taskIntent: {
                schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true, deliverables,
              } },
          }] };
          const frame = JSON.parse(request.runtimeContext!.content.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]);
          const stepId = frame.currentDecisionView.identity.stepId;
          if (stepId === "findings-producer" && !request.messages.some(message => message.role === "tool" && message.name === "read_result")) {
            const resultId = request.runtimeContext!.content.match(/"resultId":"(rr_[0-9a-f-]{36})"/)![1];
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "consume-figure", name: "read_result", arguments: { resultId } }] };
          }
          const needsFile = stepId === "mixed" || stepId === "figure-producer" || repair === "figure";
          if (needsFile && !writtenSteps.has(stepId)) {
            writtenSteps.add(stepId);
            writes += 1;
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `write-${stepId}`, name: "computer_write_file",
              arguments: { path: `${stepId}.html`, content: html, deliveryTargetId: "figure" } }] };
          }
          return { content: stepId === "mixed" ? originalAnswer : repair === "figure" ? "The corrected figure is ready." : "The difference is 2; both observations are supplied by the user.",
            finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.executeConversation("owner", goal, { allowDangerousTools: true }).catch(async error => {
        if (error.details?.runId) error.message += JSON.stringify((await runs.events("owner", error.details.runId))
          .filter(event => /failed|rejected/.test(event.type)));
        throw error;
      });
      const events = await runs.events("owner", run.id);
      assert.equal(run.status, "completed", JSON.stringify(events.filter((event) => /failed|rejected/.test(event.type))));
      assert.equal(recoveries, repair === undefined ? 0 : 1);
      assert.equal(writes, repair === "figure" ? 2 : 1, "accepted files are not regenerated");
      const state = await new CanonicalRunStateRepository(database).get(run.id);
      assert.equal(state.phase, "completed");
      assert.ok(Object.values(state.targets).every((target) => acceptedCanonicalDelivery(target) !== undefined));
      if (acceptedBefore !== undefined) assert.deepEqual(state.targets[acceptedBefore.targetId], acceptedBefore, "preserve the exact accepted realization and binding");
      assert.ok(run.output!.includes(state.targets.figure.artifactBinding!.path), "every accepted file reaches the final output regardless of scheduling position");
      if (repair === "findings") assert.match(run.output!, /mixed\.html/);
      if (repair === "figure") assert.ok(run.output!.includes(originalAnswer), "the retired Step's accepted conversation delivery remains visible");
      const plan = await new PlanRepository(database).getByRun(run.id);
      if (repair !== undefined) assert.ok(plan.steps.find((step) => step.id === "mixed")?.retiredAt);
      const target = state.targets.figure;
      assert.equal(await readFile(join(String(events.find((event) => event.type === "run.started")!.data.workspaceRoot), target.artifactBinding!.path), "utf8"), html);
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const change of ["modified", "deleted", "hashless_write", "same_content_write", "same_content_read"] as const) test(`a retired producer's acceptance follows the current physical identity (${change})`, () => {
  const base = initialState();
  const artifact = { path: "figure.html", bytes: 100, sha256: "a".repeat(64), versionId: "v1", observedByToolCallId: "write", acceptanceToolCallId: "verify" };
  const target: CanonicalDeliveryTarget = { ...base.targets.figure, status: "accepted", ownerStepIds: ["retired"],
    artifactBinding: { ...artifact, stepId: "retired", declarationId: "binding", boundAt: 1 },
    claims: [{ stepId: "retired", assessmentId: "assessment", evidenceRefs: ["write", "verify"], artifact, acceptedAt: 2 }] };
  const state = { ...base, targets: { ...base.targets, figure: target }, gaps: base.gaps.map((gap) => gap.targetId === "figure" ? { ...gap, status: "resolved" as const, resolvedAt: 2 } : gap) };
  const observations = deriveWorkProductObservations({ runId: base.runId, workspaceId: "workspace", events: [{ runId: base.runId, workspaceId: "workspace", seq: 1,
    evidence: { toolCallId: "later", toolName: change === "same_content_read" ? "computer_read_json" : "computer_run_command", isError: false,
      result: JSON.stringify(change === "same_content_read" ? artifact : { exitCode: 0,
        fileChanges: [{ path: artifact.path, changeType: change === "deleted" ? "deleted" : "modified",
          ...(change === "modified" ? { bytes: 200, sha256: "b".repeat(64) } : change === "same_content_write" ? { bytes: artifact.bytes, sha256: artifact.sha256 } : {}) }] }) } }] });
  const next = reconcileCanonicalDeliveryTargetBindings(state, { stepId: "repair-other-target", bindings: [], observations });
  if (change === "same_content_read") {
    assert.equal(next, state, "reading the accepted bytes preserves the exact realization");
    return;
  }
  assert.equal(next.targets.figure.status, "open");
  assert.equal(next.targets.figure.artifactBinding, undefined);
  assert.equal(next.gaps.find((gap) => gap.targetId === "figure")!.status, "open");
  assert.deepEqual(next.targets.figure.claims, target.claims, "historical acceptance remains auditable");
});
