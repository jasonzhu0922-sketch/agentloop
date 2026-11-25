import { runtimePersistence } from "../src/storage/runtime-records.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import { AppError } from "../src/shared/errors.ts";
import { RecoveryRepository } from "../src/runtime/recovery-repository.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { ModelPlanRevisionAssessor } from "../src/runtime/recovery-planning.ts";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

for (const mode of ["parse", "admission", "assessment", "assessment-format", "exhaustion", "commit", "stale", "cancel"] as const) {
  test(`recovery revision ${mode}: preserves the goal, diagnoses candidates and commits consistently`, async () => {
    const database = new AppDatabase(":memory:");
    const root = await mkdtemp(join(tmpdir(), "recovery-workflow-"));
    let proposals = 0;
    let assessments = 0;
    let corrections = 0;
    let injected = false;
    const persistence = runtimePersistence(database);
    const originalUpdate = persistence.records.update.bind(persistence.records);
    persistence.records.update = async (table, where, change) => {
      if (mode === "commit" && table === "recovery_decisions" && !injected) {
        injected = true;
        throw new AppError("CONFLICT", "Injected failure while admitting the recovery decision", 409);
      }
      return await originalUpdate(table, where, change);
    };
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root, maxSteps: 5,
      plannerFactory: singleStepTestPlanner,
      assessorFactory: () => ({ assess: async input => {
        const approved = await approvingTestAssessor().assess(input);
        if (input.step.id !== "test-step") return approved;
        return { ...approved, approved: false,
          criteria: approved.criteria.map(criterion => ({ ...criterion, satisfied: false })),
          feedback: "Preserve the user's request and repair the explanation.",
          failedBoundary: { stepId: input.step.id, suggestedRepairShape: "revise_plan" as const,
            missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [] } };
      } }),
      planRevisionAssessorFactory: adapter => mode === "assessment-format" ? new ModelPlanRevisionAssessor(adapter) : ({ assess: async (input, signal) => {
        assessments++;
        if (mode === "cancel") {
          assert.ok(signal);
          await runs.cancel("owner", input.runId);
          assert.equal(signal.aborted, true);
        }
        if (mode === "stale") {
          const repository = new CanonicalRunStateRepository(database);
          const state = await repository.get(input.runId);
          await repository.commit({ expectedRevision: state.revision,
            state: { ...state, revision: state.revision + 1 }, reason: "concurrent_state_change" });
        }
        return { approved: !(mode === "assessment" && assessments === 1),
          feedback: "The repair must preserve the concrete explanation, not replace it with a status notice.",
          evidenceRefs: ["explanation-obligation"] };
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.tools[0]?.name === "submit_plan_revision_assessment") {
          assessments++;
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `assessment-${assessments}`,
            name: "submit_plan_revision_assessment", arguments: {
              approved: assessments === 1 ? "invalid" : true, feedback: "Preserve the explanation.", evidenceRefs: [],
            } }] };
        }
        if (request.tools[0]?.name !== "submit_recovery_decision") {
          return { content: "The concrete explanation is supplied.", finishReason: "stop", toolCalls: [] };
        }
        proposals++;
        const context = JSON.parse(request.runtimeContext!.content);
        if (proposals > 1) {
          const diagnostic = context.revisionFeedback.at(-1);
          assert.equal(diagnostic.stage, mode.startsWith("assessment") ? "assessment" : mode === "parse" ? "parse" : "admission");
          assert.ok(diagnostic.proposal.planRevision.steps.length > 0);
          assert.ok(diagnostic.feedback.length > 0);
          if (mode === "assessment") {
            assert.match(diagnostic.feedback, /concrete explanation/);
            assert.deepEqual(diagnostic.evidenceRefs, ["explanation-obligation"]);
          }
          corrections++;
        }
        const failed = context.currentPlan.steps.find((step: any) => step.id === "test-step");
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `proposal-${proposals}`,
          name: "submit_recovery_decision", arguments: {
            actionId: context.recoveryAction.id, expectedActionRevision: context.recoveryAction.revision,
            decision: "revise_plan", rationale: "Repair the explanation without weakening its result.", evidenceRefs: [],
            planRevision: { goal: context.currentPlan.goal, selectedSkillIds: [], retainedStepIds: [], shape: "recovery_patch",
              steps: [{ id: mode === "parse" && proposals === 1 ? "test-step" : "explanation-repaired",
                objective: failed.objective, dependencies: [], skillIds: [],
                requiredCapabilities: mode === "exhaustion" || mode === "admission" && proposals === 1
                  ? ["nonexistent-capability"] : ["conversation_delivery"],
                targetIds: failed.executionBinding.targetIds,
                successCriteria: [{ id: "explanation", description: "Deliver the requested concrete explanation.", source: "task" }] }] },
          } }] };
      } }),
    });
    try {
      const run = await runs.execute("owner", "Explain the supplied statement clearly.");
      const events = await runs.events("owner", run.id);
      const recoveryRequests = events.filter(event => event.type === "model.request.started"
        && event.data.purpose === "recovery_planning");
      assert.equal(recoveryRequests.length, proposals);
      for (const event of recoveryRequests) {
        const composition = event.data.contextComposition as Record<string, any>;
        assert.equal(composition.schema, "agentloop.modelContextComposition/v1");
        assert.equal(composition.phase, "planning");
        assert.equal(composition.totalCharacters, Object.values(composition.componentCharacters).reduce((sum: number, value) => sum + Number(value), 0));
      }
      if (mode === "assessment-format") {
        assert.ok(events.some(event => event.type === "model.request.started"
          && event.data.purpose === "recovery_plan_revision_assessment"
          && (event.data.contextComposition as Record<string, unknown>)?.phase === "assessment"));
      }
      const plan = (await runs.plan("owner", run.id)).plan;
      const state = await new CanonicalRunStateRepository(database).get(run.id);
      const detail = await runs.recoveryForRun("owner", run.id);
      if (["parse", "admission", "assessment", "assessment-format"].includes(mode)) {
        assert.equal(run.status, "completed", JSON.stringify(events.filter(e => /failed/.test(e.type))));
        assert.equal(proposals, 2);
        assert.equal(corrections, 1);
        assert.equal(plan.version, 2);
        assert.equal(detail.decisions.filter(d => d.state === "admitted").length, 1);
        assert.equal(events.filter(e => e.type === "recovery.plan_revision_applied").length, 1);
        assert.ok(state.gaps.every(gap => gap.status === "resolved"));
        assert.equal(state.gaps.find(gap => gap.stepId !== undefined)?.repairAttempts, 1,
          "Candidate corrections must not consume or reset the execution repair budget");
      } else if (mode === "exhaustion") {
        assert.equal(run.status, "failed");
        assert.equal(proposals, 3);
        assert.equal(plan.version, 1);
        assert.equal(events.filter(e => e.type === "recovery.proposal_rejected").length, 3);
        assert.ok(state.gaps.some(gap => gap.status === "open"));
        assert.equal(detail.decisions.every(d => d.state === "rejected"), true);
      } else {
        assert.equal(run.status, mode === "cancel" ? "cancelled" : "failed");
        assert.equal(plan.version, 1);
        assert.equal(state.plan!.version, 1);
        assert.equal(events.some(e => e.type === "recovery.plan_revision_applied"), false);
        assert.equal(detail.decisions.some(d => d.state === "admitted"), false);
        assert.equal(assessments, 1);
      }
    } finally { await database.close(); }
  });
}

test("candidate reservations are serialized and survive reopening the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-budget-"));
  const path = join(root, "runtime.db");
  let database = new AppDatabase(path);
  try {
    await database.prepare("INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at) VALUES ('budget', 'owner', 0, 0, 'running', 'Answer', 1)").run();
    const action = await new RuntimeActionRepository(database).requireRecoveryReview({ runId: "budget", reason: "interrupted" });
    const recovery = new RecoveryRepository(database);
    assert.deepEqual(await Promise.all([1, 2].map(() => recovery.beginProposalAttempt("budget", action.id, action.revision, 3))), [1, 2]);
    await database.close();
    database = new AppDatabase(path);
    const reopened = new RecoveryRepository(database);
    assert.equal(await reopened.beginProposalAttempt("budget", action.id, action.revision, 3), 3);
    await assert.rejects(reopened.beginProposalAttempt("budget", action.id, action.revision, 3),
      (error: unknown) => error instanceof AppError && error.details?.recoveryProposalBudgetExhausted === true);
  } finally { await database.close(); }
});

test("a second failed repair corrects illegal parent and rewritten Step drafts before completing from the original Result", async () => {
  const database = new AppDatabase(":memory:");
  let sourceReads = 0;
  let recoveryCalls = 0;
  let resultId = "";
  try {
    const runs = new RunService({
      database, skills: new SkillService(database), maxSteps: 5,
      plannerFactory: () => ({ plan: async task => ({ goal: task.canonicalState.intent.userInput, selectedSkillIds: [], steps: [
        { id: "facts", objective: "Acquire the immutable source once.", role: "fact_acquisition", dependencies: [], targetIds: [],
          skillIds: [], requiredCapabilities: ["source.observe"], evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "none" },
          successCriteria: [{ id: "facts", description: "Publish the immutable source.", source: "planner" }] },
        { id: "delivery", objective: "Deliver the result from the immutable source.", dependencies: ["facts"],
          skillIds: [], requiredCapabilities: ["conversation_delivery"], targetIds: Object.keys(task.canonicalState.targets),
          successCriteria: [{ id: "delivery", description: "Deliver the accepted result.", source: "task" }] },
      ] }) }),
      tools: [{ name: "observe_source", description: "Observe immutable source", inputSchema: { type: "object" }, replaySafe: true,
        executionMode: "parallel", source: { id: "source", transport: "api", capabilities: [{ id: "source.observe", category: "source_acquisition",
          sourceKinds: ["api"], producesEvidenceKinds: ["source_summary"] }] }, parse: value => value,
        execute: async () => ({ value: 42, sourceRead: ++sourceReads,
          evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } } }) }],
      assessorFactory: () => ({ assess: async input => {
        const approved = await approvingTestAssessor().assess(input);
        if (input.step.id === "delivery" || input.step.id === "delivery.repair.1") return { ...approved, approved: false,
          criteria: approved.criteria.map(criterion => ({ ...criterion, satisfied: false })), feedback: "Reuse the source Result and repair delivery.",
          failedBoundary: { stepId: input.step.id, suggestedRepairShape: "revise_plan" as const,
            missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [resultId] } };
        return approved;
      } }),
      planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [resultId] }) }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.tools[0]?.name === "submit_recovery_decision") {
          recoveryCalls += 1;
          const context = JSON.parse(request.runtimeContext!.content);
          const failedId = context.failedBoundary.stepId as string;
          const nextId = failedId === "delivery" ? "delivery.repair.1" : "delivery.repair.2";
          const revision = { goal: context.currentPlan.goal, selectedSkillIds: [], retainedStepIds: ["facts"], shape: "recovery_patch",
            steps: [{ id: nextId, objective: "Deliver from the original persisted source Result.", dependencies: ["facts"],
              inputResultRefs: [{ schema: "agentloop.resultRef/v1", resultId }], skillIds: [], requiredCapabilities: ["conversation_delivery"],
              targetIds: context.currentPlan.steps.find((step: any) => step.id === failedId).executionBinding.targetIds,
              successCriteria: [{ id: "delivery", description: "Deliver the accepted result.", source: "task" }] }] } as any;
          if (failedId === "delivery.repair.1") {
            const attempt = context.revisionFeedback.length + 1;
            if (attempt === 1) revision.steps[0].parentId = "delivery";
            if (attempt === 2) revision.steps.push({ ...revision.steps[0], id: "delivery.repair.1", objective: "rewritten old Step" });
            if (attempt === 3) {
              revision.stepReplacements = [{ stepId: "delivery.repair.1", replacementStepId: "delivery.repair.2" }];
              assert.equal(context.revisionFeedback[0].correction.invalidField, "planRevision.steps[].parentId");
              assert.deepEqual(context.revisionFeedback[0].correction.retiredPersistedStepIds, ["delivery"]);
              assert.equal(context.revisionFeedback[1].correction.invalidField, "planRevision.steps[].id");
              assert.match(request.systemPrompt, /parentId expresses only the structural milestone tree/);
            }
          }
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `recovery-${recoveryCalls}`, name: "submit_recovery_decision", arguments: {
            actionId: context.recoveryAction.id, expectedActionRevision: context.recoveryAction.revision, decision: "revise_plan",
            rationale: "Reuse the persisted source and replace only the failed delivery leaf.", evidenceRefs: [resultId], planRevision: revision,
          } }] };
        }
        const context = request.runtimeContext?.content ?? "";
        const frame = JSON.parse(context.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]);
        const stepId = frame.currentDecisionView.identity.stepId;
        const observed = request.messages.find(message => message.role === "tool" && message.name === "observe_source");
        if (observed !== undefined) resultId = String(observed.content).match(/"resultId":"(rr_[0-9a-f-]{36})"/)?.[1] ?? resultId;
        if (stepId === "facts") {
          if (sourceReads === 0) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "source-once", name: "observe_source", arguments: {} }] };
          return { content: "source value 42", finishReason: "stop", toolCalls: [] };
        }
        const unreadResultId = frame.currentDecisionView.currentGap.unreadResultRefs?.[0]?.resultId;
        if (unreadResultId !== undefined) {
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `read-${stepId}-${unreadResultId}`, name: "read_result", arguments: { resultId: unreadResultId } }] };
        }
        return { content: stepId === "delivery.repair.2" ? "Delivered value 42." : "Incomplete delivery.", finishReason: "stop", toolCalls: [] };
      } }),
    });
    let run;
    try {
      run = await runs.execute("owner", "Acquire one immutable value and deliver it.");
    } catch (error) {
      if (!(error instanceof AppError) || typeof error.details?.runId !== "string") throw error;
      run = await runs.get("owner", error.details.runId);
    }
    const events = await runs.events("owner", run.id);
    assert.equal(run.status, "completed", JSON.stringify(events.filter(event => /failed|rejected/.test(event.type))));
    assert.equal(sourceReads, 1);
    assert.equal(events.filter(event => event.type === "recovery.proposal_rejected").length, 2);
    assert.deepEqual(events.filter(event => event.type === "recovery.proposal_rejected").map(event => event.data.stage), ["admission", "parse"]);
    assert.equal(events.filter(event => event.type === "recovery.decision_admitted").length, 2);
    assert.equal(events.filter(event => event.type === "recovery.plan_revision_applied").length, 2);
    assert.equal(events.filter(event => event.type === "terminal.delivery_committed").length, 1);
    assert.equal(events.filter(event => event.type === "run.completed").length, 1);
    assert.equal(events.some(event => event.type === "run.failed"), false);
  } finally { database.close(); }
});

for (const pending of [false, true]) {
  test(`interrupted recovery exposes authorized unselected Skills and resumes after reopening; pending=${pending}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "recovery-reopen-"));
    const path = join(root, "runtime.db");
    let database = new AppDatabase(path);
    let streams = 0;
    let plannerCalls = 0;
    let loaded = false;
    const model: ModelAdapter = { limits: TEST_MODEL_LIMITS,
      complete: async request => {
        plannerCalls++;
        assert.equal(pending, false, "Persisted pending decisions must be revalidated without regenerating a candidate");
        const context = JSON.parse(request.runtimeContext!.content);
        assert.ok(context.availableTools.some((tool: any) => tool.name === "load_skill"));
        assert.ok(context.availableSkills.some((item: any) => item.id === skill.id));
        assert.ok(context.availableCapabilities.some((item: any) => item.id === "conversation_delivery"));
        assert.deepEqual(context.currentPlan.selectedSkillIds, []);
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "revision", name: "submit_recovery_decision",
          arguments: makeProposal(context.recoveryAction, context.currentPlan) }] };
      },
      streamComplete: async () => {
        streams++;
        if (streams === 1) throw new AppError("MODEL_ERROR", "Model provider returned an unreadable streaming response", 502, {
          streamFailureStage: "read", streamReceipt: { schema: "agentloop.modelStreamReceipt/v1", transport: "sse", httpStatus: 200,
            rawBytes: 1, rawSha256: "b".repeat(64), readChunkCount: 1, sseEventCount: 1, jsonEventCount: 1,
            nonJsonEventCount: 0, doneEventCount: 0, unrecognizedJsonEventCount: 0, unterminatedFinalEventBytes: 0,
            finishReasonObserved: false, sinkEmissionObserved: true, observedDeltaFields: ["content"], anomalyReasons: ["stream_consumption_failed"] },
        });
        if (!loaded) {
          loaded = true;
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "load-authorized", name: "load_skill", arguments: { name: skill.name } }] };
        }
        return { content: "The statement is explained clearly.", finishReason: "stop", toolCalls: [] };
      },
    };
    const skills = new SkillService(database);
    const skill = await skills.create("owner", { name: "clear-explanation", description: "Explain supplied statements clearly.", instructions: "Give a concrete explanation of the supplied statement." });
    const options = () => ({ database, workspaceRoot: root, skills: new SkillService(database), modelFactory: () => model,
      plannerFactory: () => ({ plan: async (task: Parameters<ReturnType<typeof singleStepTestPlanner>["plan"]>[0]) => {
        const proposal = await singleStepTestPlanner().plan(task);
        return { ...proposal, selectedSkillIds: [], selectedSkillRoles: [], steps: proposal.steps.map(step => ({ ...step, skillIds: [] })) };
      } }), assessorFactory: approvingTestAssessor,
      planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
    });
    const makeProposal = (action: { id: string; revision: number }, plan: any) => ({
      actionId: action.id, expectedActionRevision: action.revision, decision: "revise_plan" as const,
      rationale: "Bind the already-authorized explanation Skill and complete the interrupted answer.", evidenceRefs: [],
      planRevision: { goal: plan.goal, selectedSkillIds: [skill.id], retainedStepIds: [], shape: "recovery_patch" as const,
        steps: [{ id: "new-explanation", objective: plan.goal, dependencies: [], skillIds: [skill.id],
          requiredCapabilities: ["conversation_delivery"], targetIds: plan.steps[0].executionBinding.targetIds,
          successCriteria: [{ id: "explanation", description: "Explain the supplied statement.", source: "task" as const }] }] },
    });
    try {
      const original = new RunService(options());
      const paused = await original.execute("owner", "Explain the supplied statement clearly.");
      assert.equal(paused.status, "running");
      if (pending) {
        const detail = await original.recoveryForRun("owner", paused.id);
        const plan = (await original.plan("owner", paused.id)).plan;
        const recovery = new RecoveryRepository(database);
        await recovery.beginProposalAttempt(paused.id, detail.action!.id, detail.action!.revision, 3);
        await recovery.submit(paused.id, makeProposal(detail.action!, plan));
      }
      await database.close();
      database = new AppDatabase(path);
      const resumed = new RunService(options());
      await resumed.advanceRecovery("owner", paused.id);
      const run = await resumed.get("owner", paused.id);
      const events = await resumed.events("owner", paused.id);
      assert.equal(run.status, "completed", JSON.stringify(events.filter(event => /failed|rejected/.test(event.type))));
      assert.equal(plannerCalls, pending ? 0 : 1);
      assert.equal(events.filter(event => event.type === "model.request.started"
        && event.data.purpose === "recovery_planning").length, pending ? 0 : 1);
      assert.ok(events.some(event => event.type === "tool.completed" && event.data.toolName === "load_skill"), JSON.stringify(events.filter(event => /tool|assistant.committed/.test(event.type))));
      assert.equal(events.filter(event => event.type === "recovery.plan_revision_applied").length, 1);
      assert.equal(events.filter(event => event.type === "recovery.proposal_attempt_started").length, 1);
      await assert.rejects(resumed.advanceRecovery("owner", paused.id), /Only a running Run/);
      assert.equal((await resumed.plan("owner", paused.id)).plan.version, 2);
    } finally { await database.close(); }
  });
}
