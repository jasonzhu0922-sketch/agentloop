import { testOwner } from "./runtime-test-helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { toolOperationFailureCode } from "../src/runtime/tool-operation-outcome.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("an expired dispatched Action is fenced and reported as execution authority loss without waiting_recovery", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "action-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "test action recovery", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({
      runId,
      kind: "model_turn",
      replayPolicy: "safe",
      deadlineMs: 1_000,
      metadata: { phase: "execution" },
    });
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?")
      .run(action.id);

    const interrupted = await actions.reconcileRunningRuns();
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0]?.reason, "deadline_expired");
    const recovered = (await actions.list(runId))[0];
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.errorCode, "EXECUTION_AUTHORITY_LOST");
    assert.equal(recovered.fence, action.fence);
    const run = (await database.prepare("SELECT status FROM runs WHERE id = ?").get(runId)) as { status: string };
    assert.equal(run.status, "running");
    const outcome = (await database.prepare("SELECT COUNT(*) AS count FROM run_outcomes WHERE run_id = ?")
      .get(runId)) as { count: number };
    assert.equal(outcome.count, 0);
    const event = (await database.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId)) as { type: string };
    assert.equal(event.type, "action.interrupted");
    const recoveryState = await database.prepare("SELECT COUNT(*) AS count FROM run_recovery_states WHERE run_id = ?")
      .get(runId) as { count: number };
    assert.equal(recoveryState.count, 0);
  } finally {
    await database.close();
  }
});

test("a resolved tool Action records a returned nonzero exit as operation failure", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "operation-failure-action-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "test operation failure", Date.now());
    const actions = new RuntimeActionRepository(database);

    const value = await actions.execute({
      runId,
      kind: "tool_call",
      replayPolicy: "safe",
      deadlineMs: 1_000,
      resultFailureCode: toolOperationFailureCode,
    }, async () => ({ exitCode: 2, stdout: "", stderr: "syntax error" }));

    assert.equal(value.exitCode, 2);
    const action = (await actions.list(runId))[0];
    assert.equal(action.state, "failed");
    assert.equal(action.errorCode, "TOOL_OPERATION_FAILED");
    const event = await database.prepare(`
      SELECT type, payload_json FROM run_events
      WHERE run_id = ? AND type = 'action.failed'
      ORDER BY seq DESC LIMIT 1
    `).get(runId) as { type: string; payload_json: string };
    assert.equal(event.type, "action.failed");
    assert.equal(JSON.parse(event.payload_json).code, "TOOL_OPERATION_FAILED");

    const successValue = await actions.execute({
      runId,
      kind: "tool_call",
      replayPolicy: "safe",
      deadlineMs: 1_000,
      resultFailureCode: toolOperationFailureCode,
    }, async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    assert.equal(successValue.exitCode, 0);
    assert.deepEqual((await actions.list(runId)).map((item) => item.state), ["failed", "succeeded"]);
  } finally {
    await database.close();
  }
});

test("recovery reconciliation does not mark a freshly created actionless Run as legacy incomplete", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "fresh-actionless-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "fresh run before planner action", Date.now());
    const actions = new RuntimeActionRepository(database);

    assert.equal((await actions.reconcileRunningRuns()).length, 0);
    assert.equal((await actions.list(runId)).length, 0);
    const state = await database.prepare("SELECT COUNT(*) AS count FROM run_recovery_states WHERE run_id = ?")
      .get(runId) as { count: number };
    assert.equal(state.count, 0);
  } finally {
    await database.close();
  }
});

test("old actionless running Runs are reported as interrupted without creating waiting_recovery", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "old-actionless-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "interrupted before action tracking", Date.now() - 120_000);
    const actions = new RuntimeActionRepository(database);

    const interrupted = await actions.reconcileRunningRuns();
    assert.deepEqual(interrupted, [{ runId, reason: "legacy_state_incomplete" }]);
    assert.equal((await actions.list(runId)).length, 0);
    const recoveryState = await database.prepare("SELECT COUNT(*) AS count FROM run_recovery_states WHERE run_id = ?")
      .get(runId) as { count: number };
    assert.equal(recoveryState.count, 0);
  } finally {
    await database.close();
  }
});

test("scoped reconciliation cannot interrupt a Run owned by another Runtime Host", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runIds = ["owned-run", "other-host-run"];
    for (const runId of runIds) {
      database.prepare(`
        INSERT INTO runs(
          id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
          status, input, created_at
        ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
      `).run(runId, owner.user.id, runId, Date.now() - 120_000);
    }
    const actions = new RuntimeActionRepository(database);

    assert.deepEqual(await actions.reconcileRunningRuns(["owned-run"]), [{
      runId: "owned-run",
      reason: "legacy_state_incomplete",
    }]);
    assert.deepEqual(await actions.reconcileRunningRuns(["other-host-run"]), [{
      runId: "other-host-run",
      reason: "legacy_state_incomplete",
    }]);
  } finally {
    await database.close();
  }
});

test("legacy waiting_recovery execution loss is migrated to an interruption instead of remaining user-actionable", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "legacy-waiting-recovery-run";
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "legacy interrupted work", Date.now() - 120_000);
    const actions = new RuntimeActionRepository(database);
    const action = await actions.requireRecoveryReview({
      runId,
      reason: "legacy_state_incomplete",
    });

    const interrupted = await actions.reconcileRunningRuns();
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0]?.runId, runId);
    assert.equal((await actions.list(runId))[0]?.state, "failed");
    const state = await database.prepare("SELECT COUNT(*) AS count FROM run_recovery_states WHERE run_id = ?")
      .get(runId) as { count: number };
    assert.equal(state.count, 0);
    assert.equal(action.kind, "recovery_review");
  } finally {
    await database.close();
  }
});

test("recovery reconciliation ignores orphaned legacy Actions whose Run no longer exists", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "orphan-action-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "legacy orphan action", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({
      runId,
      kind: "planning",
      replayPolicy: "safe",
      deadlineMs: 1_000,
      metadata: { phase: "planning" },
    });
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?")
      .run(action.id);

    await database.exec("PRAGMA foreign_keys = OFF");
    await database.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    await database.exec("PRAGMA foreign_keys = ON");

    assert.equal((await actions.reconcileRunningRuns()).length, 0);
    const orphan = (await database.prepare("SELECT state FROM runtime_actions WHERE id = ?")
      .get(action.id)) as { state: string };
    assert.equal(orphan.state, "dispatched");
  } finally {
    await database.close();
  }
});
