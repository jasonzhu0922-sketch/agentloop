import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { RunService, repairLeafForFailedBoundary } from "../src/runtime/run-service.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { AppError } from "../src/shared/errors.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const continuation of ["stop", "alternate"] as const) {
  test(`a blocked source follows the canonical Recovery chain with its failed Result: ${continuation}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "blocked-source-recovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const database = new AppDatabase(":memory:");
    t.after(() => database.close());
    let primaryReads = 0, alternativeReads = 0, assessments = 0, recoveries = 0, reports = 0;
    let failureResultId = "", gapId = "";
    const source = { id: "authorized-source", transport: "api" as const, capabilities: [{ id: "source.observe",
      category: "source_acquisition" as const, sourceKinds: ["api" as const], producesEvidenceKinds: ["source_summary" as const] }] };
    const runs = new RunService({ database, workspaceRoot: root, skills: new SkillService(database), maxSteps: 16,
      plannerFactory: () => ({ plan: async task => {
        const plan = await singleStepTestPlanner().plan(task);
        return { ...plan, steps: plan.steps.map(step => ({ ...step, requiredCapabilities: ["source.observe", "conversation_delivery"],
          evidenceContract: { requiredKinds: ["source_summary" as const], caveatPolicy: "none" as const } })) };
      } }),
      tools: [{ name: "read_primary", description: "Read the primary endpoint", inputSchema: { type: "object" }, source,
        executionMode: "parallel", replaySafe: true, parse: value => value,
        execute: async () => { primaryReads += 1; return { exitCode: 1, stdout: '{"status":"unavailable","phase":"source.read"}', stderr: "" }; } },
      ...(continuation === "alternate" ? [{ name: "read_alternate", description: "Read the authorized independent endpoint", inputSchema: { type: "object" }, source,
        executionMode: "parallel" as const, replaySafe: true, parse: (value: unknown) => value,
        execute: async () => { alternativeReads += 1; return { total: 42,
          evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } } }; } }] : [])],
      assessorFactory: () => ({ assess: async input => {
        assessments += 1;
        const assessment = await approvingTestAssessor().assess(input);
        if (alternativeReads > 0) return assessment;
        const failure = input.evidence.toolCalls.find(call => call.toolName === "read_primary")!;
        assert.ok(failure.resultRef, "the failed operation must be formally referenceable");
        failureResultId = failure.resultRef.resultId;
        return { ...assessment, approved: false, feedback: "The requested total is unobserved; the primary path is blocked.",
          criteria: assessment.criteria.map(criterion => ({ ...criterion, satisfied: false })),
          failedBoundary: { stepId: input.step.id, missingEvidenceKinds: ["source_summary" as const],
            violatedSkillRequirements: [], reusableEvidenceRefs: [failureResultId],
            suggestedRepairShape: "repair_leaf" as const, repairPrerequisite: "external_change" as const } };
      } }),
      recoveryPlannerFactory: () => ({ decide: async input => {
        recoveries += 1;
        assert.equal(input.failedBoundary?.repairPrerequisite, "external_change");
        assert.equal(input.canonicalGap?.repairPrerequisite, "external_change");
        gapId = input.canonicalGap!.id;
        assert.ok(input.availableResults?.some(result => result.result.resultId === failureResultId));
        const stored = (await new CanonicalRunStateRepository(database).get(input.runId)).gaps.find(gap => gap.id === gapId)!;
        assert.equal(stored.repairPrerequisite, "external_change");
        const base = { actionId: input.action.id, expectedActionRevision: input.action.revision, evidenceRefs: [failureResultId] };
        if (continuation === "stop") return { ...base, decision: "fail" as const, rationale: "No authorized independent source is available; stop until conditions change." };
        const failed = input.plan!.steps.find(step => step.id === input.failedBoundary!.stepId)!;
        const repair = repairLeafForFailedBoundary(failed, input.failedBoundary!, input.plan!.version);
        return { ...base, decision: "revise_plan" as const,
          rationale: "Inspect the failed observation, then read the authorized independent endpoint once; stop if it also fails.",
          planRevision: { schema: "agentloop.outcomePlan/v2" as const, shape: "recovery_patch" as const,
            goal: input.plan!.goal, selectedSkillIds: [], steps: [{ ...repair, id: "alternate-source",
              inputResultRefs: [{ schema: "agentloop.resultRef/v1" as const, resultId: failureResultId }] }] } };
      } }),
      planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "The independent endpoint can establish the same total.", evidenceRefs: [failureResultId] }) }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          reports += 1; assert.deepEqual(request.tools, []);
          return { content: "The requested total could not be read; the source remains unavailable.", finishReason: "stop", toolCalls: [] };
        }
        if (recoveries > 0) {
          if (!request.messages.some(message => message.role === "tool" && message.name === "read_result")) {
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "inspect-failure", name: "read_result", arguments: { resultId: failureResultId } }] };
          }
          if (alternativeReads === 0) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "alternate-read", name: "read_alternate", arguments: {} }] };
          return { content: "The total is 42 from the authorized independent endpoint.", finishReason: "stop", toolCalls: [] };
        }
        if (primaryReads === 0) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "primary-read", name: "read_primary", arguments: {} }] };
        return { content: "The source could not be read.", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.execute("owner", "Read the total from the authorized source.");
    const events = await runs.events("owner", run.id);
    const diagnostic = JSON.stringify(events.filter(event => /failed|rejected/.test(event.type)));
    assert.equal(run.status, continuation === "stop" ? "failed" : "completed", diagnostic);
    assert.equal(primaryReads, 1);
    assert.equal(alternativeReads, continuation === "stop" ? 0 : 1);
    assert.equal(assessments, continuation === "stop" ? 1 : 2);
    assert.equal(recoveries, 1);
    assert.equal(reports, continuation === "stop" ? 1 : 0);
    assert.ok(events.some(event => event.type === "candidate.repair_stopped"));
    const gap = (await new CanonicalRunStateRepository(database).get(run.id)).gaps.find(gap => gap.id === gapId)!;
    assert.equal(gap.status, continuation === "stop" ? "open" : "resolved");
    assert.equal(events.filter(event => event.type === "terminal.delivery_committed").length, continuation === "stop" ? 0 : 1);
  });
}

test("artifact repair stagnation creates one canonical Gap and Recovery completes a different construction plan", async t => {
  const root = await mkdtemp(join(tmpdir(), "artifact-repair-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const goal = "Create an HTML training document from the supplied text: structured authoring preserves content.";
  const deliverables = [{ targetId: "training", purpose: "The HTML training document", expectedArtifactCount: 1,
    action: "create" as const, kind: "html" as const, surface: "workspace_artifact" as const }];
  const capabilities = ["workspace_artifact_write", "artifact_acceptance", "construction_probe"];
  let turns = 0, recoveries = 0, repaired = false, failureReports = 0;
  const runs = new RunService({ database, workspaceRoot: root, skills: new SkillService(database), maxSteps: 64,
    tools: [{ name: "construction_probe", effect: "write", description: "Probe artifact construction", inputSchema: { type: "object" },
      source: { id: "construction", capabilities: [{ id: "construction_probe", category: "artifact_build" }] },
      executionMode: "exclusive", replaySafe: false, parse: value => value,
      execute: async () => { throw new AppError("BAD_REQUEST", `unrepaired construction error ${turns}`, 400); } }],
    plannerFactory: () => ({ plan: async () => ({ goal, selectedSkillIds: [], steps: [{ id: "training", objective: goal,
      dependencies: [], skillIds: [], requiredCapabilities: capabilities, targetIds: ["training"],
      successCriteria: [{ id: "training-created", description: "Deliver an openable HTML document preserving the supplied text.", source: "task" }] }] }) }),
    assessorFactory: approvingTestAssessor,
    planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
    recoveryPlannerFactory: () => ({ decide: async input => {
      recoveries += 1;
      assert.ok(input.canonicalGap);
      assert.equal(input.action.metadata?.localRepairExhausted, true);
      assert.ok(input.events.some(event => event.type === "loop.artifact_repair_checkpoint"));
      assert.ok(input.events.some(event => event.type === "tool.completed" && event.data.toolName === "computer_write_file" && event.data.resultRef));
      const repair = repairLeafForFailedBoundary(input.plan!.steps.find(step => step.id === input.failedBoundary!.stepId)!, input.failedBoundary!, input.plan!.version);
      return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan" as const,
        rationale: "Keep the intermediate source; construct the HTML directly using the supplied content.", evidenceRefs: [],
        planRevision: { schema: "agentloop.outcomePlan/v2" as const, shape: "recovery_patch" as const,
          goal, selectedSkillIds: [], steps: [{ ...repair, id: "direct-construction" }] } };
    } }),
    modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
      if (request.runId.startsWith("conversation-turn:")) return { content: "", finishReason: "tool_calls", toolCalls: [{
        id: "resolve", name: "resolve_conversation_turn", arguments: { mode: "execute", relation: "new_goal", inputMode: "none",
          effectiveGoal: goal, evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
          userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "create_artifact", requiresExecution: true, deliverables } },
      }] };
      if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
        failureReports += 1;
        return { content: "Construction failed.", finishReason: "stop", toolCalls: [] };
      }
      if (recoveries > 0) {
        if (!repaired) {
          repaired = true;
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "direct-write", name: "computer_write_file",
            arguments: { path: "training.html", deliveryTargetId: "training", content: "<!doctype html><html><meta charset='utf-8'><title>Training</title><body><h1>Training</h1><p>Structured authoring preserves content.</p></body></html>" } }] };
        }
        return { content: "The HTML training document is ready.", finishReason: "stop", toolCalls: [] };
      }
      turns += 1;
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `repair-${turns}`,
        name: turns % 3 === 1 ? "construction_probe" : "computer_write_file",
        arguments: turns % 3 === 1 ? {} : { path: "source.json", mode: turns === 2 ? "create" : "overwrite", content: JSON.stringify({ variant: turns }) } }] };
    } }),
  });
  const run = await runs.executeConversation("owner", goal, { allowDangerousTools: true });
  const events = await runs.events("owner", run.id);
  assert.equal(run.status, "completed", JSON.stringify(events.filter(event => /failed|rejected/.test(event.type))));
  assert.equal(recoveries, 1);
  assert.equal(turns, 10);
  assert.equal(failureReports, 0, "Successful Recovery must not generate a premature failure report");
  const runWorkspace = events.find(event => event.type === "run.started")!.data.workspaceRoot as string;
  assert.ok((await readFile(join(runWorkspace, "source.json"), "utf8")).includes('"variant":9'));
  const state = await new CanonicalRunStateRepository(database).get(run.id);
  assert.equal(state.gaps.filter(gap => gap.stepId !== undefined).length, 1);
  assert.ok(state.gaps.every(gap => gap.status === "resolved"));
  assert.equal(events.some(event => event.type === "loop.limit_exceeded"), false);
  assert.equal(events.filter(event => event.type === "terminal.delivery_committed").length, 1);
});

for (const finish of ["complete", "stop"] as const) {
  test(`revised prerequisites permit Assessment, unread Result rejection persists the shared Gap, and recovery can ${finish}`, async () => {
    const database = new AppDatabase(":memory:");
    let gapId = "";
    let recoveries = 0;
    let observations = 0;
    let candidates = 0;
    let factCandidateReady = false;
    let dependencyResultId = "";
    let reports = 0;
    try {
      const runs = new RunService({ database, skills: new SkillService(database), maxSteps: 6,
        plannerFactory: singleStepTestPlanner,
        tools: [{ name: "observe_total", description: "Observe an immutable total", inputSchema: { type: "object" },
          source: { id: "totals", transport: "api", capabilities: [{ id: "totals.observe", category: "source_acquisition",
            sourceKinds: ["api"], producesEvidenceKinds: ["source_summary"] }] },
          executionMode: "parallel", replaySafe: true, parse: value => value,
          execute: async () => ({ total: 42, observation: ++observations,
            evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1",
              evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } } }) }],
        assessorFactory: () => ({ assess: async input => {
          const approved = await approvingTestAssessor().assess(input);
          if (input.step.id !== "test-step") return approved;
          return { ...approved, approved: false,
            criteria: approved.criteria.map(criterion => ({ ...criterion, satisfied: false })),
            feedback: "The observed total and final explanation are missing.",
            failedBoundary: { stepId: input.step.id, suggestedRepairShape: "revise_plan" as const,
              missingEvidenceKinds: ["explicit_caveats"], violatedSkillRequirements: [], reusableEvidenceRefs: [] } };
        } }),
        planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
        recoveryPlannerFactory: () => ({ decide: async input => {
          recoveries += 1;
          assert.ok(input.canonicalGap);
          gapId ||= input.canonicalGap.id;
          assert.equal(input.canonicalGap.id, gapId, "new rejection must retain the shared Gap identity and budget");
          const state = await new CanonicalRunStateRepository(database).get(input.canonicalState!.runId);
          const storedGap = state.gaps.find(gap => gap.id === gapId)!;
          assert.equal(storedGap.stepId, input.failedBoundary!.stepId);
          assert.equal(storedGap.status, "open");
          const failed = input.plan!.steps.find(step => step.id === input.failedBoundary!.stepId)!;
          if (recoveries === 1) {
            const answer = repairLeafForFailedBoundary(failed, input.failedBoundary!, input.plan!.version);
            return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan" as const,
              rationale: "Acquire facts once, then consume the published Result for the explanation.", evidenceRefs: [],
              planRevision: { schema: "agentloop.outcomePlan/v2" as const, shape: "recovery_patch" as const,
                goal: input.plan!.goal, selectedSkillIds: [], steps: [{ id: "repair-facts", objective: "Observe and publish the total only. Do not perform downstream delivery.",
                  dependencies: [], role: "fact_acquisition" as const, skillIds: [], requiredCapabilities: ["totals.observe"],
                  evidenceContract: { requiredKinds: ["source_summary" as const], caveatPolicy: "none" as const },
                  successCriteria: [{ id: "observed", description: "Publish the observed total for downstream use.", source: "planner" as const }] },
                { ...answer, id: "repair-answer", dependencies: ["repair-facts"], requiredCapabilities: ["conversation_delivery"] }] } };
          }
          assert.equal(recoveries, 2, "the candidate repair budget is bounded");
          assert.equal(storedGap.stepId, "repair-answer");
          assert.equal(storedGap.repairAttempts, 1);
          assert.deepEqual(storedGap.reusableEvidenceRefs, [dependencyResultId]);
          if (finish === "stop") return { actionId: input.action.id, expectedActionRevision: input.action.revision,
            decision: "fail" as const, rationale: "Stop after the bounded dependency-consumption repair.", evidenceRefs: [dependencyResultId] };
          const facts = input.plan!.steps.find(step => step.id === "repair-facts")!;
          return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan" as const,
            rationale: "Consume the existing facts instead of acquiring them again.", evidenceRefs: [dependencyResultId],
            planRevision: { schema: "agentloop.outcomePlan/v2" as const, shape: "recovery_patch" as const,
              goal: input.plan!.goal, selectedSkillIds: [], retainedStepIds: [facts.id], steps: [
                { ...repairLeafForFailedBoundary(failed, input.failedBoundary!, input.plan!.version), id: "read-and-answer" },
              ] } };
        } }),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          const context = request.runtimeContext?.content ?? "";
          if (context.includes("<runtime_failure_report>")) {
            reports += 1;
            assert.deepEqual(request.tools, []);
            assert.match(context, /agentloop.failureReportContext\/v1/);
            assert.match(context, /facts-total=42/);
            assert.match(JSON.stringify(request.messages), /observe_total/);
            return { content: "已取得总额42，最终解释尚未完成。", finishReason: "stop", toolCalls: [] };
          }
          const frame = JSON.parse(context.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]!);
          const stepId = frame.currentDecisionView?.identity.stepId ?? context.match(/"currentStepId":"([^"]+)"/)?.[1];
          if (stepId === "test-step") return { content: "Initial incomplete result", finishReason: "stop", toolCalls: [] };
          if (stepId === "repair-facts") {
            assert.notEqual(frame.currentDecisionView.nextAction, "revise_plan");
            assert.deepEqual(frame.currentDecisionView.currentGap.assessmentGaps[0].missingEvidenceKinds, ["explicit_caveats"]);
            if (observations === 0) {
              assert.match(JSON.stringify(request.messages), /Continue only the current admitted Step's objective/);
              assert.doesNotMatch(JSON.stringify(request.messages), /Initial incomplete result/);
              assert.deepEqual(frame.currentDecisionView.candidateReadiness.blockedBy, ["missing_tool_evidence"]);
              return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "observe", name: "observe_total", arguments: {} }] };
            }
            assert.equal(frame.mode, "current_to_next", "receipt readiness must not force source-stage convergence");
            assert.equal(frame.currentDecisionView.candidateReadiness.readyForAssessment, true);
            factCandidateReady = true;
            return { content: "facts-total=42", finishReason: "stop", toolCalls: [] };
          }
          dependencyResultId = context.match(/"resultId":"(rr_[0-9a-f-]{36})"/)![1]!;
          if (stepId === "repair-answer") return { content: `Unread dependency draft ${++candidates}`, finishReason: "stop", toolCalls: [] };
          assert.equal(stepId, "read-and-answer");
          if (!request.messages.some(message => message.role === "tool" && message.name === "read_result")) {
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "consume", name: "read_result", arguments: { resultId: dependencyResultId } }] };
          }
          return { content: "Observed total is 42.", finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.execute("owner", "Observe the total and explain it.");
      const diagnostic = JSON.stringify((await runs.events("owner", run.id)).filter(event => /failed|recovery/.test(event.type)));
      assert.equal(run.status, finish === "complete" ? "completed" : "failed", diagnostic);
      assert.equal(observations, 1, diagnostic);
      assert.equal(recoveries, 2);
      assert.equal(factCandidateReady, true);
      assert.equal(reports, finish === "stop" ? 1 : 0);
      const state = await new CanonicalRunStateRepository(database).get(run.id);
      const gaps = state.gaps.filter(gap => gap.stepId !== undefined);
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0].id, gapId);
      assert.equal(gaps[0].status, finish === "complete" ? "resolved" : "open");
      const plan = await new PlanRepository(database).getByRun(run.id);
      const unread = (await new PlanRepository(database).assessments(plan.id)).filter(assessment => assessment.stepId === "repair-answer");
      assert.ok(unread.length > 0);
      assert.ok(unread.every(assessment => assessment.assessmentMethod === "rule" && assessment.failedBoundary?.suggestedRepairShape === "repair_leaf"));
      const events = await runs.events("owner", run.id);
      assert.equal(events.some(event => event.type === "run.failed" && event.data.code === "CONFLICT"), false);
      assert.equal(events.filter(event => event.type === "terminal.delivery_committed").length, finish === "complete" ? 1 : 0);
    } finally { database.close(); }
  });
}

test("a recovery exception reports later committed receipts rather than the original leaf's stale draft", async () => {
  const database = new AppDatabase(":memory:");
  let observations = 0;
  let reports = 0;
  try {
    const runs = new RunService({ database, skills: new SkillService(database), plannerFactory: singleStepTestPlanner,
      tools: [{ name: "observe_artifact", description: "Observe current artifact checks", inputSchema: { type: "object" },
        executionMode: "parallel", replaySafe: true, parse: value => value,
        execute: async () => { observations += 1; return { artifact: { path: "result.png", bytes: 143656 }, verdict: "accepted", marker: "LATEST_ACCEPTED_ARTIFACT" }; } }],
      assessorFactory: () => ({ assess: async input => {
        const approved = await approvingTestAssessor().assess(input);
        return { ...approved, approved: false, criteria: approved.criteria.map(criterion => ({ ...criterion, satisfied: false })),
          feedback: "No artifact observation yet", failedBoundary: { stepId: input.step.id, missingEvidenceKinds: [],
            violatedSkillRequirements: [], reusableEvidenceRefs: [], suggestedRepairShape: "revise_plan" as const } };
      } }),
      recoveryPlannerFactory: () => ({ decide: async input => ({ actionId: input.action.id, expectedActionRevision: input.action.revision,
        decision: "revise_plan" as const, rationale: "Observe the current result", evidenceRefs: [],
        planRevision: { schema: "agentloop.outcomePlan/v2" as const, shape: "recovery_patch" as const, goal: input.plan!.goal,
          selectedSkillIds: [], steps: [repairLeafForFailedBoundary(input.plan!.steps[0]!, input.failedBoundary!, input.plan!.version)] } }) }),
      planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        const context = request.runtimeContext?.content ?? "";
        if (context.includes("<runtime_failure_report>")) {
          reports += 1;
          assert.deepEqual(request.tools, []);
          assert.match(context, /agentloop.failureReportContext\/v1/);
          assert.match(JSON.stringify(request.messages), /LATEST_ACCEPTED_ARTIFACT/);
          assert.match(context, /recovery.continuation_failed/);
          assert.match(context, /Recovery provider failed after the committed observation/);
          assert.match(JSON.stringify(request.messages), /143656/);
          return { content: "图片已生成且检查通过，后续处理失败，尚未完成交付。", finishReason: "stop", toolCalls: [] };
        }
        const frame = JSON.parse(context.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]!);
        const repairing = frame.currentDecisionView.currentGap.repairInProgressGapIds.length > 0;
        if (!repairing) return { content: "Old incomplete draft", finishReason: "stop", toolCalls: [] };
        if (observations === 0) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "latest", name: "observe_artifact", arguments: {} }] };
        throw new AppError("MODEL_ERROR", "Recovery provider failed after the committed observation", 502);
      } }),
    });
    const run = await runs.execute("owner", "Produce the result.");
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "MODEL_ERROR");
    assert.equal(run.output, "图片已生成且检查通过，后续处理失败，尚未完成交付。");
    assert.equal(reports, 1);
    const events = await runs.events("owner", run.id);
    assert.equal(events.filter(event => event.type === "failure_report.generated").length, 1);
    assert.equal(events.some(event => event.type === "terminal.delivery_committed"), false);
  } finally { database.close(); }
});
