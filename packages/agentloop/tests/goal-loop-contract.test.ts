import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { admitPlan } from "../src/planning/admission.ts";
import { ModelPlanner } from "../src/planning/planner.ts";
import { ModelStepAssessor } from "../src/planning/assessor.ts";
import { goalCriterionBasis } from "../src/planning/criterion-basis.ts";
import { bindCanonicalPlan, createCanonicalRunState, recordCanonicalAssessment, startCanonicalStep } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ModelRecoveryPlanner, parseRecoveryDecision } from "../src/runtime/recovery-planning.ts";
import { RunService, recoveryProposalSuccessCriteria } from "../src/runtime/run-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { installAssessmentProfileSchema } from "../src/storage/assessment-profile-schema.ts";
import type { SqlConnection, SqlDialect } from "../src/storage/connection.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { singleStepTestPlanner, approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import { HUMAN_LOOP_TOOL_NAME } from "../src/tools/human-loop-tool.ts";
import { AppError } from "../src/shared/errors.ts";

test("planning failure waits and resumes the same Run after reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-planning-resume-"));
  const path = join(directory, "runtime.db");
  let database = new AppDatabase(path);
  let planningCalls = 0;
  let modelCalls = 0;
  let memoryCommits = 0;
  const model = { limits: TEST_MODEL_LIMITS, complete: async () => {
    modelCalls += 1;
    return { content: "The completed result.", finishReason: "stop" as const, toolCalls: [] };
  } };
  const base = singleStepTestPlanner();
  const createService = () => new RunService({ database, workspaceRoot: directory, skills: new SkillService(database),
    memory: { name: "recovery-memory", commitExplicit: async () => { memoryCommits += 1; return { kind: "not_applicable" }; },
      recall: async () => undefined, enqueueSettlement: async () => ({ kind: "enqueued", settlementJobId: "test", enqueuedAt: 1 }) },
    modelFactory: () => model, assessorFactory: () => approvingTestAssessor(),
    plannerFactory: () => ({ plan: async (task, _signal, emit) => {
      planningCalls += 1;
      await emit?.({ type: "planning.started", data: { maxPlanningTurns: 1 } });
      await emit?.({ type: "planning.turn.started", data: { turn: 1 } });
      if (planningCalls === 1) throw new AppError("PLANNING_ERROR", "Cannot produce a valid plan", 422);
      return await base.plan(task);
    } }),
  });
  try {
    let runs = createService();
    const started = await runs.execute("owner", "Answer the requested question.");
    assert.equal(started.status, "running");
    const request = await runs.currentHumanLoop("owner", started.id);
    assert.equal(request?.origin, "planner");
    await database.close();
    database = new AppDatabase(path);
    runs = createService();
    const responses = await Promise.allSettled([
      runs.respondHumanLoop("owner", started.id, request!.id, true, request!.revision),
      runs.respondHumanLoop("owner", started.id, request!.id, true, request!.revision),
    ]);
    assert.equal(responses.filter((result) => result.status === "fulfilled").length, 1);
    for (let attempt = 0; attempt < 200 && (await runs.get("owner", started.id)).status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = await runs.get("owner", started.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.output, "The completed result.");
    assert.equal(planningCalls, 2);
    assert.equal(modelCalls, 1);
    assert.equal(memoryCommits, 1);
    const budget = await database.prepare("SELECT used_turns, max_turns FROM run_planning_budgets WHERE run_id = ?")
      .get<{ used_turns: number; max_turns: number }>(started.id);
    assert.deepEqual({ ...budget }, { used_turns: 2, max_turns: 2 });
    const events = await runs.events("owner", started.id);
    assert.equal(events.filter((event) => event.type === "run.started").length, 1);
    assert.equal(events.filter((event) => event.type === "canonical_run_state.initialized").length, 1);
    assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a safe model stream interrupted after emission enters recovery_required", async () => {
  const database = new AppDatabase(":memory:");
  const streamReceipt = {
    schema: "agentloop.modelStreamReceipt/v1",
    transport: "sse",
    httpStatus: 200,
    rawBytes: 128,
    rawSha256: "a".repeat(64),
    readChunkCount: 2,
    sseEventCount: 1,
    jsonEventCount: 1,
    nonJsonEventCount: 0,
    doneEventCount: 0,
    unrecognizedJsonEventCount: 0,
    unterminatedFinalEventBytes: 0,
    finishReasonObserved: false,
    sinkEmissionObserved: true,
    observedDeltaFields: ["content"],
    anomalyReasons: ["stream_consumption_failed"],
  };
  const model = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => ({ content: "unused", finishReason: "stop" as const, toolCalls: [] }),
    streamComplete: async (_request: import("../src/runtime/contracts.ts").ModelInvocation, sink: import("../src/runtime/contracts.ts").ModelStreamSink) => {
      await sink({ type: "text_delta", text: "partial" });
      throw new AppError("MODEL_ERROR", "Model provider returned an unreadable streaming response", 502, {
        streamFailureStage: "read",
        streamReceipt,
      });
    },
  };
  try {
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: singleStepTestPlanner,
      assessorFactory: () => approvingTestAssessor(),
    });
    const run = await runs.execute("owner", "Produce the requested result.");
    assert.equal(run.status, "running");
    const recovery = await runs.recoveryForRun("owner", run.id);
    assert.equal(recovery.state?.state, "waiting_recovery");
    assert.equal(recovery.action?.kind, "recovery_review");
    assert.equal(recovery.action?.replayPolicy, "safe");
    assert.equal(recovery.action?.metadata.reason, "model_stream_interrupted");
    const actions = await runs.actionsForRun("owner", run.id);
    assert.equal(actions.filter((action) => action.kind === "model_turn" && action.state === "failed").length, 1);
    assert.equal(actions.filter((action) => action.kind === "recovery_review" && action.state === "recovery_required").length, 1);
    const events = await runs.events("owner", run.id);
    assert.equal(events.some((event) => event.type === "run.recovery_required"), true);
    assert.equal(events.some((event) => event.type === "run.failed"), false);
    assert.equal(events.some((event) => event.type === "failure_report.generated"), false);
  } finally {
    await database.close();
  }
});

test("safe model stream recovery resumes the interrupted Step from committed evidence", async () => {
  const database = new AppDatabase(":memory:");
  let streamCalls = 0;
  const streamReceipt = {
    schema: "agentloop.modelStreamReceipt/v1",
    transport: "sse",
    httpStatus: 200,
    rawBytes: 128,
    rawSha256: "b".repeat(64),
    readChunkCount: 2,
    sseEventCount: 1,
    jsonEventCount: 1,
    nonJsonEventCount: 0,
    doneEventCount: 0,
    unrecognizedJsonEventCount: 0,
    unterminatedFinalEventBytes: 0,
    finishReasonObserved: false,
    sinkEmissionObserved: true,
    observedDeltaFields: ["content"],
    anomalyReasons: ["stream_consumption_failed"],
  };
  const model = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => ({ content: "unused", finishReason: "stop" as const, toolCalls: [] }),
    streamComplete: async (_request: import("../src/runtime/contracts.ts").ModelInvocation, sink: import("../src/runtime/contracts.ts").ModelStreamSink) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        await sink({ type: "text_delta", text: "partial" });
        throw new AppError("MODEL_ERROR", "Model provider returned an unreadable streaming response", 502, {
          streamFailureStage: "read",
          streamReceipt,
        });
      }
      await sink({ type: "text_delta", text: "recovered" });
      return { content: "recovered", finishReason: "stop" as const, toolCalls: [] };
    },
  };
  try {
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: singleStepTestPlanner,
      assessorFactory: () => approvingTestAssessor(),
      recoveryPlannerFactory: () => ({
        decide: async (input) => ({
          actionId: input.action.id,
          expectedActionRevision: input.action.revision,
          decision: "resume_step" as const,
          rationale: "The model turn has no committed external effect and can be replayed safely.",
          evidenceRefs: [],
        }),
      }),
    });
    const paused = await runs.execute("owner", "Produce the requested result.");
    assert.equal(paused.status, "running");
    const advanced = await runs.advanceRecovery("owner", paused.id);
    assert.equal(advanced.state?.state, "ready_to_resume");
    const resumed = await runs.resumeRecovery("owner", paused.id);
    assert.equal(resumed.status, "completed", resumed.output);
    assert.equal(resumed.output, "recovered");
    assert.equal(streamCalls, 2);
    const events = await runs.events("owner", paused.id);
    assert.equal(events.some((event) => event.type === "recovery.resume_started"), true);
    assert.equal(events.some((event) => event.type === "run.completed" && event.data.recovered === true), true);
  } finally {
    await database.close();
  }
});

test("two delivery targets execute in separate Rounds and final Result aggregates both Round Results", async () => {
  const database = new AppDatabase(":memory:");
  let planningCalls = 0;
  let executionCalls = 0;
  let sawPriorRoundBinding = false;
  try {
    const goal = "请分别给出交付 A 和交付 B。";
    const model = { limits: TEST_MODEL_LIMITS, complete: async (request: import("../src/runtime/contracts.ts").ModelInvocation) => {
      if (request.runId.startsWith("conversation-turn:")) return { content: "", finishReason: "tool_calls" as const, toolCalls: [{
        id: "resolve-two-targets", name: "resolve_conversation_turn", arguments: {
          mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
            deliverables: [
              { targetId: "target-a", purpose: "交付 A", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" },
              { targetId: "target-b", purpose: "交付 B", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" },
            ] },
          evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
          memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
        },
      }] };
      executionCalls += 1;
      return { content: `deliverable-${executionCalls}`, finishReason: "stop" as const, toolCalls: [] };
    } };
    const runs = new RunService({ database, skills: new SkillService(database), modelFactory: () => model,
      assessorFactory: () => approvingTestAssessor(), plannerFactory: () => ({ plan: async (task, _signal, emit) => {
        planningCalls += 1;
        await emit?.({ type: "planning.started", data: { maxPlanningTurns: 1 } });
        await emit?.({ type: "planning.turn.started", data: { turn: 1 } });
        if (task.targetScopeIds !== undefined) {
          assert.deepEqual(task.targetScopeIds, ["target-b"]);
          assert.equal(task.roundResultBindings?.length, 1);
          assert.equal(task.priorRoundResult?.schema, "agentloop.roundResultCard/v1");
          assert.equal(task.priorRoundResult?.roundNumber, 1);
          assert.equal(task.priorRoundResult?.planVersion, 1);
          assert.deepEqual(task.priorRoundResult?.decision.openTargetIds, ["target-b"]);
          assert.equal(task.priorRoundResult?.resultRefs.length, 1);
          sawPriorRoundBinding = true;
        }
        const targetId = task.targetScopeIds?.[0] ?? "target-a";
        return { goal, shape: "multi_deliverable", selectedSkillIds: [],
          roundScope: { kind: "delivery", targetIds: [targetId], purpose: `Fulfill ${targetId}`, completionBoundary: `Deliver ${targetId}`, continuation: "Complete remaining targets after this delivery." }, steps: [{
          id: `round-${planningCalls}-deliver`, objective: `Fulfill ${targetId}`,
          dependencies: [], role: "deliver", skillIds: [], requiredCapabilities: ["conversation_delivery"], targetIds: [targetId],
          successCriteria: [{ id: `deliver-${targetId}`, description: `Deliver ${targetId}`, source: "task" }],
        }] };
      } }) });
    const started = await runs.executeConversation("owner", goal);
    for (let attempt = 0; attempt < 400 && (await runs.get("owner", started.id)).status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = await runs.get("owner", started.id);
    assert.equal(finished.status, "completed", finished.output);
    assert.equal(planningCalls, 2);
    assert.equal(executionCalls, 2);
    assert.equal(sawPriorRoundBinding, true);
    const rounds = await database.prepare("SELECT round_number, status, plan_id FROM run_rounds WHERE run_id = ? ORDER BY round_number")
      .all<{ round_number: number; status: string; plan_id: string }>(started.id);
    assert.equal(rounds.length, 2);
    assert.deepEqual(rounds.map((round) => ({ round: round.round_number, status: round.status })), [
      { round: 1, status: "completed" }, { round: 2, status: "completed" },
    ]);
    const resultRows = await database.prepare("SELECT result_json FROM run_round_results WHERE run_id = ? ORDER BY round_number")
      .all<{ result_json: string }>(started.id);
    assert.equal(resultRows.length, 2);
    const roundResults = resultRows.map((row) => JSON.parse(row.result_json));
    assert.deepEqual(roundResults.map((result) => result.decision.kind), ["next_round", "complete_goal"]);
    assert.equal(roundResults[0].decision.openTargetIds[0], "target-b");
    assert.deepEqual((await runs.roundHistory("owner", started.id)).map((round) => ({
      roundNumber: round.roundNumber, status: round.status, decision: round.result?.decision.kind,
    })), [
      { roundNumber: 1, status: "completed", decision: "next_round" },
      { roundNumber: 2, status: "completed", decision: "complete_goal" },
    ]);
    const outcome = await database.prepare("SELECT result_json FROM run_outcomes WHERE run_id = ?").get<{ result_json: string }>(started.id);
    const finalResult = JSON.parse(outcome!.result_json);
    assert.equal(finalResult.kind, "run");
    assert.equal(finalResult.inputs.length, 2);
    assert.deepEqual(new Set(finalResult.inputs.map((ref: { resultId: string }) => ref.resultId)),
      new Set(roundResults.flatMap((result) => result.steps.map((step: { result: { resultId: string } }) => step.result.resultId))));
  } finally { await database.close(); }
});

test("next-Round planning failure waits and resumes the same Run", async () => {
  const database = new AppDatabase(":memory:");
  let planningCalls = 0;
  let executionCalls = 0;
  let failedNextRound = false;
  const goal = "请分别给出交付 A 和交付 B。";
  try {
    const model = { limits: TEST_MODEL_LIMITS, complete: async (request: import("../src/runtime/contracts.ts").ModelInvocation) => {
      if (request.runId.startsWith("conversation-turn:")) return { content: "", finishReason: "tool_calls" as const, toolCalls: [{
        id: "resolve-two-targets", name: "resolve_conversation_turn", arguments: {
          mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
            deliverables: [
              { targetId: "target-a", purpose: "交付 A", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" },
              { targetId: "target-b", purpose: "交付 B", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" },
            ] },
          evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
          memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
        },
      }] };
      executionCalls += 1;
      return { content: `deliverable-${executionCalls}`, finishReason: "stop" as const, toolCalls: [] };
    } };
    const runs = new RunService({ database, skills: new SkillService(database), modelFactory: () => model,
      assessorFactory: () => approvingTestAssessor(), plannerFactory: () => ({ plan: async (task, _signal, emit) => {
        planningCalls += 1;
        await emit?.({ type: "planning.started", data: { maxPlanningTurns: 1 } });
        await emit?.({ type: "planning.turn.started", data: { turn: 1 } });
        if (task.targetScopeIds !== undefined && !failedNextRound) {
          failedNextRound = true;
          throw new AppError("PLANNING_ERROR", "next-round plan failed", 422);
        }
        const targetId = task.targetScopeIds?.[0] ?? "target-a";
        return { goal, shape: "multi_deliverable", selectedSkillIds: [],
          roundScope: { kind: "delivery", targetIds: [targetId], purpose: `Fulfill ${targetId}`, completionBoundary: `Deliver ${targetId}`, continuation: "Complete remaining targets after this delivery." }, steps: [{
          id: `round-${planningCalls}-deliver`, objective: `Fulfill ${targetId}`,
          dependencies: [], role: "deliver", skillIds: [], requiredCapabilities: ["conversation_delivery"], targetIds: [targetId],
          successCriteria: [{ id: `deliver-${targetId}`, description: `Deliver ${targetId}`, source: "task" }],
        }] };
      } }) });
    const started = await runs.executeConversation("owner", goal);
    let request = await runs.currentHumanLoop("owner", started.id);
    for (let attempt = 0; attempt < 200 && request === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      request = await runs.currentHumanLoop("owner", started.id);
    }
    assert.equal(request?.origin, "planner");
    assert.equal((await runs.get("owner", started.id)).status, "running");
    const waitingRecovery = await database.prepare("SELECT state, resume_attempts FROM run_planning_recovery WHERE run_id = ?")
      .get<{ state: string; resume_attempts: number }>(started.id);
    assert.deepEqual({ ...waitingRecovery }, { state: "waiting", resume_attempts: 0 });
    assert.equal((await runs.events("owner", started.id)).some((event) => event.type === "round.next.failed" && event.data.recoverable === true), true);
    await runs.respondHumanLoop("owner", started.id, request!.id, true, request!.revision);
    for (let attempt = 0; attempt < 400 && (await runs.get("owner", started.id)).status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await runs.get("owner", started.id)).status, "completed");
    assert.equal(planningCalls, 3);
    assert.equal(executionCalls, 2);
    assert.deepEqual((await runs.roundHistory("owner", started.id)).map((round) => round.status), ["completed", "completed"]);
    assert.equal((await database.prepare("SELECT state FROM run_planning_recovery WHERE run_id = ?").get<{ state: string }>(started.id))?.state, "completed");
  } finally {
    await database.close();
  }
});

test("intent failure resumes the original Run without changing its frozen clock", async () => {
  const database = new AppDatabase(":memory:");
  const goal = "Explain the requested result.";
  let resolverCalls = 0;
  let clockValue = Date.parse("2026-11-05T00:00:00Z");
  try {
    const model = { limits: TEST_MODEL_LIMITS, complete: async (request: import("../src/runtime/contracts.ts").ModelInvocation) => {
      if (request.runId.startsWith("conversation-turn:")) {
        resolverCalls += 1;
        if (resolverCalls <= 3) return { content: "", finishReason: "stop" as const, toolCalls: [] };
        assert.match(request.runtimeContext?.content ?? "", /2026-11-05T00:00:00/);
        return { content: "", finishReason: "tool_calls" as const, toolCalls: [{ id: "intent", name: "resolve_conversation_turn", arguments: {
          mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: true,
            deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
          evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
          memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
        } }] };
      }
      return { content: "Completed answer.", finishReason: "stop" as const, toolCalls: [] };
    } };
    const runs = new RunService({ database, skills: new SkillService(database), modelFactory: () => model,
      clock: () => clockValue, timeZone: "UTC", plannerFactory: () => singleStepTestPlanner(), assessorFactory: () => approvingTestAssessor() });
    const run = await runs.executeConversation("owner", goal);
    const request = await runs.currentHumanLoop("owner", run.id);
    assert.equal(request?.origin, "planner");
    clockValue += 86_400_000;
    await runs.respondHumanLoop("owner", run.id, request!.id, true, request!.revision);
    for (let attempt = 0; attempt < 200 && (await runs.get("owner", run.id)).status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await runs.get("owner", run.id)).status, "completed");
    assert.equal(resolverCalls, 4);
    const budget = await database.prepare("SELECT used_turns, max_turns FROM run_intent_budgets WHERE run_id = ?")
      .get<{ used_turns: number; max_turns: number }>(run.id);
    assert.deepEqual({ ...budget }, { used_turns: 4, max_turns: 6 });
  } finally { await database.close(); }
});

test("an interrupted claimed planning recovery resumes after reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-planning-reconcile-"));
  const path = join(directory, "runtime.db");
  let database = new AppDatabase(path);
  let planningCalls = 0;
  const model = { limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "Recovered.", finishReason: "stop" as const, toolCalls: [] }) };
  const base = singleStepTestPlanner();
  const createService = () => new RunService({ database, workspaceRoot: directory, skills: new SkillService(database),
    modelFactory: () => model, assessorFactory: () => approvingTestAssessor(),
    plannerFactory: () => ({ plan: async (task, _signal, emit) => {
      planningCalls += 1;
      await emit?.({ type: "planning.started", data: { maxPlanningTurns: 1 } });
      await emit?.({ type: "planning.turn.started", data: { turn: 1 } });
      if (planningCalls === 1) return { goal: task.canonicalState.intent.userInput, selectedSkillIds: [], steps: [] };
      return await base.plan(task);
    } }),
  });
  try {
    let runs = createService();
    const run = await runs.execute("owner", "Answer the question.");
    const request = await runs.currentHumanLoop("owner", run.id);
    assert.equal(request?.origin, "planner");
    (runs as unknown as { resumePlanningRun: () => Promise<void> }).resumePlanningRun = async () => {};
    await runs.respondHumanLoop("owner", run.id, request!.id, true, request!.revision);
    await database.close();
    database = new AppDatabase(path);
    runs = createService();
    assert.equal(await runs.reconcileInterruptedRuns([run.id]), 1);
    for (let attempt = 0; attempt < 200 && (await runs.get("owner", run.id)).status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await runs.get("owner", run.id)).status, "completed");
    const events = await runs.events("owner", run.id);
    assert.equal(events.filter((event) => event.type === "planning.final_admission.failed").length, 1);
    assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
  } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("rejecting a planning retry cancels the original Run without granting more budget", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const model = { limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "", finishReason: "length" as const, toolCalls: [] }) };
    const runs = new RunService({ database, skills: new SkillService(database), modelFactory: () => model,
      plannerFactory: () => new ModelPlanner(model, { maxPlanningTurns: 1 }) });
    const run = await runs.execute("owner", "Create a report.");
    const request = await runs.currentHumanLoop("owner", run.id);
    assert.ok(request);
    await runs.respondHumanLoop("owner", run.id, request.id, { accepted: false }, request.revision);
    assert.equal((await runs.get("owner", run.id)).status, "cancelled");
    await assert.rejects(runs.respondHumanLoop("owner", run.id, request.id, true, request.revision), /no longer accepting/);
    const budget = await database.prepare("SELECT used_turns, max_turns FROM run_planning_budgets WHERE run_id = ?")
      .get<{ used_turns: number; max_turns: number }>(run.id);
    assert.deepEqual({ ...budget }, { used_turns: 1, max_turns: 1 });
  } finally { await database.close(); }
});

test("a second planning failure terminates rather than asking or retrying indefinitely", async () => {
  const database = new AppDatabase(":memory:");
  let calls = 0;
  try {
    const model = { limits: TEST_MODEL_LIMITS, complete: async () => {
      calls += 1;
      return { content: "", finishReason: "length" as const, toolCalls: [] };
    } };
    const runs = new RunService({ database, skills: new SkillService(database), modelFactory: () => model,
      plannerFactory: () => new ModelPlanner(model, { maxPlanningTurns: 1 }) });
    const run = await runs.execute("owner", "Create a report.");
    const request = await runs.currentHumanLoop("owner", run.id);
    await runs.respondHumanLoop("owner", run.id, request!.id, true, request!.revision);
    for (let attempt = 0; attempt < 200 && (await runs.get("owner", run.id)).status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await runs.get("owner", run.id)).status, "failed");
    assert.equal(calls, 2);
    assert.equal(await runs.currentHumanLoop("owner", run.id), undefined);
    const budget = await database.prepare("SELECT used_turns, max_turns FROM run_planning_budgets WHERE run_id = ?")
      .get<{ used_turns: number; max_turns: number }>(run.id);
    assert.deepEqual({ ...budget }, { used_turns: 2, max_turns: 2 });
  } finally { await database.close(); }
});

test("cancellation during planning recovery cannot admit a late Plan", async () => {
  const database = new AppDatabase(":memory:");
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  try {
    const model = { limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "done", finishReason: "stop" as const, toolCalls: [] }) };
    const base = singleStepTestPlanner();
    const runs = new RunService({ database, skills: new SkillService(database), modelFactory: () => model,
      plannerFactory: () => ({ plan: async (task, _signal, emit) => {
        await emit?.({ type: "planning.started", data: { maxPlanningTurns: 1 } });
        await emit?.({ type: "planning.turn.started", data: { turn: 1 } });
        if (++calls === 1) throw new AppError("PLANNING_ERROR", "plan failed", 422);
        entered();
        await blocked;
        return await base.plan(task);
      } }), assessorFactory: () => approvingTestAssessor() });
    const run = await runs.execute("owner", "Answer the question.");
    const request = await runs.currentHumanLoop("owner", run.id);
    await runs.respondHumanLoop("owner", run.id, request!.id, true, request!.revision);
    await started;
    await runs.cancel("owner", run.id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await runs.get("owner", run.id)).status, "cancelled");
    const plans = await database.prepare("SELECT id FROM plans WHERE run_id = ?").all(run.id);
    assert.equal(plans.length, 0);
    assert.equal((await runs.events("owner", run.id)).some((event) => event.type === "run.completed"), false);
  } finally { release?.(); await database.close(); }
});

test("planning recovery refuses a changed Skill version before executing tools", async () => {
  const database = new AppDatabase(":memory:");
  let calls = 0;
  try {
    const skills = new SkillService(database);
    const skill = await skills.create("owner", { name: "sample-skill", description: "Sample", instructions: "Original instructions" });
    const model = { limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "done", finishReason: "stop" as const, toolCalls: [] }) };
    const runs = new RunService({ database, skills, modelFactory: () => model,
      plannerFactory: () => ({ plan: async (_task, _signal, emit) => {
        calls += 1;
        await emit?.({ type: "planning.started", data: { maxPlanningTurns: 1 } });
        await emit?.({ type: "planning.turn.started", data: { turn: 1 } });
        throw new AppError("PLANNING_ERROR", "plan failed", 422);
      } }) });
    const run = await runs.execute("owner", "Answer the question.");
    const request = await runs.currentHumanLoop("owner", run.id);
    await database.prepare("UPDATE skills SET content_hash = ? WHERE id = ?").run("changed", skill.id);
    await runs.respondHumanLoop("owner", run.id, request!.id, true, request!.revision);
    for (let attempt = 0; attempt < 200 && (await runs.get("owner", run.id)).status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await runs.get("owner", run.id)).status, "failed");
    assert.equal(calls, 1);
    assert.equal((await database.prepare("SELECT id FROM plans WHERE run_id = ?").all(run.id)).length, 0);
  } finally { await database.close(); }
});

test("failed conversation intent resolution preserves its own bounded model-call budget", async () => {
  const database = new AppDatabase(":memory:");
  let calls = 0;
  try {
    const model = { limits: TEST_MODEL_LIMITS, complete: async () => {
      calls += 1;
      return { content: "", finishReason: "stop" as const, toolCalls: [] };
    } };
    const runs = new RunService({ database, skills: new SkillService(database), modelFactory: () => model });
    const runId = (await runs.executeConversation("owner", "Prepare a report from the requested data.")).id;
    assert.ok(runId);
    const budget = await database.prepare("SELECT max_turns, used_turns FROM run_intent_budgets WHERE run_id = ?")
      .get<{ max_turns: number; used_turns: number }>(runId);
    assert.deepEqual({ ...budget }, { max_turns: 3, used_turns: 3 });
    assert.equal(calls, 3);
    const events = await runs.events("owner", runId);
    assert.equal(events.filter((event) => event.type === "conversation.turn.attempt_started").length, 3);
    assert.deepEqual(events.find((event) => event.type === "planning.intent.failed")?.data,
      { stage: "intent_resolution", errorCode: "PLANNING_ERROR" });
    assert.equal(events.some((event) => event.type === "canonical_run_state.initialized"), false);
    assert.equal((await runs.get("owner", runId)).status, "running");
    assert.equal((await runs.currentHumanLoop("owner", runId))?.origin, "planner");
  } finally {
    await database.close();
  }
});

test("initial planning failure retains its structured boundary in the durable Run events", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const model = { limits: TEST_MODEL_LIMITS, complete: async () => ({
      content: "private model response", finishReason: "length" as const, toolCalls: [],
    }) };
    const runs = new RunService({ database, skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => new ModelPlanner(model, { maxPlanningTurns: 1 }),
    });
    const runId = (await runs.execute("owner", "Create a Markdown report.")).id;
    assert.ok(runId);
    const events = await runs.events("owner", runId);
    const failure = events.find((event) => event.type === "planning.contract_failed");
    assert.ok(failure);
    assert.equal(failure.data.stage, "response");
    assert.equal(failure.data.errorCode, "PLANNING_ERROR");
    assert.equal(failure.data.planningTurn, 1);
    assert.equal(failure.data.maxPlanningTurns, 1);
    assert.doesNotMatch(JSON.stringify(failure.data), /private model response/);
    assert.equal((await runs.get("owner", runId)).status, "running");
    const round = await database.prepare("SELECT status, plan_id, revision FROM run_rounds WHERE run_id = ? AND round_number = 1")
      .get<{ status: string; plan_id: string | null; revision: number }>(runId);
    assert.deepEqual({ ...round }, { status: "planning", plan_id: null, revision: 1 });
    const budget = await database.prepare("SELECT max_turns, used_turns FROM run_planning_budgets WHERE run_id = ?")
      .get<{ max_turns: number; used_turns: number }>(runId);
    assert.deepEqual({ ...budget }, { max_turns: 1, used_turns: 1 });
  } finally {
    await database.close();
  }
});

for (const humanPause of [false, true]) {
  test(`canonical assessment gaps survive local exhaustion and drive one shared recovery path (humanPause=${humanPause})`, async () => {
    const database = new AppDatabase(":memory:");
    let asked = false;
    let sourceReads = 0;
    let candidates = 0;
    let recoveryCalls = 0;
    let gapId = "";
    let sawRepairView = false;
    const base = singleStepTestPlanner();
    try {
      const runs = new RunService({ database, skills: new SkillService(database),
        plannerFactory: () => ({ plan: async (task) => {
          const proposal = await base.plan(task);
          return { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
            requiredCapabilities: ["records.lookup", "conversation_delivery"],
            evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "none" as const },
            successCriteria: [{ id: "second-total", description: "Establish both totals and state their difference.", source: "task" as const }],
          })) };
        } }),
        tools: [{ name: "read_records", description: "Read the requested records", inputSchema: { type: "object" },
          source: { id: "records", transport: "api", capabilities: [{ id: "records.lookup", category: "source_acquisition",
            sourceKinds: ["api"], producesEvidenceKinds: ["source_summary"] }] },
          executionMode: "parallel", replaySafe: true, parse: (value) => value,
          execute: async () => ({ value: ++sourceReads === 1 ? { a: 80 } : { a: 80, b: 60 },
            evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", sourceType: "api",
              evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } } }) }],
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
          if (humanPause && !asked) {
            asked = true;
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "confirm-records", name: HUMAN_LOOP_TOOL_NAME,
              arguments: { kind: "confirmation", title: "Confirm input", prompt: "Use the selected records?", rationale: "Confirm the record scope",
                evidenceRefs: [], responseSchema: { type: "confirm", acceptLabel: "Continue", rejectLabel: "Stop" },
                resume: { mode: "continue_step" } } }] };
          }
          const frame = JSON.parse(request.runtimeContext!.content.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]!);
          const view = frame.currentDecisionView;
          const stored = await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id = ?")
            .get<{ state_json: string }>(request.runId);
          const state = JSON.parse(stored!.state_json);
          if (gapId === "") gapId = state.gaps.find((gap: { stepId?: string }) => gap.stepId !== undefined)?.id ?? "";
          assert.equal(view.identity.canonicalState.revision, state.revision,
            "every model turn must consume the latest committed Run revision");
          const gaps = view.currentGap.assessmentGaps;
          const repairing = view.identity.stepId === "complete-records";
          if (gaps.length > 0) {
            // The admitted replacement follows its own completion boundary;
            // the original unmet fact remains visible until Assessment accepts it.
            assert.equal(view.nextAction, repairing ? "submit_completion_candidate" : "resolve_evidence_gap");
            assert.deepEqual(view.currentGap.repairInProgressGapIds, repairing ? [gapId] : []);
            assert.equal(gaps[0].id, gapId);
            assert.equal(gaps[0].unmetCriteria[0].criterionId, "second-total");
            assert.deepEqual(view.currentGap.receipts.missingToolEvidenceKinds, [], "a source receipt exists but the second total is still unverified");
            assert.ok(request.tools.some((tool) => tool.name === "read_records"));
            assert.doesNotMatch(request.runtimeContext!.content, /Return a complete standalone replacement now/);
          }
          if (repairing) sawRepairView = true;
          if (sourceReads === 0 || (repairing && sourceReads === 1)) {
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `read-${sourceReads}`, name: "read_records", arguments: {} }] };
          }
          return { content: sourceReads > 1 ? "The difference is 20." : `Only the first total is known. Draft ${++candidates}.`,
            finishReason: "stop", toolCalls: [] };
        } }),
        assessorFactory: () => ({ assess: async (input) => {
          const approved = await approvingTestAssessor().assess(input);
          if (sourceReads > 1) return approved;
          return { ...approved, approved: false, assessmentMethod: "model" as const,
            criteria: approved.criteria.map((criterion) => ({ ...criterion, satisfied: false, rationale: "The second total is unverified." })),
            feedback: "Read the second total before computing the difference.",
            failedBoundary: { stepId: input.step.id, suggestedRepairShape: "repair_leaf" as const, missingEvidenceKinds: ["source_summary"],
              violatedSkillRequirements: [], reusableEvidenceRefs: input.evidence.toolCalls.map((call) => call.toolCallId),
              unmetCriteria: [{ criterionId: "second-total", status: "unverified" as const, rationale: "The source only contains the first total.", evidenceRefs: [] }] } };
        } }),
        recoveryPlannerFactory: () => ({ decide: async (input) => {
          recoveryCalls += 1;
          assert.equal(input.action.metadata.localRepairExhausted, true);
          assert.equal(input.canonicalGap!.id, gapId);
          assert.equal(input.canonicalGap!.repairAttempts, 0);
          const failed = input.plan!.steps.find((step) => step.id === input.failedBoundary!.stepId)!;
          return parseRecoveryDecision({ id: "repair-plan", name: "submit_recovery_decision", arguments: {
            actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan",
            rationale: "Read the missing second total, preserving existing observations.", evidenceRefs: input.canonicalGap!.evidenceRefs,
            planRevision: { retainedStepIds: [], goal: input.plan!.goal, shape: "recovery_patch" as const, selectedSkillIds: [],
              steps: [{ id: "complete-records", objective: failed.objective, role: "repair" as const, dependencies: [], skillIds: [],
                targetIds: failed.executionBinding.targetIds, requiredCapabilities: failed.requiredCapabilities, sourceConstraint: null,
                evidenceContract: failed.evidenceContract, successCriteria: recoveryModelCriteria(failed.successCriteria) }] } },
          }, input.canonicalState!);
        } }),
        planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
      });
      const run = await runs.execute("owner", "Compare the two recorded totals and state their difference.");
      if (humanPause) {
        const request = await runs.currentHumanLoop("owner", run.id);
        assert.ok(request);
        await runs.respondHumanLoop("owner", run.id, request.id, true, request.revision);
        for (let attempt = 0; attempt < 100 && (await runs.get("owner", run.id)).status === "running"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
      const final = await runs.get("owner", run.id);
      assert.equal(final.status, "completed", final.output);
      const round = await database.prepare("SELECT status, plan_id, revision FROM run_rounds WHERE run_id = ? AND round_number = 1")
        .get<{ status: string; plan_id: string | null; revision: number }>(run.id);
      assert.equal(round?.status, "completed");
      assert.ok(round?.plan_id);
      assert.equal(round?.revision, 3);
      const storedResult = await database.prepare("SELECT result_json, canonical_revision FROM run_round_results WHERE run_id = ?")
        .get<{ result_json: string; canonical_revision: number }>(run.id);
      assert.ok(storedResult);
      const roundResult = JSON.parse(storedResult.result_json);
      assert.equal(roundResult.schema, "agentloop.roundResult/v1");
      assert.equal(roundResult.planId, round.plan_id);
      assert.equal(roundResult.canonicalRevision, storedResult.canonical_revision);
      assert.deepEqual(roundResult.decision, { kind: "complete_goal", canonicalRevision: storedResult.canonical_revision });
      assert.equal(roundResult.output, "The difference is 20.");
      assert.equal(roundResult.steps.length, 1);
      assert.equal(roundResult.steps[0].stepId, "complete-records");
      assert.match(roundResult.steps[0].result.resultId, /^rr_/);
      assert.ok(roundResult.steps[0].assessmentId);
      assert.equal(final.output, "The difference is 20.");
      assert.equal(sourceReads, 2);
      assert.equal(recoveryCalls, 1);
      assert.equal(sawRepairView, true);
      const canonical = JSON.parse((await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id = ?")
        .get<{ state_json: string }>(run.id))!.state_json);
      const gap = canonical.gaps.find((item: { id: string }) => item.id === gapId);
      assert.equal(gap.status, "resolved");
      assert.equal(gap.repairAttempts, 1);
      assert.equal((await runs.events("owner", run.id)).some((event) => event.type === "terminal.delivery_committed"), true);
      assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM runtime_actions WHERE run_id = ? AND kind = 'recovery_review' AND state = 'recovery_required'")
        .get<{ count: number }>(run.id))!.count, 0);
    } finally { await database.close(); }
  });
}

function fixture() {
  const userInput = "Compare the two recorded totals and state their difference.";
  const state = createCanonicalRunState({ runId: "goal-contract", userInput,
    understanding: understandTask({ objective: userInput }), now: 1 });
  const basis = goalCriterionBasis(state, [], "user_requirement", "The requested comparison must state the difference.");
  const proposal = { goal: userInput, selectedSkillIds: [], steps: [{ id: "answer", objective: userInput,
    dependencies: [], skillIds: [], requiredCapabilities: [], targetIds: [],
    successCriteria: [{ id: "difference", description: "State the difference between recorded totals.", source: "task" as const,
      verification: "model_judged" as const, blocking: true, basis }] }] };
  return { state, proposal, basis };
}

function recoveryModelCriteria(criteria: readonly import("../src/planning/contracts.ts").SuccessCriterion[]) {
  return recoveryProposalSuccessCriteria(criteria).map((criterion) => {
    if (criterion.basis === undefined) return criterion;
    const { requirement: _requirement, intentId: _intentId, ...basis } = criterion.basis;
    return { ...criterion, basis };
  });
}

test("a canonical synthesis gap allows a corrected answer from unchanged observations", async () => {
  const database = new AppDatabase(":memory:");
  let turns = 0;
  try {
    const runs = new RunService({ database, skills: new SkillService(database), tools: [],
      plannerFactory: singleStepTestPlanner,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        turns += 1;
        if (turns === 2) {
          const frame = JSON.parse(request.runtimeContext!.content.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]!);
          assert.equal(frame.currentDecisionView.nextAction, "revise_completion_candidate");
          assert.deepEqual(frame.currentDecisionView.currentGap.assessmentGaps[0].missingEvidenceKinds, []);
        }
        return { content: turns === 1 ? "The totals are 80 and 60." : "The difference is 20.", finishReason: "stop", toolCalls: [] };
      } }),
      assessorFactory: () => ({ assess: async (input) => {
        const assessment = await approvingTestAssessor().assess(input);
        return turns > 1 ? assessment : { ...assessment, approved: false,
          criteria: assessment.criteria.map((criterion) => ({ ...criterion, satisfied: false, rationale: "State the difference using the supplied totals." })),
          feedback: "The observations are sufficient; correct the answer.",
          failedBoundary: { stepId: input.step.id, suggestedRepairShape: "repair_leaf" as const,
            missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [] } };
      } }),
      recoveryPlannerFactory: () => ({ decide: async () => { throw new Error("A synthesis revision must not require new acquisition or a revised Plan"); } }),
    });
    const run = await runs.execute("owner", "The totals are 80 and 60. State their difference.");
    assert.equal(run.status, "completed");
    assert.equal(run.output, "The difference is 20.");
    assert.equal(turns, 2);
    assert.equal((await runs.events("owner", run.id)).some((event) => event.type === "tool.completed"), false);
  } finally { await database.close(); }
});

test("criterion provenance rejects foreign intents, invented quotes and unowned targets without weakening the criterion", () => {
  const { state, proposal, basis } = fixture();
  for (const invalid of [{ ...basis, intentId: "foreign" }, { ...basis, requirement: "invented request" },
    { ...basis, requirement: "two recorded totals" },
    { ...basis, targetIds: ["foreign-target"] }, { ...basis, kind: "execution_method" as const }]) {
    const changed = { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
      successCriteria: step.successCriteria.map((criterion) => ({ ...criterion, basis: invalid })) })) };
    assert.throws(() => admitPlan({ runId: state.runId, canonicalState: state, proposal: changed,
      availableSkills: [], availableToolNames: new Set() }), /basis|Execution method/);
  }
  assert.equal(proposal.steps[0]!.successCriteria[0]!.blocking, true);
});

test("an unjustified extra proof obligation cannot reopen a canonical Gap for a matching reply", async () => {
  const { state, proposal, basis } = fixture();
  const plan = admitPlan({ runId: state.runId, canonicalState: state, availableSkills: [], availableToolNames: new Set(),
    proposal: { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
      successCriteria: step.successCriteria.map((criterion) => ({ ...criterion,
        basis: { ...basis, kind: "necessary_condition", rationale: "Publish an additional written proof of the calculation method." } })) })) } });
  const step = plan.steps[0]!;
  const running = startCanonicalStep(bindCanonicalPlan(state, plan, 2), step.id, 3);
  const evidence = { candidateOutput: "The recorded totals are 80 and 60; the difference is 20.", toolCalls: [], modelSteps: 1 };
  const assessment = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
    assert.match(request.runtimeContext!.content, /canonicalIntent/);
    assert.match(request.systemPrompt, /does not require web research or written citations/);
    return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "assess", name: "submit_assessment", arguments: {
      criteria: [{ criterionId: "difference", satisfied: true, rationale: "The result is correct but this proposed additional proof is not requested.",
        contractCheck: { status: "invalid", rationale: "A separate proof document is an execution method, not a necessary result condition." },
        evidenceRefs: ["candidateOutput"] }],
      skills: [], feedback: "Revise the unjustified derived condition, preserving the requested comparison.", failedBoundary: null,
    } }] };
  } }).assess({ runId: state.runId, planId: plan.id, step, canonicalState: running, skills: [], attempt: 1,
    assessmentProfile: "result_judged", evidence });
  assert.equal(assessment.approved, true);
  assert.equal(assessment.failedBoundary, undefined);
  assert.equal(assessment.criteria[0]!.blocking, false);
  assert.match(assessment.criteria[0]!.contractIssue ?? "", /execution method/);
  const assessed = recordCanonicalAssessment(running, assessment, evidence, 4);
  assert.equal(assessed.steps[step.id]!.status, "satisfied");
  assert.equal(assessed.gaps.some((gap) => gap.stepId === step.id && gap.status === "open"), false);
});

for (const duplicate of [false, true]) {
  test(`unchanged observations allow a corrected candidate while exact duplicates reuse rejection (duplicate=${duplicate})`, async () => {
    let turns = 0;
    let assessments = 0;
    const grant = createCapabilityGrant({ runId: `candidate-${duplicate}`, actorUserId: "owner", depth: 0,
      allowedToolNames: [], allowedSkillIds: [] });
    const execute = () => runAgentLoop({ runId: grant.runId, input: "State the difference", systemPrompt: "Use committed totals",
      grant, tools: new ToolRegistry([]), maxSteps: 4, deferFailureReport: true,
      initialToolEvidence: [{ toolCallId: "totals", toolName: "read_totals", result: '{"a":80,"b":60}', isError: false }],
      model: { limits: TEST_MODEL_LIMITS, complete: async () => ({ content: ++turns === 1 || duplicate ? "The totals are 80 and 60." : "The difference is 20.", finishReason: "stop", toolCalls: [] }) },
      evaluateCandidate: async (candidate) => {
        assessments += 1;
        assert.equal(candidate.toolEvidence.length, 1);
        return { approved: candidate.output.includes("20"), requiresEvidenceProgress: true,
          feedback: "The totals already support the calculation; state the difference." };
      } });
    if (duplicate) {
      await assert.rejects(execute(), (error: any) => error.code === "STEP_NOT_COMPLETED" && error.details?.repairExhausted === true);
      assert.equal(assessments, 1);
    } else {
      assert.equal((await execute()).output, "The difference is 20.");
      assert.equal(assessments, 2);
    }
  });
}

test("Recovery parsing preserves result criteria, original source identities and user provenance", () => {
  const { state, proposal, basis } = fixture();
  const { requirement: _requirement, intentId: _intentId, ...basisMetadata } = basis;
  const sourceConstraint = { requiredToolSourceIds: ["records"], requiredUploadedSourceIds: [], requiredVisibleDirectoryIds: [] };
  const step = { ...proposal.steps[0], role: "repair", targetIds: [], sourceConstraint,
    requiredFacts: [{ id: "totals", description: "The two recorded totals", evidenceKinds: ["source_summary"], basis }] };
  const decision = parseRecoveryDecision({ id: "recovery", name: "submit_recovery_decision", arguments: {
    actionId: "action", expectedActionRevision: 1, decision: "revise_plan", rationale: "Repair the comparison", evidenceRefs: [],
    planRevision: { retainedStepIds: [], ...proposal, shape: "recovery_patch", steps: [{ ...step,
      successCriteria: recoveryModelCriteria(step.successCriteria),
      requiredFacts: step.requiredFacts.map((fact) => ({ ...fact, basis: basisMetadata })),
    }] },
  } }, state);
  const parsed = decision.planRevision!.steps[0]!;
  assert.deepEqual(parsed.successCriteria, step.successCriteria);
  assert.deepEqual(parsed.requiredFacts, step.requiredFacts);
  assert.deepEqual(parsed.targetIds, []);
  assert.deepEqual(parsed.sourceConstraint, sourceConstraint);
});

test("Recovery parsing treats a null sourceConstraint as absent while rejecting malformed constraints", () => {
  const { state, proposal } = fixture();
  const step = { ...proposal.steps[0], role: "repair", targetIds: [], sourceConstraint: null,
    successCriteria: recoveryModelCriteria(proposal.steps[0]!.successCriteria) };
  const decision = parseRecoveryDecision({ id: "recovery-null-source", name: "submit_recovery_decision", arguments: {
    actionId: "action", expectedActionRevision: 1, decision: "revise_plan", rationale: "Repair the comparison", evidenceRefs: [],
    planRevision: { retainedStepIds: [], ...proposal, shape: "recovery_patch", steps: [step] },
  }}, state);
  assert.equal(decision.planRevision!.steps[0]!.sourceConstraint, undefined);
  for (const malformed of ["records", [], false, 0, { requiredToolSourceIds: null }, { requiredUploadedSourceIds: [12] }]) {
    assert.throws(() => parseRecoveryDecision({ id: "recovery-bad-source", name: "submit_recovery_decision", arguments: {
      actionId: "action", expectedActionRevision: 1, decision: "revise_plan", rationale: "Repair the comparison", evidenceRefs: [],
      planRevision: { retainedStepIds: [], ...proposal, shape: "recovery_patch", steps: [{ ...step, sourceConstraint: malformed }] },
    }}, state), (error: any) => error.code === "PLANNING_ERROR");
  }
});

test("Recovery parsing rejects delivery criteria that Admission derives from target ownership", () => {
  const { state, proposal } = fixture();
  const targetId = "delivery-target";
  assert.throws(() => parseRecoveryDecision({ id: "recovery-derived-target", name: "submit_recovery_decision", arguments: {
    actionId: "action", expectedActionRevision: 1, decision: "revise_plan", rationale: "Repair the result", evidenceRefs: [],
    planRevision: { retainedStepIds: [], ...proposal, shape: "recovery_patch", steps: [{ ...proposal.steps[0], id: "repair", targetIds: [targetId],
      successCriteria: [{ id: `delivery_target:${targetId}`, description: "Derived target criterion", source: "task" }] }] },
  } }, state), /Runtime-derived delivery_target:delivery-target/);
});

test("an invalid Recovery response commits a stopped Outcome and retains the open Gap", async () => {
  const database = new AppDatabase(":memory:");
  let reports = 0;
  try {
    const runs = new RunService({ database, skills: new SkillService(database), plannerFactory: singleStepTestPlanner, tools: [],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          reports += 1;
          assert.deepEqual(request.tools, []);
          assert.match(request.runtimeContext!.content, /agentloop.failureReportContext\/v1/);
          return { content: "比较未完成，当前没有可交付的结论。", finishReason: "stop", toolCalls: [] };
        }
        return { content: "unverified candidate", finishReason: "stop", toolCalls: [] };
      } }),
      recoveryPlannerFactory: () => ({ decide: async () => { throw new Error("invalid structured recovery response"); } }),
      assessorFactory: () => ({ assess: async (input) => ({ ...await approvingTestAssessor().assess(input), approved: false,
        criteria: input.step.successCriteria.map((criterion) => ({ criterionId: criterion.id, satisfied: false, rationale: "Result is incomplete", evidenceRefs: [] })),
        failedBoundary: { stepId: input.step.id, suggestedRepairShape: "repair_leaf", missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [] } }) }),
    });
    const run = await runs.execute("owner", "Return a complete comparison");
    assert.equal(run.status, "failed");
    const row = await database.prepare("SELECT status, delivery_receipt_json FROM run_outcomes WHERE run_id = ?").get(run.id) as any;
    assert.equal(row.status, "failed");
    assert.equal(row.delivery_receipt_json, null);
    assert.equal((await runs.events("owner", run.id)).some((event) => event.type === "terminal.delivery_committed"), false);
    assert.match(run.output ?? "", /未完成/);
    assert.equal(reports, 1);
  } finally { await database.close(); }
});

test("assessment profile schema upgrade preserves complete historical observations and indexes", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunService({ database, skills: new SkillService(database), tools: [], plannerFactory: singleStepTestPlanner,
      assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "Complete comparison", finishReason: "stop", toolCalls: [] }) }),
    });
    assert.equal((await runs.execute("owner", "Compare the recorded values")).status, "completed");
    await database.prepare(`UPDATE skill_compliance_assessments SET assessment_profile = 'source_grounded',
      binding_json = ?, inspection_json = ?, decision_bindings_json = ?`).run('{"binding":"retained"}', '{"inspection":"retained"}', '[{"decision":"retained"}]');
    const before = await database.prepare("SELECT * FROM skill_compliance_assessments ORDER BY id").all();
    const table = await database.prepare("SELECT sql FROM sqlite_master WHERE name = 'skill_compliance_assessments'").get<{ sql: string }>();
    await database.transaction(async () => {
      await database.exec(table!.sql.replace(/skill_compliance_assessments/, "assessment_old_schema").replace(", 'result_judged'", ""));
      await database.exec("INSERT INTO assessment_old_schema SELECT * FROM skill_compliance_assessments");
      await database.exec("DROP TABLE skill_compliance_assessments");
      await database.exec("ALTER TABLE assessment_old_schema RENAME TO skill_compliance_assessments");
      await database.exec("CREATE INDEX assessment_observation_idx ON skill_compliance_assessments(plan_id, step_id)");
      await database.exec("CREATE TABLE assessment_audit (assessment_id TEXT)");
      await database.exec("CREATE TRIGGER assessment_update_audit AFTER UPDATE ON skill_compliance_assessments BEGIN INSERT INTO assessment_audit VALUES (NEW.id); END");
    });
    await database.installAssessmentProfileSchema();
    assert.deepEqual(await database.prepare("SELECT * FROM skill_compliance_assessments ORDER BY id").all(), before);
    assert.ok(await database.prepare("SELECT name FROM sqlite_master WHERE name = 'assessment_observation_idx'").get());
    await database.prepare("UPDATE skill_compliance_assessments SET assessment_profile = 'result_judged'").run();
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM assessment_audit").get<{ total: number }>())!.total, before.length);
    await database.installAssessmentProfileSchema();
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM skill_compliance_assessments").get<{ total: number }>())!.total, before.length);
  } finally { await database.close(); }
});

for (const dialect of ["postgres", "tidb"] as const) {
  test(`${dialect} profile migration replaces only the profile constraint and is idempotent`, async () => {
    const statements: string[] = [];
    const profileName = dialect === "postgres" ? 'profile"check' : 'profile`check';
    let constraints = [{ name: "approved_check", clause: "approved IN (0, 1)" },
      { name: profileName, clause: "assessment_profile IN ('source_grounded', 'evidence_gate')" }];
    const connection: SqlConnection = {
      dialect: dialect as SqlDialect,
      exec: async (sql) => {
        statements.push(sql);
        if (sql.includes("ADD CONSTRAINT")) constraints = [constraints[0]!, { name: "skill_assessment_profile_check", clause: sql }];
      },
      prepare: (sql) => {
        assert.match(sql, dialect === "postgres" ? /pg_constraint/ : /information_schema.CHECK_CONSTRAINTS/);
        return { all: async <T>() => constraints as T[],
          get: async () => { throw new Error("unexpected row read"); },
          run: async () => { throw new Error("migration must not rewrite assessment rows"); } };
      },
      transaction: async (operation) => operation(), close: async () => {},
    };
    await installAssessmentProfileSchema(connection);
    assert.equal(statements.length, 2);
    assert.equal(statements[0], dialect === "postgres"
      ? 'ALTER TABLE skill_compliance_assessments DROP CONSTRAINT "profile""check"'
      : 'ALTER TABLE skill_compliance_assessments DROP CHECK `profile``check`');
    assert.match(statements[1]!, /'result_judged'/);
    assert.equal(statements.some((sql) => sql.includes("approved_check")), false);
    await installAssessmentProfileSchema(connection);
    assert.equal(statements.length, 2);
  });
}

test("an accepted file receipt cannot route a requested content property through rule-only assessment", async () => {
  const database = new AppDatabase(":memory:");
  const workspaceRoot = await mkdtemp(join(tmpdir(), "goal-content-assessment-"));
  let targetId = "";
  let assessments = 0;
  let writes = 0;
  const base = singleStepTestPlanner();
  try {
    const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot,
      plannerFactory: () => ({ plan: async (task) => {
        assert.equal(task.canonicalState.intent.understanding.evidence.need, "none", "comparing supplied numbers must not create an external-source obligation");
        const proposal = await base.plan(task);
        targetId = task.canonicalState.intent.understanding.artifactTargets![0]!.id;
        return { ...proposal, steps: proposal.steps.map((step) => ({ ...step, role: "produce" as const,
          requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
          evidenceContract: { requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"] as const, caveatPolicy: "none" as const },
          successCriteria: [{ id: "correct-difference", source: "task" as const, description: "The HTML must state the correct difference.", verification: "model_judged" as const }],
        })) };
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.tools[0]?.name === "resolve_conversation_turn") return { content: "", finishReason: "tool_calls", toolCalls: [{
          id: "resolve-report", name: "resolve_conversation_turn", arguments: {
            mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: "比较 80 与 60，生成一个 HTML 文件，内容写出差值。",
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "create_artifact", requiresExecution: true,
              deliverables: [{ targetId: "report", purpose: "The report must state the difference", expectedArtifactCount: 1,
                action: "create", kind: "html", format: "html", surface: "workspace_artifact" }] },
            evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
          },
        }] };
        if (request.phase === "assessment") {
          assessments += 1;
          const match = request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)!;
          const context = JSON.parse(match[1]);
          assert.match(request.runtimeContext!.content, /result_judged/);
          assert.match(JSON.stringify(context.evidence), /artifactAcceptance/);
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "content-assessment", name: "submit_assessment", arguments: {
            criteria: context.step.successCriteria.map((criterion: { id: string }) => ({ criterionId: criterion.id,
              satisfied: criterion.id !== "correct-difference", rationale: "The file decodes; the requested difference is not verified.", evidenceRefs: ["write-report"],
              contractCheck: { status: "valid", rationale: "The condition follows from the requested report." } })),
            skills: [], feedback: "Preserve the stage file; the requested content remains unverified.",
            failedBoundary: { stepId: context.step.id, missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: ["write-report"], suggestedRepairShape: "fail" },
          } }] };
        }
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          return { content: "已生成文件，差值内容尚未核验。", finishReason: "stop", toolCalls: [] };
        }
        if (writes++ === 0) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "write-report", name: "computer_write_file",
          arguments: { path: "report.html", content: "<!doctype html><html><head><meta charset='utf-8'><title>Report</title></head><body><h1>Comparison</h1><p>The totals are 80 and 60.</p></body></html>", deliveryTargetId: targetId } }] };
        if (writes === 2) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "verify-report", name: "verify_artifact_acceptance", arguments: { artifactPath: "report.html" } }] };
        return { content: "已生成 report.html。", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", "比较 80 与 60，生成一个 HTML 文件，内容写出差值。");
    assert.equal(run.status, "failed");
    assert.equal(assessments, 1);
    const artifact = (await runs.processArtifacts("owner", run.id)).find((artifact) => artifact.path === "report.html")!;
    assert.equal(artifact.verification?.file, "verified");
    assert.equal(artifact.verification?.result, "unverified");
    assert.equal(artifact.role, "process");
    assert.ok(artifact.verification?.limitations.some((text) => text.includes("difference")));
  } finally { await database.close(); await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("Recovery projects editable criteria separately and Admission alone restores delivery obligations", async () => {
  const userInput = "Compare the recorded totals and state their difference.";
  const state = createCanonicalRunState({ runId: "recovery-projection", userInput, now: 1,
    understanding: { ...understandTask({ objective: userInput }), deliverables: [{
      targetId: "comparison", purpose: userInput, surface: "conversation", kind: "none", action: "none", expectedArtifactCount: 1,
    }] } });
  const basis = goalCriterionBasis(state, ["comparison"], "user_requirement", "The user requested the difference.");
  const plan = admitPlan({ runId: state.runId, canonicalState: state, availableSkills: [], availableToolNames: new Set(),
    proposal: { goal: userInput, selectedSkillIds: [], steps: [{ id: "answer", objective: userInput, targetIds: ["comparison"],
      dependencies: [], skillIds: [], requiredCapabilities: ["conversation_delivery"],
      requiredFacts: [{ id: "totals", description: "Both totals", evidenceKinds: ["source_summary"], basis }],
      successCriteria: [{ id: "difference", description: "State the difference", source: "task", basis, blocking: true }],
    }] } });
  const before = JSON.stringify(plan);
  const decision = await new ModelRecoveryPlanner({ limits: TEST_MODEL_LIMITS, complete: async request => {
    const context = JSON.parse(request.runtimeContext!.content);
    const step = context.currentPlan.steps[0];
    assert.deepEqual(step.successCriteria.map((criterion: { id: string }) => criterion.id), ["difference"]);
    assert.deepEqual(step.runtimeDerivedSuccessCriteria.map((criterion: { id: string }) => criterion.id), ["delivery_target:comparison"]);
    assert.equal(step.successCriteria[0].basis.intentId, undefined);
    assert.equal(step.successCriteria[0].basis.requirement, undefined);
    assert.equal(step.requiredFacts[0].basis.intentId, undefined);
    assert.equal(context.canonicalState.targets.comparison.purpose, userInput);
    return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "revise", name: "submit_recovery_decision", arguments: {
      actionId: "recovery-action", expectedActionRevision: 1, decision: "revise_plan", rationale: "Repair the result", evidenceRefs: [],
      planRevision: { retainedStepIds: [], goal: userInput, selectedSkillIds: [], steps: [{ id: "answer.repair.2", objective: userInput,
        dependencies: [], skillIds: [], requiredCapabilities: ["conversation_delivery"], targetIds: step.executionBinding.targetIds,
        requiredFacts: step.requiredFacts, successCriteria: step.successCriteria }] },
    } }] };
  } }).decide({ runId: state.runId, userInput, canonicalState: state, plan, events: [], userResponses: [], action: {
    id: "recovery-action", runId: state.runId, kind: "recovery_review", state: "recovery_required", attempt: 1, maxAttempts: 3,
    replayPolicy: "safe", fence: 1, revision: 1, metadata: {}, effectState: "not_started", createdAt: 1, updatedAt: 1,
  } });
  assert.equal(JSON.stringify(plan), before, "the admitted Plan and provenance remain unchanged");
  assert.equal(decision.planRevision!.steps[0]!.successCriteria[0]!.basis!.intentId, state.intent.id);
  assert.equal(decision.planRevision!.steps[0]!.successCriteria[0]!.basis!.requirement, userInput);
  const revised = admitPlan({ runId: state.runId, canonicalState: state, proposal: decision.planRevision!, availableSkills: [], availableToolNames: new Set() });
  assert.equal(revised.steps[0]!.successCriteria.filter(criterion => criterion.id === "delivery_target:comparison").length, 1);
});
