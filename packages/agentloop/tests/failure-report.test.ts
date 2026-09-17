import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import type { ModelResponse, RuntimeEvent } from "../src/runtime/contracts.ts";
import { AppError } from "../src/shared/errors.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { CompletionFailure } from "../src/runtime/completion-failure.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

for (const stop of ["budget", "no_progress"] as const) {
  test(`${stop} exit reports current work against the goal in one extra tool-free turn`, async () => {
    let calls = 0;
    let executions = 0;
    let reports = 0;
    const grant = createCapabilityGrant({ runId: stop, actorUserId: "user", depth: 0, allowedToolNames: ["read"], allowedSkillIds: [] });
    const events: RuntimeEvent[] = [];
    await assert.rejects(runAgentLoop({
      runId: stop, grant, systemPrompt: "分析价格趋势", input: "分析价格趋势并说明覆盖范围",
      maxSteps: stop === "budget" ? 2 : 8,
      tools: new ToolRegistry([{ name: "read", description: "Read", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
        parse: (value) => { if (!(value as { valid: boolean }).valid) throw new TypeError("valid is required"); return value; },
        execute: async () => { executions += 1; return { observedPrices: [3540, 3590], coverage: "partial" }; },
      }]),
      model: { limits: TEST_MODEL_LIMITS, complete: async (request) => {
        calls += 1;
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          reports += 1;
          assert.deepEqual(request.tools, []);
          assert.match(JSON.stringify(request.messages), /3540/);
          assert.match(request.runtimeContext?.content ?? "", /original user goal/);
          return { content: "当前记录从 3540 到 3590，但覆盖不完整，尚不能完成全区间走势分析。", finishReason: "stop", toolCalls: [] };
        }
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `read-${calls}`, name: "read", arguments: { valid: stop === "budget" || calls === 1 } }] };
      } },
      emit: (event) => { events.push(event); },
    }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "RUN_LIMIT_EXCEEDED");
      assert.match(String(error.details?.partialOutput), /3540.*3590/);
      if (stop === "no_progress") assert.equal(error.details?.stalled, true);
      return true;
    });
    assert.equal(reports, 1);
    assert.equal(executions, 1); // Reserved/final reporting turns execute no tools.
    assert.equal(events.filter((event) => event.type === "failure_report.started").length, 1);
    assert.equal(events.some((event) => event.type === "loop.completed"), false);
  });
}

test("recoverable leaf defers reporting until the Run owner actually chooses failure", async () => {
  let calls = 0;
  const grant = createCapabilityGrant({ runId: "deferred", actorUserId: "user", depth: 0, allowedToolNames: [], allowedSkillIds: [] });
  let failure: CompletionFailure | undefined;
  await assert.rejects(runAgentLoop({
    runId: grant.runId, grant, systemPrompt: "Test", input: "Test", maxSteps: 1, candidateRepairAssessmentLimit: 0,
    deferFailureReport: true, tools: new ToolRegistry([]),
    model: { limits: TEST_MODEL_LIMITS, complete: async () => { calls += 1; return { content: "已有部分成果，验证未完成。", finishReason: "stop", toolCalls: [] }; } },
    evaluateCandidate: async () => ({ approved: false, feedback: "Validation incomplete" }),
  }), (error: unknown) => { assert.ok(error instanceof CompletionFailure); failure = error; return true; });
  assert.equal(calls, 1);
  assert.ok(failure);
  const [first, second] = await Promise.all([failure.report(), failure.report()]);
  assert.equal(calls, 2);
  assert.equal(first, second);
  assert.match(first, /任务未完成/);
});

test("exhausted assessment adds exactly one tool-free report without reassessment or completion", async () => {
  let calls = 0;
  let assessments = 0;
  const events: RuntimeEvent[] = [];
  const grant = createCapabilityGrant({ runId: "report", actorUserId: "user", depth: 0, allowedToolNames: [], allowedSkillIds: [] });
  await assert.rejects(runAgentLoop({
    runId: grant.runId, systemPrompt: "分析", input: "分析数据", grant,
    tools: new ToolRegistry([]), maxSteps: 1, candidateRepairAssessmentLimit: 0,
    model: { limits: TEST_MODEL_LIMITS, complete: async (request) => {
      calls += 1;
      if (calls === 2) {
        assert.deepEqual(request.tools, []);
        assert.match(request.runtimeContext?.content ?? "", /runtime_failure_report/);
        assert.match(request.runtimeContext?.content ?? "", /schema_summary/);
        return { content: "取得部分价格记录；结构预检的证据尚未确认，不能作完整结论。", finishReason: "stop", toolCalls: [] };
      }
      return { content: "尚未通过验收的结论", finishReason: "stop", toolCalls: [] };
    } },
    evaluateCandidate: async () => {
      assessments += 1;
      return { approved: false, feedback: "Missing bound schema receipt", failedBoundary: {
        stepId: "analysis", missingEvidenceKinds: ["schema_summary"], violatedSkillRequirements: [], reusableEvidenceRefs: ["query"], suggestedRepairShape: "repair_leaf",
      } };
    },
    emit: (event) => { events.push(event); },
  }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "STEP_NOT_COMPLETED");
    assert.equal(error.details?.repairExhausted, true);
    assert.match(String(error.details?.partialOutput), /任务未完成.*\n.*schema_summary/s);
    assert.match(String(error.details?.partialOutput), /取得部分价格记录/);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(assessments, 1);
  assert.equal(events.filter((event) => event.type === "failure_report.generated").length, 1);
  assert.equal(events.some((event) => event.type === "loop.completed" || event.type === "candidate.approved"), false);
});

for (const mode of ["empty", "tool", "length", "provider_error", "cancelled"] as const) {
  test(`failure reporting handles ${mode} without exposing rejected drafts or claiming success`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const grant = createCapabilityGrant({ runId: `report-${mode}`, actorUserId: "user", depth: 0, allowedToolNames: [], allowedSkillIds: [] });
    await assert.rejects(runAgentLoop({
      runId: grant.runId, systemPrompt: "Test", input: "Test", grant,
      tools: new ToolRegistry([]), maxSteps: 1, candidateRepairAssessmentLimit: 0, signal: controller.signal,
      model: { limits: TEST_MODEL_LIMITS, complete: async () => {
        calls += 1;
        if (calls === 1) return { content: "UNVERIFIED_DRAFT", finishReason: "stop", toolCalls: [] };
        if (mode === "provider_error") throw new Error("PROVIDER_SECRET");
        if (mode === "cancelled") controller.abort();
        return {
          content: mode === "empty" ? "" : "UNSAFE_PARTIAL",
          finishReason: mode === "length" ? "length" : "stop",
          toolCalls: mode === "tool" ? [{ id: "never-dispatched", name: "write", arguments: {} }] : [],
        } satisfies ModelResponse;
      } },
      evaluateCandidate: async () => ({ approved: false, feedback: "Missing evidence" }),
    }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      if (mode === "cancelled") {
        assert.equal(error.code, "CANCELLED");
        assert.equal(error.details?.partialOutput, undefined);
      } else {
        assert.equal(error.code, "STEP_NOT_COMPLETED");
        assert.match(String(error.details?.partialOutput), /最后一次结果整理未成功/);
        assert.doesNotMatch(String(error.details?.partialOutput), /UNVERIFIED_DRAFT|UNSAFE_PARTIAL|PROVIDER_SECRET/);
      }
      return true;
    });
    assert.equal(calls, 2);
  });
}

test("failed Run persists its report in both snapshot and Outcome, never a delivery receipt", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    let reports = 0;
    const runs = new RunService({
      database, skills: new SkillService(database), plannerFactory: singleStepTestPlanner,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          reports += 1;
          return { content: "已取得部分资料，但缺少验证，不能给出完整结论。", finishReason: "stop", toolCalls: [] };
        }
        return { content: "尚未验证的候选", finishReason: "stop", toolCalls: [] };
      } }),
      assessorFactory: () => ({ assess: async (input) => ({
        ...await approvingTestAssessor().assess(input), approved: false,
        criteria: input.step.successCriteria.map((criterion) => ({ criterionId: criterion.id, satisfied: false, rationale: "Not verified", evidenceRefs: [] })),
        feedback: "Not verified", failedBoundary: { stepId: input.step.id, missingEvidenceKinds: ["schema_summary"], violatedSkillRequirements: [], reusableEvidenceRefs: [], suggestedRepairShape: "repair_leaf" },
      }) }),
    });
    const run = await runs.execute(owner.user.id, "分析现有资料");
    assert.equal(run.status, "failed");
    assert.equal(reports, 1);
    assert.match(run.output ?? "", /任务未完成/);
    assert.match(run.output ?? "", /已取得部分资料/);
    const refreshed = await runs.get(owner.user.id, run.id);
    assert.equal(refreshed.output, run.output);
    const outcome = await database.prepare("SELECT status, output, reason_code FROM run_outcomes WHERE run_id = ?").get(run.id) as Record<string, unknown>;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.output, run.output);
    assert.equal(outcome.reason_code, "STEP_NOT_COMPLETED");
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.find((event) => event.type === "run.failed")?.data.output, run.output);
    assert.equal(events.some((event) => event.type === "run.completed" || event.type === "terminal.delivery_committed" || event.type === "run.recovery_required"), false);
  } finally { database.close(); }
});

test("budget failure persists a goal-oriented summary without changing the original failure code", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    let reports = 0;
    const runs = new RunService({
      database, skills: new SkillService(database), maxSteps: 1,
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          reports += 1;
          assert.deepEqual(request.tools, []);
          return { content: "目标是分析价格趋势；尚未取得可核验资料，不能给出价格结论。", finishReason: "stop", toolCalls: [] };
        }
        return { content: "", finishReason: "length", toolCalls: [] };
      } }),
    });
    let runId = "";
    await assert.rejects(runs.execute(owner.user.id, "分析价格趋势"), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "RUN_LIMIT_EXCEEDED");
      runId = String(error.details?.runId);
      return true;
    });
    assert.equal(reports, 1);
    const run = await runs.get(owner.user.id, runId);
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "RUN_LIMIT_EXCEEDED");
    assert.match(run.output ?? "", /目标是分析价格趋势/);
    const events = await runs.events(owner.user.id, runId);
    assert.equal(events.find((event) => event.type === "run.failed")?.data.output, run.output);
  } finally { database.close(); }
});
