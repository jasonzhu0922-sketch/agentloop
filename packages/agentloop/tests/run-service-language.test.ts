import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_RUNNER_SYSTEM_PROMPT, MAX_SUPPORTED_STEP_TURNS, recoveryArtifactTargetBinding, RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import {
  approvingTestAssessor,
  singleStepTestPlanner,
  TEST_MODEL_LIMITS,
  testOwner,
} from "./runtime-test-helpers.ts";

test("recovery plan projection retains Runtime-owned artifact target bindings by ID", () => {
  const binding = {
    artifactTargets: [{ id: "receipt-standard-excel", purpose: "Workbook", kind: "spreadsheet", format: "excel", terminalRequired: true }],
  } as never;
  const taskSemantics = {
    artifactTargets: [{ id: "receipt-standard-excel", purpose: "Workbook", action: "create", kind: "spreadsheet", format: "excel", surface: "workspace_artifact", terminalRequired: true }],
  } as never;

  assert.deepEqual(recoveryArtifactTargetBinding(binding, taskSemantics), {
    artifactTargetIds: ["receipt-standard-excel"],
  });
});

test("RunService makes Simplified Chinese the default user-facing execution language", async () => {
  const database = new AppDatabase(":memory:");
  try {
    let executionSystemPrompt = "";
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        executionSystemPrompt = request.systemPrompt;
        return { content: "已完成。", finishReason: "stop", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(testOwner().user.id, "Summarize this briefly");

    assert.equal(run.status, "completed");
    assert.match(
      DEFAULT_RUNNER_SYSTEM_PROMPT,
      /默认使用简体中文与用户沟通；除非用户明确要求使用其他语言，用户可见的自然语言回复应优先使用简体中文/,
    );
    assert.ok(
      executionSystemPrompt.indexOf("默认使用简体中文与用户沟通") < executionSystemPrompt.indexOf("<runtime_contract>"),
      "the default Chinese-language instruction must precede the runtime contract",
    );
    assert.match(
      executionSystemPrompt,
      /Unless the user explicitly requests another language, all user-facing natural-language output must be in Simplified Chinese\./,
    );
    assert.match(
      executionSystemPrompt,
      /Preserve code, commands, paths, API fields, and proper nouns in their original form\./,
    );
  } finally {
    database.close();
  }
});

test("RunService enforces the configured model-turn budget for each Plan step", async () => {
  const database = new AppDatabase(":memory:");
  try {
    let executionTurns = 0;
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          return { content: "本步骤达到执行回合上限，尚未形成可验证结果。", finishReason: "stop", toolCalls: [] };
        }
        executionTurns += 1;
        return { content: "", finishReason: "length", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => ({
          goal: task.input,
          schema: "agentloop.outcomePlan/v2" as const,
          shape: "single_leaf" as const,
          selectedSkillIds: [],
          steps: [{
            id: "conversation-only",
            objective: task.input,
            dependencies: [],
            role: "deliver" as const,
            skillIds: [],
            requiredCapabilities: ["conversation_delivery"],
            evidenceContract: { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" as const },
            successCriteria: [{ id: "answered", description: "Return a direct answer.", source: "task" as const }],
          }],
        }),
      }),
      assessorFactory: () => approvingTestAssessor(),
      maxSteps: 1,
    });

    const owner = testOwner();
    await assert.rejects(runs.execute(owner.user.id, "完成当前步骤"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RUN_LIMIT_EXCEEDED");
      return true;
    });
    assert.ok(executionTurns >= 1);
    const run = (await runs.list(owner.user.id))[0];
    assert.ok(run);
    const limitEvent = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "loop.limit_exceeded");
    assert.equal(limitEvent?.data.maxSteps, 1);
    assert.equal(limitEvent?.data.candidateRepairGraceSteps, 4);
  } finally {
    database.close();
  }
});

test("RunService rejects unsafe configured per-Step turn budgets", () => {
  const database = new AppDatabase(":memory:");
  try {
    const options = {
      database,
      skills: new SkillService(database),
      modelFactory: () => ({
        limits: TEST_MODEL_LIMITS,
        complete: async () => ({ content: "", finishReason: "stop" as const, toolCalls: [] }),
      }),
    };
    assert.throws(() => new RunService({ ...options, maxSteps: 0 }), /maxSteps must be a positive safe integer/);
    assert.throws(() => new RunService({ ...options, maxSteps: MAX_SUPPORTED_STEP_TURNS + 1 }), /maxSteps must be a positive safe integer/);
    assert.equal(DEFAULT_MAX_STEPS, 32);
  } finally {
    database.close();
  }
});

test("hidden reasoning is absent from public Run events but retained for recovery", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      reasoningVisibility: "hidden",
      complete: async () => ({
        content: "已完成。",
        finishReason: "stop",
        toolCalls: [],
        reasoningContent: "opaque-provider-continuation-state",
      }),
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const owner = testOwner();
    const run = await runs.execute(owner.user.id, "只回复完成状态");
    const publicCheckpoint = (await runs.events(owner.user.id, run.id))
      .find((event) => event.type === "assistant.committed");
    assert.equal(publicCheckpoint?.data.reasoningContent, undefined);
    assert.equal(publicCheckpoint?.data.privateReasoningContent, undefined);

    const stored = await database.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = ?")
      .get(run.id, "assistant.committed") as { payload_json: string } | undefined;
    assert.ok(stored);
    const storedCheckpoint = JSON.parse(stored.payload_json) as Record<string, unknown>;
    assert.equal(storedCheckpoint.privateReasoningContent, "opaque-provider-continuation-state");
  } finally {
    database.close();
  }
});
