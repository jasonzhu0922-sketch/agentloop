import { testOwner } from "./runtime-test-helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SqlToolResultStore } from "../src/storage/repositories/tool-result-store.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";

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
