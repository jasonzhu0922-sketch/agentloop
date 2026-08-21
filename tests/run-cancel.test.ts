import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { AppError } from "../src/shared/errors.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("RunService cancels an active async model turn", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("cancel@example.com", "cancel secure password");
    const model = new AbortAwareBlockingModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const execution = runs.execute(owner.user.id, "cancel me").catch((error) => error);
    const runId = await model.started;
    const run = runs.get(owner.user.id, runId);
    await waitForEvent(runs, owner.user.id, run.id, "action.dispatched");

    const cancelled = runs.cancel(owner.user.id, run.id);
    const error = await execution;

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.errorCode, "user_cancelled");
    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).code, "CANCELLED");
    assert.equal(model.abortObserved, true);
    const events = runs.events(owner.user.id, run.id).map((event) => event.type);
    assert.equal(events.includes("run.cancellation_requested"), true);
    assert.equal(events.includes("run.cancelled"), true);
    const latestAction = database.prepare(`
      SELECT state FROM runtime_actions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(run.id) as { state: string };
    assert.equal(latestAction.state, "failed");
  } finally {
    database.close();
  }
});

class AbortAwareBlockingModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  abortObserved = false;
  readonly started: Promise<string>;
  private resolveStarted!: (runId: string) => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  async complete(request: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
    this.resolveStarted(request.runId);
    if (signal?.aborted === true) {
      this.abortObserved = true;
      throw new AppError("CANCELLED", "Model request was cancelled", 409);
    }
    return await new Promise<ModelResponse>((resolve) => {
      const onAbort = (): void => {
        this.abortObserved = true;
        signal?.removeEventListener("abort", onAbort);
        resolve({ content: "late response after cancellation", finishReason: "stop", toolCalls: [] });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function waitForEvent(
  runs: RunService,
  ownerUserId: string,
  runId: string,
  type: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (runs.events(ownerUserId, runId).some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}
