import assert from "node:assert/strict";
import test from "node:test";
import { BatchService } from "../src/batch/batch-service.ts";
import { AppError } from "../src/shared/errors.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

test("Batch enforces concurrency, idempotency, continue, and fail-fast policies", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const tracker = { active: 0, maximum: 0, calls: 0 };
    const runs = new RunService({
      database, skills, modelFactory: () => new BatchModel(tracker),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });
    const batches = new BatchService(database, runs);
    const request = {
      idempotencyKey: "continue-1",
      concurrency: 2,
      failurePolicy: "continue",
      items: [
        { key: "one", input: "ok one" },
        { key: "two", input: "fail two" },
        { key: "three", input: "ok three" },
      ],
    };
    const first = await batches.create(owner.user.id, request);
    assert.equal(first.status, "failed");
    assert.equal(first.completed, 2);
    assert.equal(first.failed, 1);
    assert.ok(tracker.maximum <= 2);
    assert.equal(tracker.calls, 3);

    const repeated = await batches.create(owner.user.id, request);
    assert.equal(repeated.id, first.id);
    assert.equal(tracker.calls, 3);

    const failFast = await batches.create(owner.user.id, {
      idempotencyKey: "fail-fast-1",
      concurrency: 1,
      failurePolicy: "fail-fast",
      items: [
        { key: "first", input: "fail immediately" },
        { key: "second", input: "must not start" },
        { key: "third", input: "must not start either" },
      ],
    });
    assert.equal(failFast.status, "failed");
    assert.equal(failFast.failed, 1);
    assert.equal(failFast.cancelled, 2);
    assert.equal(tracker.calls, 4);
  } finally {
    database.close();
  }
});

class BatchModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private readonly tracker: { active: number; maximum: number; calls: number };
  constructor(tracker: { active: number; maximum: number; calls: number }) { this.tracker = tracker; }
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.tracker.calls += 1;
    this.tracker.active += 1;
    this.tracker.maximum = Math.max(this.tracker.maximum, this.tracker.active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    this.tracker.active -= 1;
    const input = request.messages.find((message) => message.role === "user")?.content ?? "";
    if (input.startsWith("fail")) throw new AppError("MODEL_ERROR", "scripted batch failure", 502);
    return { content: `done: ${input}`, toolCalls: [], finishReason: "stop" };
  }
}
