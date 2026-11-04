import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunService } from "../src/runtime/run-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppError } from "../src/shared/errors.ts";
import type { ModelResponse } from "../src/runtime/contracts.ts";
import type { TaskSpec } from "../src/planning/contracts.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

function resolve(args: Record<string, unknown>): ModelResponse {
  return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: args }] };
}

function intent(goal: string, mode = "execute", kind = "none") {
  return {
    mode, relation: "new_goal", inputMode: "none", effectiveGoal: goal,
    evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
    userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
    taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: kind === "html" ? "create_artifact" : "analysis",
      requiresExecution: mode === "execute", deliverables: [{ targetId: "summary", purpose: goal, expectedArtifactCount: 1,
        action: kind === "html" ? "create" : "none", kind, surface: kind === "html" ? "workspace_artifact" : "conversation" }] },
  };
}

for (const kind of ["none", "html"]) test(`history reconstruction carries the latest output and exact prior Result to a new Plan (${kind})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-history-reconstruction-"));
  const database = new AppDatabase(":memory:");
  const priorInput = "整理我最近一周收到的邮件，邮件内容已提供。";
  const latest = kind === "html" ? "根据邮件内容生成一份 html 格式的信息汇总" : "把上一轮的邮件内容汇总成一句话";
  const priorContent = "已提供邮件列表。" + "这是历史邮件的正文内容。".repeat(180) + "最后一封邮件编号 INV-38。";
  let phase: "failed" | "seed" | "followup" = "failed";
  let now = Date.parse("2026-11-04T10:44:45Z");
  let attempts = 0;
  let resultId: string | undefined;
  let captured: TaskSpec | undefined;
  try {
    const service = new RunService({ database, skills: new SkillService(database), workspaceRoot: root,
      clock: () => now, timeZone: "Asia/Shanghai",
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (phase === "failed") throw new AppError("MODEL_ERROR", "fixture provider outage before planning", 502);
        if (request.runId.startsWith("conversation-turn:")) {
          if (phase === "seed") return resolve({ ...intent(priorInput), userConstraints: ["保留邮件编号"],
            temporalScope: { expression: "最近一周", basis: "runtime_clock", startDayOffset: -6, endAtReferenceInstant: true } });
          attempts++;
          const context = JSON.parse(request.runtimeContext!.content.split("\n")[1]);
          if (attempts === 1) {
            assert.equal(context.historyReconstruction, undefined);
            return resolve({ ...intent(latest, "execute", kind), relation: "continue_prior", inputMode: "refresh_sources" });
          }
          assert.match(request.systemPrompt, /Reconstruct the current task/);
          assert.equal(request.messages.some((message) => message.role === "tool"), false, "reconstruction must not anchor on the rejected call");
          assert.equal(context.historyReconstruction.schema, "agentloop.conversationHistoryReconstruction/v1");
          assert.deepEqual(context.historyReconstruction.chronology.map((run: { status: string }) => run.status), ["failed", "completed"]);
          assert.ok(context.historyReconstruction.chronology.every((run: { input: string }) => run.input === priorInput));
          const plan = context.historyReconstruction.priorPlans[0];
          assert.equal(plan.steps[0].status, "completed");
          const result = context.conversationWorkingSet.reusableResultCandidates[0];
          assert.equal(result.goalCandidateId, plan.goalCandidateId);
          assert.equal(result.summaryTruncated, true);
          assert.ok(context.conversationWorkingSet.priorGoalCandidates.some((goal: { failedBoundary?: unknown }) => goal.failedBoundary));
          return resolve({ ...intent(latest, "execute", kind), relation: kind === "html" ? "continue_prior" : "refine_prior",
            inputMode: "prior_result", resultCandidateId: result.candidateId, userConstraints: ["保留邮件编号"],
            // No duplicate targetGoalCandidateId: Runtime owns Result provenance.
          });
        }
        if (phase === "seed") return { content: priorContent, finishReason: "stop", toolCalls: [] };
        const read = request.messages.findLast((message) => message.role === "tool" && message.name === "read_result");
        if (read === undefined) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "read-history", name: "read_result", arguments: { resultId } }] };
        assert.match(read.content, /INV-38/, "execution reads exact data beyond the history summary");
        return { content: "邮件汇总已包含最后一封邮件 INV-38。", finishReason: "stop", toolCalls: [] };
      } }),
      plannerFactory: () => ({ plan: async (task) => {
        if (phase === "followup") {
          captured = task;
          resultId = task.canonicalState.intent.turnResolution?.targetResult?.resultId;
          assert.ok(resultId);
          if (kind === "html") throw new AppError("PLANNING_ERROR", "HTML task reconstructed and handed to Planner", 422);
        }
        return singleStepTestPlanner().plan(task);
      } }),
      assessorFactory: () => approvingTestAssessor(),
    });
    await service.ensureConversation("owner", "history", priorInput);
    await assert.rejects(() => service.executeConversation("owner", priorInput, { conversationId: "history" }), /fixture provider outage/);
    phase = "seed"; now++;
    const seed = await service.executeConversation("owner", priorInput, { conversationId: "history" });
    assert.equal(seed.status, "completed", seed.output);
    const oldPlan = await service.plan("owner", seed.id);
    const oldResolution = (await service.events("owner", seed.id)).find((event) => event.type === "conversation.turn.resolved")!.data;
    phase = "followup"; now += 86_400_000;
    let followupId: string;
    if (kind === "html") {
      followupId = "";
      await assert.rejects(() => service.executeConversation("owner", latest, { conversationId: "history" }), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.message, /HTML task reconstructed and handed to Planner/);
        followupId = String(error.details?.runId);
        return true;
      });
    } else {
      const followup = await service.executeConversation("owner", latest, { conversationId: "history" });
      followupId = followup.id;
      assert.equal(followup.status, "completed", followup.output);
      assert.match(followup.output!, /INV-38/);
      const newPlan = await service.plan("owner", followup.id);
      assert.notEqual(newPlan.plan.id, oldPlan.plan.id);
      assert.equal(newPlan.plan.goal, latest);
      assert.equal(newPlan.plan.resultBindings?.[0]?.result.resultId, resultId);
    }
    assert.equal(attempts, 2);
    const resolution = captured?.canonicalState.intent.turnResolution;
    assert.equal(resolution?.effectiveGoal, latest);
    assert.equal(resolution?.relation, "refine_prior");
    assert.equal(resolution?.targetRunId, seed.id);
    assert.equal(resolution?.taskIntent.deliverables[0]?.kind, kind);
    assert.deepEqual(resolution?.temporalScope, oldResolution.temporalScope, "format changes keep the historical interval across midnight");
    assert.deepEqual(resolution?.userConstraints, ["保留邮件编号"]);
    assert.deepEqual(await service.plan("owner", seed.id), oldPlan, "reconstruction never edits the historical Plan");
    const events = await service.events("owner", followupId);
    assert.equal(events.filter((event) => event.type === "conversation.turn.reconstruction_started").length, 1);
    assert.equal(events.filter((event) => event.type === "conversation.turn.reconstruction_completed").length, 1);
    assert.ok(events.some((event) => event.type === "model.request.started" && event.data.purpose === "conversation_history_reconstruction"));
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

for (const outcome of ["model_clarifies", "binding_unresolved", "invalid_shape"]) test(`unresolved history preserves boundaries (${outcome})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-history-unresolved-"));
  const database = new AppDatabase(":memory:");
  let attempts = 0;
  let plannerCalls = 0;
  try {
    const service = new RunService({ database, skills: new SkillService(database), workspaceRoot: root,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) {
          attempts++;
          if (attempts > 1 && outcome === "model_clarifies") return resolve(intent("询问用户指的是哪一份分析结果", "clarify"));
          if (attempts > 1 && outcome === "invalid_shape") return resolve({ ...intent("生成 HTML 汇总"),
            relation: "refine_prior", targetGoalCandidateId: "invented-candidate", memoryAction: "invalid" });
          return resolve({ ...intent("生成 HTML 汇总"), relation: "refine_prior", targetGoalCandidateId: "invented-candidate" });
        }
        assert.deepEqual(request.tools, []);
        return { content: "你希望使用哪一份分析结果？请提供名称或内容。", finishReason: "stop", toolCalls: [] };
      } }),
      plannerFactory: () => ({ plan: async (task) => {
        plannerCalls++;
        assert.equal(task.canonicalState.intent.turnResolution?.mode, "clarify");
        assert.equal(task.canonicalState.intent.turnResolution?.targetRunId, undefined);
        assert.deepEqual(task.availableToolNames, []);
        return singleStepTestPlanner().plan(task);
      } }), assessorFactory: () => approvingTestAssessor(),
    });
    const execute = () => service.executeConversation("owner", "把上一轮的分析结果生成 HTML 汇总");
    if (outcome === "invalid_shape") {
      await assert.rejects(execute, (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.match(error.message, /canonical contract after 3 attempts/);
        assert.match(String(error.details?.repairFeedback), /memoryAction must be/);
        return true;
      });
      assert.equal(plannerCalls, 0);
    } else {
      const run = await execute();
      assert.equal(run.status, "completed", run.output);
      assert.match(run.output!, /哪一份/);
      assert.equal(plannerCalls, 1);
      const events = await service.events("owner", run.id);
      assert.equal(events.some((event) => event.type === "run.failed"), false);
      assert.equal(events.some((event) => event.type === "conversation.turn.reconstruction_unresolved"), outcome === "binding_unresolved");
    }
    assert.equal(attempts, outcome === "model_clarifies" ? 2 : 3);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
