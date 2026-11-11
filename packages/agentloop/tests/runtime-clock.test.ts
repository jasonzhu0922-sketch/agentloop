import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoInferredCalendarDates, createRuntimeClock, parseRecurringTimeCondition, resolveTemporalScope, withRuntimeClock } from "../src/runtime/runtime-clock.ts";
import { temporalEvidenceGap } from "../src/runtime/temporal-evidence.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import type { ModelInvocation } from "../src/runtime/contracts.ts";
import { AppError } from "../src/shared/errors.ts";

for (const fixture of [
  ...["continue_prior", "correct_prior", "refine_prior", "challenge_prior"].map((relation) => ({ relation, priorStatus: "completed", invalidQuote: false })),
  { relation: "continue_prior", priorStatus: "failed", invalidQuote: false },
  { relation: "refine_prior", priorStatus: "completed", invalidQuote: true },
]) {
  const { relation, priorStatus, invalidQuote } = fixture;
  test(`prior time provenance repairs binding (${relation}, prior=${priorStatus}, invalidQuote=${invalidQuote})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentloop-prior-clock-repair-"));
    const database = new AppDatabase(":memory:");
    const priorInput = "我最近一周收到了哪些邮件？";
    const followup = "根据邮件内容生成一份 html 格式的信息汇总";
    let attempts = 0;
    let reachedPlanner = false;
    let priorRunId: string | undefined;
    try {
      const service = new RunService({ database, skills: new SkillService(database), workspaceRoot: root,
        timeZone: "Asia/Shanghai", clock: () => Date.parse("2026-11-04T10:46:08Z"),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
          if (!request.runId.startsWith("conversation-turn:")) return { content: "已有邮件内容。", finishReason: "stop", toolCalls: [] };
          attempts += 1;
          const context = JSON.parse(request.runtimeContext!.content.split("\n")[1]);
          const candidate = context.conversationWorkingSet.priorGoalCandidates.find((item: { input?: string; status?: string }) => item.input === priorInput && item.status === priorStatus);
          assert.ok(candidate);
          const repaired = attempts > 2 || request.systemPrompt.includes(`relation=${relation} requires targetGoalCandidateId`)
            || request.messages.some((message) => message.role === "tool" && message.content.includes(`relation=${relation} requires targetGoalCandidateId`));
          if (attempts > 1) {
            assert.ok(repaired, "repair must identify the missing lineage, not reject a valid prior time quote");
            if (attempts === 2) assert.doesNotMatch(request.systemPrompt, /Rejected expression/);
          }
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `intent-${attempts}`, name: "resolve_conversation_turn", arguments: {
            mode: "execute", relation, inputMode: "refresh_sources", effectiveGoal: followup,
            ...(repaired ? { targetGoalCandidateId: candidate.candidateId } : {}),
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "create_artifact", requiresExecution: true,
              deliverables: [{ targetId: "mail-summary", purpose: followup, expectedArtifactCount: 1, action: "create", kind: "html", format: "html", surface: "workspace_artifact" }] },
            evidenceStrategy: "source_grounded", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
            memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
            temporalScope: { expression: invalidQuote ? "上个月" : "最近一周", basis: "runtime_clock", startDayOffset: -6, endAtReferenceInstant: true },
          } }] };
        } }),
        plannerFactory: () => ({ plan: async (task) => {
          if (task.canonicalState.intent.userInput !== followup) return singleStepTestPlanner().plan(task);
          const resolution = task.canonicalState.intent.turnResolution!;
          assert.equal(resolution.targetRunId, priorRunId);
          assert.equal(resolution.temporalScope?.expression, "最近一周");
          assert.equal(resolution.temporalScope?.startInclusive, "2026-10-28T16:00:00.000Z");
          assert.equal(resolution.temporalScope?.endExclusive, "2026-11-04T10:46:08.000Z");
          assert.equal(resolution.taskIntent?.deliverables[0]?.kind, "html");
          reachedPlanner = true;
          throw new AppError("PLANNING_ERROR", "verified follow-up reached Planner", 422);
        } }),
        assessorFactory: () => approvingTestAssessor(),
      });
      // Durable history from the incident: one pre-plan failure, then a
      // completed mail query. No live mailbox or provider is used by this test.
      await service.ensureConversation("owner", "mail-conversation", priorInput);
      for (const [id, status, time] of [["failed-mail", "failed", 1], ["completed-mail", "completed", 2]] as const) {
        await database.prepare("INSERT INTO runs (id, owner_user_id, conversation_id, depth, status, input, created_at) VALUES (?, 'owner', 'mail-conversation', 0, ?, ?, ?)")
          .run(id, status, priorInput, time);
      }
      await database.prepare("INSERT INTO plans (id, run_id, version, goal, selected_skill_ids_json, canonical_state_ref_json, status, created_at, updated_at) VALUES ('mail-plan', 'completed-mail', 1, ?, '[]', ?, 'completed', 2, 2)")
        .run(priorInput, JSON.stringify({ stateId: "mail-state", runId: "completed-mail", intentId: "mail-intent", revision: 1 }));
      // A different turn's time expression is visible but must not become
      // provenance for the selected mail query.
      await database.prepare("INSERT INTO runs (id, owner_user_id, conversation_id, depth, status, input, created_at) VALUES ('unrelated', 'owner', 'mail-conversation', 0, 'completed', '解释上个月这个时间范围', 3)").run();
      priorRunId = priorStatus === "failed" ? "failed-mail" : "completed-mail";
      if (invalidQuote) {
        const paused = await service.executeConversation("owner", followup, { conversationId: "mail-conversation" });
        assert.equal(paused.status, "running");
        assert.equal((await service.currentHumanLoop("owner", paused.id))?.origin, "planner");
        const events = await service.events("owner", paused.id);
        assert.equal(events.some((event) => event.type === "canonical_run_state.initialized"), false);
      } else {
        await assert.rejects(() => service.executeConversation("owner", followup, { conversationId: "mail-conversation" }), (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.match(error.message, /verified follow-up reached Planner/);
          return true;
        });
      }
      assert.equal(attempts, invalidQuote ? 3 : 2);
      assert.equal(reachedPlanner, !invalidQuote);
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("relative calendar bounds use the Run's local date, not UTC or the model's guessed year", () => {
  const clock = createRuntimeClock(Date.parse("2026-10-31T16:15:00Z"), "Asia/Shanghai");
  assert.equal(clock.localDate, "2026-11-01");
  assert.ok(Object.isFrozen(clock));
  const scope = resolveTemporalScope({ expression: "最近 5 天", basis: "runtime_clock", startDayOffset: -4, endDayOffset: 1 }, clock, ["统计最近 5 天"]);
  assert.equal(scope.startInclusive, "2026-10-27T16:00:00.000Z");
  assert.equal(scope.endExclusive, "2026-11-01T16:00:00.000Z");
  assert.equal(scope.anchorDateTimeIso, clock.anchorDateTimeIso);
  assert.throws(() => resolveTemporalScope({ expression: "最近 5 天", basis: "runtime_clock", startDayOffset: -4, endDayOffset: 1, startInclusive: "2025-07-05" }, clock, ["最近 5 天"]), /not model-invented/);
  assert.throws(() => resolveTemporalScope({ expression: "invented", basis: "runtime_clock", startDayOffset: -4, endDayOffset: 1 }, clock, ["最近 5 天"]), /quote/);
  assert.equal(resolveTemporalScope({ expression: "最近5天", basis: "runtime_clock", startDayOffset: -4, endDayOffset: 1 }, clock, ["统计最近 5 天"]).expression, "最近 5 天");
  assert.throws(() => resolveTemporalScope({ expression: "notable", basis: "runtime_clock", startDayOffset: -4, endDayOffset: 1 }, clock, ["not able"]), /quote/);
});

test("calendar-month scopes preserve exact month buckets across year, leap day and DST boundaries", () => {
  const clock = createRuntimeClock(Date.parse("2026-11-11T13:30:26.475Z"), "Asia/Shanghai");
  const current = resolveTemporalScope({ expression: "最近12个月", basis: "runtime_clock", alignment: "calendar_month",
    startMonthOffset: -11, endAtReferenceInstant: true }, clock, ["查询最近12个月各月销售额"]);
  assert.equal(current.startInclusive, "2025-11-30T16:00:00.000Z");
  assert.equal(current.endExclusive, clock.anchorDateTimeIso);
  assert.equal(current.alignment, "calendar_month");
  const completed = resolveTemporalScope({ expression: "最近12个月", basis: "runtime_clock", alignment: "calendar_month",
    startMonthOffset: -12, endMonthOffset: 0 }, clock, ["查询最近12个月各月销售额"]);
  assert.equal(completed.startInclusive, "2025-10-31T16:00:00.000Z");
  assert.equal(completed.endExclusive, "2026-10-31T16:00:00.000Z");
  const leap = createRuntimeClock(Date.parse("2024-03-31T12:00:00Z"), "America/New_York");
  const previous = resolveTemporalScope({ expression: "上个月", basis: "runtime_clock", alignment: "calendar_month",
    startMonthOffset: -1, endMonthOffset: 0 }, leap, ["统计上个月"]);
  assert.equal(previous.startInclusive, "2024-02-01T05:00:00.000Z");
  assert.equal(previous.endExclusive, "2024-03-01T05:00:00.000Z");
  assert.throws(() => resolveTemporalScope({ expression: "上个月", basis: "runtime_clock", alignment: "calendar_month",
    startMonthOffset: -1, endMonthOffset: 0, startDayOffset: -30 }, leap, ["上个月"]), /month offsets only/);
  assert.throws(() => resolveTemporalScope({ expression: "上个月", basis: "runtime_clock", startMonthOffset: -1, endMonthOffset: 0 }, leap, ["上个月"]), /calendar_month alignment/);
  assert.throws(() => resolveTemporalScope({ expression: "上个月", basis: "runtime_clock", alignment: "elapsed_seconds",
    startMonthOffset: -1, startSecondOffset: -3600, endSecondOffset: 0 }, leap, ["上个月"]), /calendar_month alignment/);
  const invocation = withRuntimeClock({ runId: "months", phase: "execution", systemPrompt: "Test", messages: [], tools: [] }, clock, current);
  assert.match(invocation.systemPrompt, /Derive query filters and display buckets from the same/);
  assert.match(invocation.systemPrompt, /2025-11-30T16:00:00.000Z/);
});

test("calendar days preserve DST boundaries and historical references do not mutate the clock", () => {
  const clock = createRuntimeClock(Date.parse("2026-11-01T16:00:00Z"), "America/New_York");
  const scope = resolveTemporalScope({ expression: "today", basis: "runtime_clock", startDayOffset: 0, endDayOffset: 1 }, clock, ["today"]);
  assert.equal(scope.startInclusive, "2026-11-01T04:00:00.000Z");
  assert.equal(scope.endExclusive, "2026-11-02T05:00:00.000Z");
  const historical = resolveTemporalScope({ expression: "2024-02-29", basis: "user_explicit", timeZone: "UTC", startInclusive: "2024-02-29T00:00:00Z", endExclusive: "2024-03-01T00:00:00Z" }, clock, ["请查询 2024-02-29"]);
  assert.equal(historical.basis, "user_explicit");
  assert.equal(clock.localDate, "2026-11-01");
  const wrongZone = { expression: "today", basis: "runtime_clock", timeZone: "Asia/Shanghai", startDayOffset: 0, endDayOffset: 1 };
  assert.throws(() => resolveTemporalScope(wrongZone, clock, ["today"]), /explicitly requested/);
});

test("calendar windows through now include the current partial day without guessed exclusive-midnight offsets", () => {
  const clock = createRuntimeClock(Date.parse("2026-11-01T05:01:56.649Z"), "Asia/Shanghai");
  const spec = { expression: "最近5天要包含今天", basis: "runtime_clock", startDayOffset: -4, endAtReferenceInstant: true };
  const scope = resolveTemporalScope(spec, clock, ["最近5天要包含今天，按北京时间重新统计"]);
  assert.equal(scope.startInclusive, "2026-10-27T16:00:00.000Z");
  assert.equal(scope.endExclusive, clock.anchorDateTimeIso);
  assert.throws(() => resolveTemporalScope({ ...spec, endDayOffset: 0 }, clock, [spec.expression]), /not both/);
  assert.throws(() => assertNoInferredCalendarDates(["最近5天包含今天（2026-11-01）"], [spec.expression]), /runtime-derived ISO dates/);
  assert.doesNotThrow(() => assertNoInferredCalendarDates(["最近5天包含今天"], [spec.expression]));
  assert.doesNotThrow(() => assertNoInferredCalendarDates(["统计2024-02-29"], ["查询2024-02-29"]));
});

test("coverage is interval-based for arbitrary ranges and unions; text-only and truncated receipts cannot prove zero", () => {
  const clock = createRuntimeClock(Date.parse("2026-11-01T04:20:00Z"), "Asia/Shanghai");
  const scope = resolveTemporalScope({ expression: "最近 13 天", basis: "runtime_clock", startDayOffset: -12, endDayOffset: 1 }, clock, ["最近 13 天"]);
  const receipt = (start: string, end: string, complete = true) => JSON.stringify({ data: { temporalCoverage: { startInclusive: start, endExclusive: end, timeZone: "Asia/Shanghai", complete } } });
  assert.equal(temporalEvidenceGap(scope, [receipt(scope.startInclusive, scope.endExclusive)]), undefined);
  assert.match(temporalEvidenceGap(scope, [receipt(scope.startInclusive, scope.endExclusive, false)])!, /complete coverage/);
  assert.match(temporalEvidenceGap(scope, [JSON.stringify({ data: { messages: [], temporalCoverage: { complete: false } } })])!, /Literal date keyword/);
  const midpoint = "2026-10-26T16:00:00Z";
  assert.equal(temporalEvidenceGap(scope, [receipt(scope.startInclusive, midpoint), receipt(midpoint, scope.endExclusive)]), undefined);
  assert.match(temporalEvidenceGap(scope, [receipt("2025-07-05T00:00:00Z", "2025-07-10T00:00:00Z")])!, /complete coverage/);
  const shortScope = { ...scope, endExclusive: "2026-11-01T04:20:00.313Z" };
  const gap = temporalEvidenceGap(shortScope, [receipt(scope.startInclusive, "2026-11-01T04:20:00.000Z")])!;
  assert.match(gap, /"startInclusive":"2026-11-01T04:20:00.000Z","endExclusive":"2026-11-01T04:20:00.313Z"/);
  const split = temporalEvidenceGap(scope, [receipt(scope.startInclusive, midpoint), receipt("2026-10-27T16:00:00Z", scope.endExclusive)])!;
  assert.match(split, /2026-10-26T16:00:00.000Z.*2026-10-27T16:00:00.000Z/);
});

test("all model phases use one persisted clock across midnight; derived bounds remain separate from user constraints", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-runtime-clock-"));
  const database = new AppDatabase(":memory:");
  const anchor = Date.parse("2026-10-31T15:59:59Z");
  let now = anchor;
  const calls: ModelInvocation[] = [];
  const goal = "解释最近 5 天这个时间范围";
  try {
    const service = new RunService({ database, skills: new SkillService(database), workspaceRoot: root,
      clock: () => now, timeZone: "Asia/Shanghai",
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        calls.push(request);
        if (request.runId.startsWith("conversation-turn:")) {
          const context = JSON.parse(request.runtimeContext!.content.split("\n")[1]);
          assert.equal(context.runtimeClock.localDate, "2026-10-31");
          now = anchor + 120_000; // cross midnight before planning/execution
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "intent", name: "resolve_conversation_turn", arguments: {
            mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: true,
              deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
            evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: ["最近 5 天"],
            memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
            temporalScope: { expression: "最近 5 天", basis: "runtime_clock", startDayOffset: -4, endDayOffset: 1 },
          } }] };
        }
        return { content: "按本轮开始时的日期解释，范围包含今天这个尚未结束的自然日。", finishReason: "stop", toolCalls: [] };
      } }),
      plannerFactory: (model) => ({ plan: async (task) => {
        assert.deepEqual(task.canonicalState.intent.turnResolution?.userConstraints, ["最近 5 天"]);
        assert.equal(task.canonicalState.intent.turnResolution?.temporalScope?.startInclusive, "2026-10-26T16:00:00.000Z");
        await model.complete({ runId: "clock-planner-probe", phase: "planning", systemPrompt: "planner", messages: [], tools: [] });
        return singleStepTestPlanner().plan(task);
      } }),
      assessorFactory: (model) => ({ assess: async (input) => {
        await model.complete({ runId: "clock-assessor-probe", phase: "assessment", systemPrompt: "assessor", messages: [], tools: [] });
        return approvingTestAssessor().assess(input);
      } }),
    });
    const run = await service.executeConversation("owner", goal, { allowDangerousTools: false });
    assert.equal(run.status, "completed", run.output);
    assert.ok(calls.some((request) => request.phase === "execution"));
    assert.ok(calls.some((request) => request.phase === "assessment"));
    for (const request of calls) {
      const clock = JSON.parse(request.systemPrompt.split('<runtime_time_context source="server">\n')[1].split("\n")[0]);
      assert.equal(clock.anchorDateTimeIso, new Date(anchor).toISOString());
      assert.equal(clock.localDate, "2026-10-31");
      if (!request.runId.startsWith("conversation-turn:")) assert.match(request.systemPrompt, /resolved_temporal_scope/);
    }
    const events = await service.events("owner", run.id);
    assert.equal((events.find((event) => event.type === "run.started")!.data.runtimeClock as { localDate: string }).localDate, "2026-10-31");
    const state = await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id=?").get(run.id) as { state_json: string };
    assert.equal(JSON.parse(state.state_json).intent.runtimeClock.anchorDateTimeIso, new Date(anchor).toISOString());
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("the frozen clock is also projected into compaction invocations", () => {
  const clock = createRuntimeClock(Date.parse("2026-11-01T04:00:00Z"), "Asia/Shanghai");
  const request = withRuntimeClock({ runId: "compact", phase: "compaction", systemPrompt: "summarize", messages: [], tools: [] }, clock);
  assert.match(request.systemPrompt, /2026-11-01T04:00:00.000Z/);
});

test("recurring time condition must be grounded in the user's exact words", () => {
  assert.deepEqual(parseRecurringTimeCondition({ kind: "recurring", expression: "每天23:00到次日05:00" }, ["统计每天23:00到次日05:00的记录"]),
    { kind: "recurring", expression: "每天23:00到次日05:00" });
  assert.equal(parseRecurringTimeCondition({ kind: "recurring", expression: "23:00-05:00" }, ["半夜打车"]), undefined);
  assert.equal(parseRecurringTimeCondition({ kind: "recurring", expression: "半夜", startLocalTime: "23:00" }, ["半夜打车"]), undefined);
});

for (const withDateRange of [false, true]) test(`recurring condition survives resolver repair, persistence and model phases (date range=${withDateRange})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-recurring-time-"));
  const database = new AppDatabase(":memory:");
  const goal = withDateRange ? "查询最近 5 天半夜打车记录" : "查询半夜打车记录";
  let attempts = 0;
  const calls: ModelInvocation[] = [];
  try {
    const service = new RunService({ database, skills: new SkillService(database), workspaceRoot: root,
      clock: () => Date.parse("2026-11-01T04:00:00Z"), timeZone: "Asia/Shanghai",
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        calls.push(request);
        if (!request.runId.startsWith("conversation-turn:")) return { content: "结果。", finishReason: "stop", toolCalls: [] };
        attempts++;
        if (attempts === 2) assert.match(request.systemPrompt, /recurring conditions in recurringTime/);
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `intent-${attempts}`, name: "resolve_conversation_turn", arguments: {
          mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
            deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
          evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
          memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
          ...(attempts === 1 ? { temporalScope: { expression: "半夜", basis: "runtime_clock" } } : {
            recurringTime: { kind: "recurring", expression: "半夜" },
            ...(withDateRange ? { temporalScope: { expression: "最近 5 天", basis: "runtime_clock", startDayOffset: -4, endDayOffset: 1 } } : {}),
          }),
        } }] };
      } }),
      plannerFactory: (model) => ({ plan: async (task) => {
        assert.deepEqual(task.canonicalState.intent.turnResolution?.recurringTime, { kind: "recurring", expression: "半夜" });
        assert.equal(task.canonicalState.intent.turnResolution?.temporalScope !== undefined, withDateRange);
        await model.complete({ runId: "recurring-planner-probe", phase: "planning", systemPrompt: "planner", messages: [], tools: [] });
        return singleStepTestPlanner().plan(task);
      } }), assessorFactory: () => approvingTestAssessor(),
    });
    const run = await service.executeConversation("owner", goal);
    assert.equal(run.status, "completed");
    assert.equal(attempts, 2);
    const events = await service.events("owner", run.id);
    const rejection = events.find((event) => event.type === "conversation.turn.resolution_rejected")!;
    assert.deepEqual(rejection.data.temporalScopeFields, ["expression", "basis"]);
    assert.equal(rejection.data.capabilityReferenceShape, "array");
    assert.equal(rejection.data.capabilityReferenceCount, 0);
    assert.equal(rejection.data.recurringTimePresent, false);
    const state = await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id=?").get(run.id) as { state_json: string };
    assert.deepEqual(JSON.parse(state.state_json).intent.turnResolution.recurringTime, { kind: "recurring", expression: "半夜" });
    const projected = calls.filter((request) => !request.runId.startsWith("conversation-turn:"));
    assert.ok(projected.some((request) => request.phase === "execution"));
    assert.ok(projected.every((request) => request.systemPrompt.includes('<recurring_time_condition source="user-quote">')));
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

for (const simultaneous of [false, true]) test(`bounded resolver repair preserves validation context (simultaneous=${simultaneous})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-clock-repair-"));
  const database = new AppDatabase(":memory:");
  let attempts = 0;
  const goal = "解释最近 5 天这个时间范围";
  try {
    const service = new RunService({ database, skills: new SkillService(database), workspaceRoot: root,
      timeZone: "Asia/Shanghai", clock: () => Date.parse("2026-11-01T04:00:00Z"),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (!request.runId.startsWith("conversation-turn:")) return { content: "范围包含今天这个尚未结束的自然日。", finishReason: "stop", toolCalls: [] };
        attempts += 1;
        if (attempts === 3) {
          assert.doesNotMatch(request.systemPrompt, /requiredCapabilityReferences must be/);
          assert.match(request.systemPrompt, /temporalScope.expression must quote/);
          const rejectedCalls = request.messages.filter((message) => message.role === "assistant" && message.toolCalls?.length);
          const rejections = request.messages.filter((message) => message.role === "tool");
          assert.equal(rejectedCalls.length, 2);
          assert.equal(rejections.length, 2);
          assert.ok(rejections.every((message) => JSON.parse(message.content).operationExecuted === false));
        }
        if (simultaneous && attempts === 2) {
          assert.match(request.systemPrompt, /requiredCapabilityReferences must be/);
          assert.match(request.systemPrompt, /userConstraints\[0\]: Keep runtime-derived ISO dates/);
          assert.match(request.systemPrompt, /temporalScope.expression must quote/);
          assert.equal(request.messages.filter((message) => message.role === "tool").length, 1);
        }
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `intent-${attempts}`, name: "resolve_conversation_turn", arguments: {
          mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: true,
            deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
          evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [simultaneous && attempts === 1 ? "最近5天含今天2026-11-01" : "最近 5 天"],
          memoryAction: "none", memoryIntents: [],
          requiredCapabilityReferences: attempts === 1 ? [{ kind: "tool", reference: "invented-tool" }] : [],
          temporalScope: { expression: attempts === (simultaneous ? 1 : 2) ? "最近5天，含今天" : "最近 5 天", basis: "runtime_clock", startDayOffset: -4, endDayOffset: 1 },
        } }] };
      } }),
      plannerFactory: () => singleStepTestPlanner(), assessorFactory: () => approvingTestAssessor(),
    });
    const run = await service.executeConversation("owner", goal);
    assert.equal(run.status, "completed", run.output);
    assert.equal(attempts, simultaneous ? 2 : 3);
    const events = await service.events("owner", run.id);
    assert.equal(events.filter((event) => event.type === "conversation.turn.resolution_rejected").length, simultaneous ? 1 : 2);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
