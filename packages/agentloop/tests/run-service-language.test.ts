import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import {
  approvingTestAssessor,
  singleStepTestPlanner,
  TEST_MODEL_LIMITS,
  testOwner,
} from "./runtime-test-helpers.ts";

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
