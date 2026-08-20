import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("an expired dispatched Action becomes recovery_required without terminalizing its Run", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("actions@example.com", "actions secure password");
    const runId = "action-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "test action recovery", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({
      runId,
      kind: "model_turn",
      replayPolicy: "safe",
      deadlineMs: 1_000,
      metadata: { phase: "execution" },
    });
    database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?")
      .run(action.id);

    assert.equal(actions.reconcileRunningRuns(), 1);
    const recovered = actions.list(runId)[0];
    assert.equal(recovered.state, "recovery_required");
    assert.equal(recovered.fence, action.fence);
    const run = database.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running");
    const outcome = database.prepare("SELECT COUNT(*) AS count FROM run_outcomes WHERE run_id = ?")
      .get(runId) as { count: number };
    assert.equal(outcome.count, 0);
    const event = database.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId) as { type: string };
    assert.equal(event.type, "action.recovery_required");
  } finally {
    database.close();
  }
});

test("recovery reconciliation ignores orphaned legacy Actions whose Run no longer exists", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("orphan-actions@example.com", "orphan actions secure password");
    const runId = "orphan-action-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "legacy orphan action", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({
      runId,
      kind: "planning",
      replayPolicy: "safe",
      deadlineMs: 1_000,
      metadata: { phase: "planning" },
    });
    database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?")
      .run(action.id);

    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    database.exec("PRAGMA foreign_keys = ON");

    assert.equal(actions.reconcileRunningRuns(), 0);
    const orphan = database.prepare("SELECT state FROM runtime_actions WHERE id = ?")
      .get(action.id) as { state: string };
    assert.equal(orphan.state, "dispatched");
  } finally {
    database.close();
  }
});
