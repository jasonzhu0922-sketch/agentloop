import { testOwner } from "./runtime-test-helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("an expired dispatched Action becomes recovery_required without terminalizing its Run", async () => {
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

    assert.equal(await actions.reconcileRunningRuns(), 1);
    const recovered = (await actions.list(runId))[0];
    assert.equal(recovered.state, "recovery_required");
    assert.equal(recovered.fence, action.fence);
    const run = (await database.prepare("SELECT status FROM runs WHERE id = ?").get(runId)) as { status: string };
    assert.equal(run.status, "running");
    const outcome = (await database.prepare("SELECT COUNT(*) AS count FROM run_outcomes WHERE run_id = ?")
      .get(runId)) as { count: number };
    assert.equal(outcome.count, 0);
    const event = (await database.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId)) as { type: string };
    assert.equal(event.type, "action.recovery_required");
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

    assert.equal(await actions.reconcileRunningRuns(), 0);
    assert.equal((await actions.list(runId)).length, 0);
    const state = await database.prepare("SELECT COUNT(*) AS count FROM run_recovery_states WHERE run_id = ?")
      .get(runId) as { count: number };
    assert.equal(state.count, 0);
  } finally {
    await database.close();
  }
});

test("old actionless running Runs still enter legacy recovery review", async () => {
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

    assert.equal(await actions.reconcileRunningRuns(), 1);
    const recovered = (await actions.list(runId))[0];
    assert.equal(recovered.kind, "recovery_review");
    assert.equal(recovered.state, "recovery_required");
    assert.equal(recovered.metadata.reason, "legacy_state_incomplete");
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

    assert.equal(await actions.reconcileRunningRuns(), 0);
    const orphan = (await database.prepare("SELECT state FROM runtime_actions WHERE id = ?")
      .get(action.id)) as { state: string };
    assert.equal(orphan.state, "dispatched");
  } finally {
    await database.close();
  }
});
