import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { AppError } from "../src/shared/errors.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

test("RunService cancels an active async model turn", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
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
    const run = await runs.get(owner.user.id, runId);
    await waitForEvent(runs, owner.user.id, run.id, "action.dispatched");

    const cancelled = await runs.cancel(owner.user.id, run.id);
    const error = await execution;

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.errorCode, "user_cancelled");
    assert.equal(error instanceof AppError, true);
    assert.equal((error as AppError).code, "CANCELLED");
    assert.equal(model.abortObserved, true);
    const events = (await runs.events(owner.user.id, run.id)).map((event) => event.type);
    assert.equal(events.includes("run.cancellation_requested"), true);
    assert.equal(events.includes("run.cancelled"), true);
    const latestAction = (await database.prepare(`
      SELECT state FROM runtime_actions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(run.id)) as { state: string };
    assert.equal(latestAction.state, "failed");
  } finally {
    await database.close();
  }
});

test("a HIL continuation retains the same Run cancellation authority for its resumed model turn", { timeout: 5000 }, async () => {
  const database = new AppDatabase(":memory:");
  let release!: () => void;
  let started!: () => void;
  let finished!: () => void;
  const resumed = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  let calls = 0, abortObserved = false;
  const owner = testOwner();
  try {
    const runs = new RunService({ database, skills: new SkillService(database),
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (_request, signal) => {
        if (++calls === 1) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "ask", name: "request_human_loop", arguments: {
          kind: "confirmation", title: "Confirm scope", prompt: "Continue this scope?", rationale: "User choice required", evidenceRefs: [],
          responseSchema: { type: "confirm", acceptLabel: "Continue", rejectLabel: "Stop" }, resume: { mode: "continue_step" },
        } }] };
        return await new Promise<ModelResponse>(resolve => {
          const complete = () => { signal?.removeEventListener("abort", onAbort); resolve({ content: "late resumed candidate", finishReason: "stop", toolCalls: [] }); finished(); };
          const onAbort = () => { abortObserved = true; complete(); };
          release = complete;
          signal?.addEventListener("abort", onAbort, { once: true });
          started();
        });
      } }),
    });
    const run = await runs.execute(owner.user.id, "Confirm the scope and answer the question.");
    const request = await runs.currentHumanLoop(owner.user.id, run.id);
    assert.ok(request);
    await runs.respondHumanLoop(owner.user.id, run.id, request.id, true, request.revision);
    await resumed;
    const cancelled = await runs.cancel(owner.user.id, run.id);
    // Release even a broken, unregistered continuation so the assertion cannot hang.
    release();
    await done;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(abortObserved, true);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.find(event => event.type === "run.cancellation_requested")?.data.abortedActiveExecution, true);
    await waitForEvent(runs, owner.user.id, run.id, "model.request.failed");
    await waitForEvent(runs, owner.user.id, run.id, "human_loop.resume_failed");
    assert.ok(!(await runs.events(owner.user.id, run.id)).some(event => event.type === "run.completed"));
  } finally { release?.(); await database.close(); }
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
    if ((await runs.events(ownerUserId, runId)).some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}
