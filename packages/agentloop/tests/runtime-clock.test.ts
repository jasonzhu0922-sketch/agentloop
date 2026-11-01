import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoInferredCalendarDates, createRuntimeClock, resolveTemporalScope, withRuntimeClock } from "../src/runtime/runtime-clock.ts";
import { temporalEvidenceGap } from "../src/runtime/temporal-evidence.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import type { ModelInvocation } from "../src/runtime/contracts.ts";

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
          assert.match(request.systemPrompt, /requiredCapabilityReferences must be/);
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
