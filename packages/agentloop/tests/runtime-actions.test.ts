import { testOwner } from "./runtime-test-helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SqlToolResultStore } from "../src/storage/repositories/tool-result-store.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { AppError } from "../src/shared/errors.ts";

test("Tool Action atomically commits a recoverable small outcome before projection events", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "small-outcome-run";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "test small outcome", Date.now());
    const store = new SqlToolResultStore(database);
    const ref = await store.put({
      ownerUserId: owner.user.id,
      runId,
      toolCallId: "small-call",
      toolName: "small_tool",
      content: "small complete result",
      createdAt: Date.now(),
    });
    const actions = new RuntimeActionRepository(database);
    await actions.execute({
      runId,
      stepId: "step-1",
      kind: "tool_call",
      replayPolicy: "unsafe",
      deadlineMs: 1_000,
      metadata: { toolCallId: "small-call", toolName: "small_tool" },
      resultRef: () => ref.locator,
      toolOutcome: () => ({
        toolCallId: "small-call",
        toolName: "small_tool",
        content: "small complete result",
        isError: false,
        resultRef: ref,
      }),
    }, async () => "done");

    const outcome = await database.prepare("SELECT * FROM tool_outcomes WHERE run_id = ? AND tool_call_id = ?")
      .get(runId, "small-call") as Record<string, unknown>;
    assert.equal(outcome.result_locator, ref.locator);
    assert.equal(outcome.content?.toString().includes("small complete result"), true);
    const events = await database.prepare("SELECT seq, type, payload_json FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ seq: number; type: string; payload_json: string }>;
    assert.deepEqual(events.slice(-2).map((event) => event.type), ["tool.outcome.committed", "action.result_committed"]);

    const transcript = reconstructRecoveryTranscript({
      userInput: "test small outcome",
      stepId: "step-1",
      events: [
        { seq: 1, type: "plan.step.started", data: { stepId: "step-1" } },
        { seq: 2, type: "assistant.tool_call.committed", data: { toolCallId: "small-call", name: "small_tool", arguments: {} } },
        ...events.filter((event) => event.type === "tool.outcome.committed").map((event, index) => ({
          seq: index + 3,
          type: event.type,
          data: JSON.parse(event.payload_json) as Record<string, unknown>,
        })),
      ],
    });
    assert.equal(transcript.messages.at(-1)?.role, "tool");
    assert.match(transcript.messages.at(-1)?.content ?? "", /small complete result/);
    assert.equal(
      transcript.messages.at(-1)?.role === "tool" ? transcript.messages.at(-1).resultRef?.locator : undefined,
      ref.locator,
    );
  } finally {
    await database.close();
  }
});

test("startup reconciliation commits a blob stored before an unsafe Tool Action SQL commit without replaying the effect", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "put-before-action-commit";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "unsafe effect", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({
      runId,
      stepId: "step-1",
      kind: "tool_call",
      replayPolicy: "unsafe",
      deadlineMs: 1_000,
      metadata: { toolCallId: "unsafe-call", toolName: "unsafe_tool", maxResultCharacters: 64 },
    });
    let externalEffects = 1;
    const store = new SqlToolResultStore(database);
    const ref = await store.put({
      ownerUserId: owner.user.id,
      runId,
      toolCallId: "unsafe-call",
      toolName: "unsafe_tool",
      content: `HEAD:${"x".repeat(80)}:TAIL-ERROR`,
      createdAt: Date.now(),
    });
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?")
      .run(action.id);

    assert.equal(await actions.reconcileStoredToolOutcomes(store), 1);
    assert.equal(await actions.reconcileStoredToolOutcomes(store), 0);
    assert.equal(externalEffects, 1);
    const recovered = (await actions.list(runId)).find((item) => item.id === action.id);
    assert.equal(recovered?.state, "succeeded");
    assert.equal(recovered?.resultRef, ref.locator);
    const outcome = await database.prepare("SELECT content, result_sha256 FROM tool_outcomes WHERE action_id = ?")
      .get(action.id) as { content: string; result_sha256: string };
    assert.match(outcome.content, /HEAD:/);
    assert.match(outcome.content, /TAIL-ERROR/);
    assert.equal(outcome.result_sha256, ref.sha256);
  } finally {
    await database.close();
  }
});

test("outcome reconciliation never claims a Tool Action with a live lease", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "live-tool-action";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "live effect", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({
      runId,
      kind: "tool_call",
      replayPolicy: "unsafe",
      deadlineMs: 60_000,
      metadata: { toolCallId: "live-call", toolName: "unsafe_tool" },
    });
    const store = new SqlToolResultStore(database);
    await store.put({
      ownerUserId: owner.user.id,
      runId,
      toolCallId: "live-call",
      toolName: "unsafe_tool",
      content: "effect completed",
      createdAt: Date.now(),
    });

    assert.equal(await actions.reconcileStoredToolOutcomes(store), 0);
    const current = (await actions.list(runId)).find((item) => item.id === action.id);
    assert.equal(current?.state, "dispatched");
    assert.equal(current?.fence, action.fence);
  } finally {
    await database.close();
  }
});

test("two reconcilers cannot both claim the same expired Tool Action", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "competing-reconcilers";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "reconcile once", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({
      runId,
      kind: "tool_call",
      replayPolicy: "unsafe",
      deadlineMs: 1_000,
      metadata: { toolCallId: "competing-call", toolName: "unsafe_tool" },
    });
    const store = new SqlToolResultStore(database);
    await store.put({
      ownerUserId: owner.user.id,
      runId,
      toolCallId: "competing-call",
      toolName: "unsafe_tool",
      content: "effect completed once",
      createdAt: Date.now(),
    });
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);

    const counts = await Promise.all([
      actions.reconcileStoredToolOutcomes(store),
      actions.reconcileStoredToolOutcomes(store),
    ]);
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
    assert.equal(
      Number((await database.prepare("SELECT COUNT(*) AS count FROM tool_outcomes WHERE action_id = ?")
        .get(action.id) as { count: number }).count),
      1,
    );
  } finally {
    await database.close();
  }
});

test("an original worker cannot overwrite an outcome after reconciliation fences its expired lease", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "worker-reconciler-race";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "effect once", Date.now());
    const actions = new RuntimeActionRepository(database);
    const store = new SqlToolResultStore(database);
    let releaseWorker!: () => void;
    const workerPaused = new Promise<void>((resolve) => { releaseWorker = resolve; });
    let blobStored!: () => void;
    const stored = new Promise<void>((resolve) => { blobStored = resolve; });
    let effects = 0;
    const worker = actions.execute({
      runId,
      kind: "tool_call",
      replayPolicy: "unsafe",
      deadlineMs: 1_000,
      metadata: { toolCallId: "race-call", toolName: "unsafe_tool" },
      resultRef: (value: { ref: Awaited<ReturnType<SqlToolResultStore["put"]>> }) => value.ref.locator,
      toolOutcome: (value: { ref: Awaited<ReturnType<SqlToolResultStore["put"]>> }) => ({
        toolCallId: "race-call",
        toolName: "unsafe_tool",
        content: "effect result",
        isError: false,
        resultRef: value.ref,
      }),
    }, async () => {
      effects += 1;
      const ref = await store.put({
        ownerUserId: owner.user.id,
        runId,
        toolCallId: "race-call",
        toolName: "unsafe_tool",
        content: "effect result",
        createdAt: Date.now(),
      });
      blobStored();
      await workerPaused;
      return { ref };
    });
    await stored;
    const action = (await actions.list(runId))[0]!;
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);

    assert.equal(await actions.reconcileStoredToolOutcomes(store), 1);
    releaseWorker();
    await assert.rejects(
      worker,
      (error: unknown) => (error as { code?: string }).code === "RUNTIME_ACTION_LEASE_LOST",
    );
    assert.equal(effects, 1);
    assert.equal((await actions.list(runId))[0]?.state, "succeeded");
    assert.equal(
      Number((await database.prepare("SELECT COUNT(*) AS count FROM tool_outcomes WHERE action_id = ?")
        .get(action.id) as { count: number }).count),
      1,
    );
  } finally {
    await database.close();
  }
});

test("a non-serializable Tool result leaves the Action recovery_required", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runId = "serialization-uncertain";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "unsafe serialization", Date.now());
    const actions = new RuntimeActionRepository(database);
    await assert.rejects(
      actions.execute({
        runId,
        kind: "tool_call",
        replayPolicy: "unsafe",
        deadlineMs: 1_000,
        metadata: { toolCallId: "cyclic", toolName: "unsafe_tool" },
      }, async () => {
        throw new AppError("TOOL_RESULT_SERIALIZATION_FAILED", "cyclic result", 500);
      }),
      (error: unknown) => (error as { code?: string }).code === "TOOL_RESULT_SERIALIZATION_FAILED",
    );
    assert.equal((await actions.list(runId))[0]?.state, "recovery_required");
    assert.equal(
      await database.prepare("SELECT COUNT(*) AS count FROM tool_outcomes WHERE run_id = ?").get(runId)
        .then((row) => Number((row as { count: number }).count)),
      0,
    );
  } finally {
    await database.close();
  }
});

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
