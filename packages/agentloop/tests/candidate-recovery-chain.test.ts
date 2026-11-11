import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { RunService, repairLeafForFailedBoundary } from "../src/runtime/run-service.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { AppError } from "../src/shared/errors.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

for (const finish of ["complete", "stop"] as const) {
  test(`revised prerequisites converge, unread Result rejection persists the shared Gap, and recovery can ${finish}`, async () => {
    const database = new AppDatabase(":memory:");
    let gapId = "";
    let recoveries = 0;
    let observations = 0;
    let candidates = 0;
    let factCompletionFenced = false;
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
              assert.match(context, /Historical rejection feedback \(audit context, not additional current-step obligations\)/);
              assert.match(context, /leave downstream production and delivery to their owning steps/);
              return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "observe", name: "observe_total", arguments: {} }] };
            }
            assert.equal(frame.mode, "terminal_candidate", "the source stage must converge before performing downstream work");
            factCompletionFenced = true;
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
      assert.equal(factCompletionFenced, true);
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
        const repairing = request.messages.some(message => message.role === "user" && message.content.includes("Continue the same unresolved canonical GoalGap"));
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
