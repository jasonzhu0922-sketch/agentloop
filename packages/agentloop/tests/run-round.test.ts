import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/storage/database.ts";
import { RunRepository } from "../src/storage/repositories/run-repository.ts";
import { RunRoundRepository } from "../src/runtime/run-round-repository.ts";
import { PlanningBudgetRepository } from "../src/runtime/planning-budget-repository.ts";
import { PlanningRecoveryRepository } from "../src/runtime/planning-recovery-repository.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { installMultiPlanSchema } from "../src/storage/multi-plan-schema.ts";
import { roundEvidenceFingerprints } from "../src/runtime/round-evidence.ts";
import type { ExecutionPlan } from "../src/planning/contracts.ts";

test("new Result identities cannot make identical assessed facts count as Round progress", () => {
  const plan = (resultId: string, content: string) => ({ steps: [{ id: resultId, kind: "leaf", evidence: {
    publishedResult: { ref: { resultId }, publication: { status: "published" }, payload: { content } },
    toolCalls: [{ toolName: "read_result", result: JSON.stringify({ resultId }), isError: false }],
  } }] }) as unknown as ExecutionPlan;
  assert.deepEqual(roundEvidenceFingerprints(plan("old", "same verified fact")), roundEvidenceFingerprints(plan("new", "same verified fact")));
  assert.notDeepEqual(roundEvidenceFingerprints(plan("old", "same verified fact")), roundEvidenceFingerprints(plan("new", "new verified fact")));
});

test("initial Round survives reopening and cannot admit a Plan after cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-round-"));
  const path = join(directory, "runtime.db");
  let database = new AppDatabase(path);
  try {
    await new RunRepository(database).insertRun({ id: "run-1", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    await new RunRoundRepository(database).createInitial("run-1", 1);
    await database.close();
    database = new AppDatabase(path);
    const rounds = new RunRoundRepository(database);
    const row = await database.prepare("SELECT status, revision FROM run_rounds WHERE run_id = ?").get<{ status: string; revision: number }>("run-1");
    assert.deepEqual({ ...row }, { status: "planning", revision: 1 });
    await rounds.finish("run-1", "cancelled", 2);
    await assert.rejects(rounds.bindPlan("run-1", "plan-1", 3), /no longer available/);
    await rounds.finish("run-1", "failed", 4);
    const final = await database.prepare("SELECT status, revision FROM run_rounds WHERE run_id = ?").get<{ status: string; revision: number }>("run-1");
    assert.deepEqual({ ...final }, { status: "cancelled", revision: 2 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Round creation rolls back with its Run", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await assert.rejects(database.transaction(async () => {
      await new RunRepository(database).insertRun({ id: "run-rollback", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
      await new RunRoundRepository(database).createInitial("run-rollback", 1);
      throw new Error("abort");
    }), /abort/);
    assert.equal(await database.prepare("SELECT run_id FROM run_rounds WHERE run_id = ?").get("run-rollback"), undefined);
    assert.equal(await new RunRepository(database).get("run-rollback"), undefined);
  } finally {
    await database.close();
  }
});

test("Round history and next-Round guards are durable", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunRepository(database);
    const rounds = new RunRoundRepository(database);
    await runs.insertRun({ id: "guard-run", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    await rounds.createInitial("guard-run", 1);
    await assert.rejects(
      rounds.assertNextAllowed({ runId: "guard-run", roundNumber: 1, maxRounds: 1, progressKey: "{}" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ROUND_BUDGET_EXHAUSTED",
    );
    const history = await rounds.history("guard-run");
    assert.deepEqual(history, [{ roundNumber: 1, status: "planning", revision: 1 }]);
  } finally {
    await database.close();
  }
});

test("repeating the same unresolved Round state is rejected before creation", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunRepository(database);
    const rounds = new RunRoundRepository(database);
    await runs.insertRun({ id: "stuck-run", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    await rounds.createInitial("stuck-run", 1);
    await database.prepare(`INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, canonical_state_ref_json, status, created_at, updated_at)
      VALUES ('stuck-plan', 'stuck-run', 1, 'goal', '[]', '{}', 'completed', 1, 1)`).run();
    await database.prepare("UPDATE run_rounds SET status = 'completed', plan_id = ? WHERE run_id = ?").run("stuck-plan", "stuck-run");
    const result = {
      schema: "agentloop.roundResult/v1", runId: "stuck-run", roundNumber: 1, planId: "stuck-plan", planVersion: 1,
      canonicalRevision: 1, evidenceFingerprints: ["receipt-content-sha"], output: "partial", reasonCode: "round_assessed_and_completed",
      steps: [{ stepId: "step-1", result: { schema: "agentloop.runtimeResultRef/v1", resultId: "result-1", producer: { runId: "stuck-run", planId: "stuck-plan", stepId: "step-1" } }, assessmentId: "assessment-1" }],
      decision: { kind: "next_round", canonicalRevision: 1, openGapIds: ["gap-1"], openTargetIds: ["target-1"] },
    };
    await database.prepare(`INSERT INTO run_round_results(run_id, round_number, plan_id, canonical_revision, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run("stuck-run", 1, "stuck-plan", 1, JSON.stringify(result), 2);
    await assert.rejects(
      rounds.assertNextAllowed({
        runId: "stuck-run", roundNumber: 2, maxRounds: 8,
        progressKey: JSON.stringify({ openGapIds: ["gap-1"], openTargetIds: ["target-1"], evidenceFingerprints: ["receipt-content-sha"] }),
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ROUND_NO_PROGRESS",
    );
    assert.equal((await rounds.history("stuck-run"))[0]?.result?.decision.kind, "next_round");
  } finally {
    await database.close();
  }
});

test("multi-Plan migration repairs child foreign keys left on the legacy parent", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON");
    await database.exec("ALTER TABLE plans RENAME TO plans_single_plan_legacy");
    await database.exec(`CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      goal TEXT NOT NULL,
      selected_skill_ids_json TEXT NOT NULL,
      canonical_state_ref_json TEXT,
      input_bindings_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('admitted', 'running', 'completed', 'failed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    await database.exec("DROP TABLE plans_single_plan_legacy; PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON");
    await database.exec("CREATE TABLE stale_plan_child (id TEXT PRIMARY KEY, plan_id TEXT REFERENCES plans_single_plan_legacy(id) ON DELETE CASCADE)");
    assert.equal((await database.prepare("PRAGMA foreign_key_list(stale_plan_child)").all<{ table: string }>())[0]?.table, "plans_single_plan_legacy");
    await installMultiPlanSchema(database);
    assert.equal((await database.prepare("PRAGMA foreign_key_list(stale_plan_child)").all<{ table: string }>())[0]?.table, "plans");
  } finally {
    await database.close();
  }
});

test("planning budget persists across reopen and cannot be enlarged or spent concurrently beyond its limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-budget-"));
  const path = join(directory, "runtime.db");
  let database = new AppDatabase(path);
  try {
    await new RunRepository(database).insertRun({ id: "run-budget", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    const budgets = new PlanningBudgetRepository(database);
    await budgets.initialize("run-budget", 2, 1);
    await budgets.consume("run-budget", 2);
    await database.close();
    database = new AppDatabase(path);
    const resumed = new PlanningBudgetRepository(database);
    await resumed.initialize("run-budget", 9, 3);
    const attempts = await Promise.allSettled([resumed.consume("run-budget", 4), resumed.consume("run-budget", 4)]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const budget = await database.prepare("SELECT max_turns, used_turns FROM run_planning_budgets WHERE run_id = ?")
      .get<{ max_turns: number; used_turns: number }>("run-budget");
    assert.deepEqual({ ...budget }, { max_turns: 2, used_turns: 2 });
    await database.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run("run-budget");
    await assert.rejects(resumed.consume("run-budget", 5), /exhausted or Run is no longer active/);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rolled-back planning turn does not consume budget", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await new RunRepository(database).insertRun({ id: "run-rollback-budget", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    const budgets = new PlanningBudgetRepository(database);
    await budgets.initialize("run-rollback-budget", 1, 1);
    await assert.rejects(database.transaction(async () => {
      await budgets.consume("run-rollback-budget", 2);
      throw new Error("event write failed");
    }), /event write failed/);
    await budgets.consume("run-rollback-budget", 3);
    await assert.rejects(budgets.consume("run-rollback-budget", 4), /budget exhausted/);
  } finally {
    await database.close();
  }
});

test("a replacement planning lease fences stale owners before admission", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await new RunRepository(database).insertRun({ id: "lease-run", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    const recovery = new PlanningRecoveryRepository(database);
    await recovery.create("lease-run", { schema: "test" }, 1);
    await recovery.wait("lease-run", "plan", "PLANNING_ERROR", "request", 2);
    await recovery.claim("lease-run", "request", 3);
    assert.equal(await recovery.acquireLease("lease-run", "old", 10, 10), true);
    assert.equal(await recovery.acquireLease("lease-run", "new", 19, 10), false);
    assert.equal(await recovery.acquireLease("lease-run", "new", 20, 10), true);
    await assert.rejects(recovery.finishLease("lease-run", "old", 21), /lease was lost/);
    assert.equal(await recovery.renewLease("lease-run", "old", 21, 10), false);
    await recovery.finishLease("lease-run", "new", 21);
    assert.equal((await recovery.get("lease-run"))?.state, "completed");
  } finally { await database.close(); }
});

test("multi-Plan migration preserves historical Plans and current Plan lookup", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await new RunRepository(database).insertRun({ id: "multi-run", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    await new RunRoundRepository(database).createInitial("multi-run", 1);
    const stateRef = JSON.stringify({ stateId: "state", runId: "multi-run", intentId: "intent", revision: 1 });
    await database.prepare(`INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, canonical_state_ref_json, status, created_at, updated_at)
      VALUES ('old-plan', 'multi-run', 1, 'old', '[]', ?, 'completed', 1, 1)`).run(stateRef);
    await installMultiPlanSchema(database);
    await database.prepare(`INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, canonical_state_ref_json, status, created_at, updated_at)
      VALUES ('new-plan', 'multi-run', 1, 'new', '[]', ?, 'admitted', 2, 2)`).run(stateRef);
    await database.prepare("UPDATE run_rounds SET plan_id = ?, status = 'executing', revision = revision + 1 WHERE run_id = ?").run("new-plan", "multi-run");
    const current = await database.prepare("SELECT id, goal FROM plans WHERE run_id = ? ORDER BY created_at").all<{ id: string; goal: string }>("multi-run");
    assert.deepEqual(current.map((row) => ({ id: row.id, goal: row.goal })), [{ id: "old-plan", goal: "old" }, { id: "new-plan", goal: "new" }]);
    assert.equal((await new PlanRepository(database).getByRun("multi-run")).id, "new-plan");
    await installMultiPlanSchema(database);
    const planStepsForeignKeys = await database.prepare("PRAGMA foreign_key_list(plan_steps)").all<{ table: string }>();
    assert.ok(planStepsForeignKeys.some((key) => key.table === "plans"));
    assert.equal((await database.prepare("PRAGMA foreign_key_check").all()).length, 0);
  } finally { await database.close(); }
});

test("a completed Round can create exactly one next planning Round", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunRepository(database);
    const rounds = new RunRoundRepository(database);
    await runs.insertRun({ id: "next-round", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    await rounds.createInitial("next-round", 1);
    await database.prepare("UPDATE run_rounds SET status = 'completed' WHERE run_id = ? AND round_number = 1").run("next-round");
    assert.equal(await rounds.createNext("next-round", 1, 2), 2);
    await assert.rejects(rounds.createNext("next-round", 1, 3), /not complete|already exists|next Round/);
    assert.deepEqual(await rounds.list("next-round"), [
      { roundNumber: 1, status: "completed", revision: 1 },
      { roundNumber: 2, status: "planning", revision: 1 },
    ]);
  } finally { await database.close(); }
});

test("Plan binding uses the latest planning Round instead of hardcoded Round 1", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunRepository(database);
    const rounds = new RunRoundRepository(database);
    await runs.insertRun({ id: "round-two", ownerUserId: "owner", input: "goal", allowDangerousTools: false, createdAt: 1 });
    await rounds.createInitial("round-two", 1);
    await database.prepare("UPDATE run_rounds SET status = 'completed' WHERE run_id = ?").run("round-two");
    await rounds.createNext("round-two", 1, 2);
    await database.prepare(`INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, canonical_state_ref_json, status, created_at, updated_at)
      VALUES ('plan-round-two', 'round-two', 1, 'goal', '[]', ?, 'admitted', 3, 3)`).run(JSON.stringify({ stateId: "state", runId: "round-two", intentId: "intent", revision: 1 }));
    await rounds.bindPlan("round-two", "plan-round-two", 3);
    assert.deepEqual(await rounds.list("round-two"), [
      { roundNumber: 1, status: "completed", revision: 1 },
      { roundNumber: 2, status: "executing", planId: "plan-round-two", revision: 2 },
    ]);
    assert.equal(await rounds.roundForPlan("round-two", "plan-round-two"), 2);
  } finally { await database.close(); }
});
