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
