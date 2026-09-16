import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SqlToolResultStore } from "../src/storage/repositories/tool-result-store.ts";
import type { RuntimeTool } from "../src/tools/tool-registry.ts";
import { AppError } from "../src/shared/errors.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import type { ToolResultStore } from "../src/storage/repositories/tool-result-store.ts";
import type { SqlConnection, SqlStatement } from "../src/storage/connection.ts";
import {
  approvingTestAssessor,
  singleStepTestPlanner,
  TEST_MODEL_LIMITS,
  testOwner,
} from "./runtime-test-helpers.ts";

test("RunService spills, grants bounded retrieval, and preserves owner isolation", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const fullResult = `HEAD:${"x".repeat(200)}:SECRET-TAIL`;
    const largeTool: RuntimeTool<unknown> = {
      name: "large_fixture",
      description: "Return a large test result",
      inputSchema: { type: "object" },
      executionMode: "parallel",
      replaySafe: true,
      maxResultCharacters: 40,
      parse: (value) => value,
      execute: async () => fullResult,
    };
    let executionTurn = 0;
    let locator = "";
    let sha256 = "";
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      async complete(request) {
        assert.equal(request.phase, "execution");
        const toolNames = request.tools.map((tool) => tool.name);
        assert.equal(toolNames.includes("read_tool_result"), true);
        executionTurn += 1;
        if (executionTurn === 1) {
          return {
            content: "",
            toolCalls: [{ id: "large-call", name: "large_fixture", arguments: {} }],
            finishReason: "tool_calls",
          };
        }
        if (executionTurn === 2) {
          const projected = request.messages.find((message) =>
            message.role === "tool" && message.toolCallId === "large-call"
          );
          assert.equal(projected?.role, "tool");
          assert.match(projected?.role === "tool" ? projected.content : "", /HEAD:/);
          assert.match(projected?.role === "tool" ? projected.content : "", /SECRET-TAIL/);
          locator = /"locator":"(tool-result:\/\/[0-9a-f-]+)"/.exec(projected?.role === "tool" ? projected.content : "")?.[1] ?? "";
          sha256 = /"sha256":"([0-9a-f]{64})"/.exec(projected?.role === "tool" ? projected.content : "")?.[1] ?? "";
          assert.match(locator, /^tool-result:\/\//);
          return {
            content: "",
            toolCalls: [{
              id: "read-call",
              name: "read_tool_result",
              arguments: {
                locator,
                sha256,
                offset: fullResult.length - "SECRET-TAIL".length,
                limit: "SECRET-TAIL".length,
              },
            }],
            finishReason: "tool_calls",
          };
        }
        const window = request.messages.find((message) =>
          message.role === "tool" && message.toolCallId === "read-call"
        );
        assert.match(window?.role === "tool" ? window.content : "", /SECRET-TAIL/);
        return { content: "complete", toolCalls: [], finishReason: "stop" };
      },
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
      tools: [largeTool],
    });

    const run = await runs.execute(owner.user.id, "inspect a large Tool result");
    assert.equal(run.status, "completed");

    const stored = await database.prepare(`
      SELECT content, sha256, characters FROM tool_result_blobs
      WHERE run_id = ? AND tool_call_id = ?
    `).get(run.id, "large-call") as { content: string; sha256: string; characters: number } | undefined;
    assert.equal(stored?.content, fullResult);
    assert.equal(stored?.characters, fullResult.length);
    assert.equal(stored?.sha256, sha256);
    const action = await database.prepare(`
      SELECT state, result_ref FROM runtime_actions
      WHERE run_id = ? AND kind = 'tool_call'
        AND json_extract(metadata_json, '$.toolCallId') = 'large-call'
    `).get(run.id) as { state: string; result_ref: string | null } | undefined;
    assert.equal(action?.state, "succeeded");
    assert.equal(action?.result_ref, locator);
    const outcome = await database.prepare(`
      SELECT content, result_locator, result_sha256 FROM tool_outcomes
      WHERE run_id = ? AND tool_call_id = ?
    `).get(run.id, "large-call") as {
      content: string; result_locator: string; result_sha256: string;
    } | undefined;
    assert.match(outcome?.content ?? "", /SECRET-TAIL/);
    assert.equal(outcome?.result_locator, locator);
    assert.equal(outcome?.result_sha256, sha256);

    await assert.rejects(
      () => new SqlToolResultStore(database).read({
        ownerUserId: "another-user",
        runId: run.id,
        locator,
        expectedSha256: sha256,
        offset: 0,
        limit: 20,
      }),
      /Tool result not found/,
    );
  } finally {
    await database.close();
  }
});

test("RunService keeps a Provider overflow retry inside one logical Model Action", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    let executionCalls = 0;
    const model: ModelAdapter = {
      limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
      async complete(request) {
        if (request.phase === "compaction") {
          return { content: "## Goal\nRetry safely", toolCalls: [], finishReason: "stop" };
        }
        executionCalls += 1;
        if (executionCalls === 1) {
          throw new AppError("CONTEXT_WINDOW_EXCEEDED", "provider overflow", 502);
        }
        return { content: "complete", toolCalls: [], finishReason: "stop" };
      },
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(owner.user.id, `Preserve this goal: ${"context ".repeat(1_000)}`);
    assert.equal(run.status, "completed");
    assert.equal(executionCalls, 2);
    const actions = await database.prepare(`
      SELECT state, metadata_json FROM runtime_actions
      WHERE run_id = ? AND kind = 'model_turn'
      ORDER BY created_at, id
    `).all(run.id) as unknown as Array<{ state: string; metadata_json: string }>;
    assert.equal(actions.length, 1);
    assert.equal(actions[0].state, "succeeded");
    assert.equal(JSON.parse(actions[0].metadata_json).contextProjectionRevision, 1);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "context.overflow_recovery.retrying").length, 1);
  } finally {
    await database.close();
  }
});

test("RunService preserves recovery when a Tool result cannot be serialized losslessly", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const tool = fixtureTool("invalid_json", () => ({ ok: true, nested: { missing: undefined } }));
    const runs = fixtureRunService(database, tool);

    const run = await runs.execute(owner.user.id, "return invalid JSON");
    assert.equal(run.status, "running");
    const plan = await database.prepare("SELECT status FROM plans WHERE run_id = ?").get(run.id) as { status: string };
    const step = await database.prepare("SELECT status FROM plan_steps WHERE plan_id = (SELECT id FROM plans WHERE run_id = ?)")
      .get(run.id) as { status: string };
    const action = await database.prepare("SELECT state, error_code FROM runtime_actions WHERE run_id = ? AND kind = 'tool_call'")
      .get(run.id) as { state: string; error_code: string };
    const recovery = await database.prepare("SELECT state, action_id FROM run_recovery_states WHERE run_id = ?")
      .get(run.id) as { state: string; action_id: string } | undefined;
    assert.equal(plan.status, "running");
    assert.equal(step.status, "running");
    assert.equal(action.state, "recovery_required");
    assert.equal(action.error_code, "TOOL_RESULT_SERIALIZATION_FAILED");
    assert.equal(recovery?.state, "waiting_recovery");
    assert.equal(recovery?.action_id, (await database.prepare("SELECT id FROM runtime_actions WHERE run_id = ? AND kind = 'tool_call'").get(run.id) as { id: string }).id);
    assert.equal(Number((await database.prepare("SELECT COUNT(*) AS count FROM tool_outcomes WHERE run_id = ?").get(run.id) as { count: number }).count), 0);
    assert.equal(Number((await database.prepare("SELECT COUNT(*) AS count FROM run_outcomes WHERE run_id = ?").get(run.id) as { count: number }).count), 0);
  } finally {
    await database.close();
  }
});

test("a reconciler-owned outcome prevents the stale RunService worker from failing the Run", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const sqlStore = new SqlToolResultStore(database);
    const reconcilingStore: ToolResultStore = {
      async put(input) {
        const ref = await sqlStore.put(input);
        await database.prepare(`
          UPDATE runtime_actions SET deadline_at = 0, lease_until = 0
          WHERE run_id = ? AND kind = 'tool_call' AND state = 'dispatched'
        `).run(input.runId);
        assert.equal(await new RuntimeActionRepository(database).reconcileStoredToolOutcomes(reconcilingStore), 1);
        return ref;
      },
      read: (input) => sqlStore.read(input),
      findByToolCall: (input) => sqlStore.findByToolCall(input),
    };
    const tool = fixtureTool("unsafe_once", () => "effect completed", false);
    const runs = fixtureRunService(database, tool, { toolResultStore: reconcilingStore });

    const run = await runs.execute(owner.user.id, "perform once");
    assert.equal(run.status, "running");
    assert.equal(Number((await database.prepare("SELECT COUNT(*) AS count FROM tool_outcomes WHERE run_id = ?").get(run.id) as { count: number }).count), 1);
    assert.equal(Number((await database.prepare("SELECT COUNT(*) AS count FROM run_outcomes WHERE run_id = ?").get(run.id) as { count: number }).count), 0);
    assert.equal((await database.prepare("SELECT status FROM plans WHERE run_id = ?").get(run.id) as { status: string }).status, "running");
    assert.equal((await database.prepare("SELECT state FROM run_recovery_states WHERE run_id = ?").get(run.id) as { state: string }).state, "waiting_recovery");
  } finally {
    await database.close();
  }
});

test("persistent post-outcome projection failure leaves a recoverable Run instead of a failed business outcome", async () => {
  const database = new AppDatabase(":memory:");
  const connection = new ProjectionFailingConnection(database);
  try {
    const owner = testOwner();
    const tool = fixtureTool("unsafe_once", () => "effect completed", false);
    const runs = fixtureRunService(connection, tool);

    const run = await runs.execute(owner.user.id, "perform once");
    assert.equal(run.status, "running");
    assert.equal(Number((await database.prepare("SELECT COUNT(*) AS count FROM tool_outcomes WHERE run_id = ?").get(run.id) as { count: number }).count), 1);
    assert.equal(Number((await database.prepare("SELECT COUNT(*) AS count FROM run_outcomes WHERE run_id = ?").get(run.id) as { count: number }).count), 0);
    assert.equal((await database.prepare("SELECT status FROM plans WHERE run_id = ?").get(run.id) as { status: string }).status, "running");
    assert.equal((await database.prepare("SELECT state FROM run_recovery_states WHERE run_id = ?").get(run.id) as { state: string }).state, "waiting_recovery");
  } finally {
    await database.close();
  }
});

function fixtureTool(name: string, execute: () => unknown, replaySafe = true): RuntimeTool<unknown> {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe,
    parse: (value) => value,
    execute: async () => execute(),
  };
}

function fixtureRunService(
  database: SqlConnection,
  tool: RuntimeTool<unknown>,
  options: { toolResultStore?: ToolResultStore } = {},
): RunService {
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    async complete() {
      calls += 1;
      if (calls === 1) {
        return { content: "", toolCalls: [{ id: "fixture-call", name: tool.name, arguments: {} }], finishReason: "tool_calls" };
      }
      return { content: "complete", toolCalls: [], finishReason: "stop" };
    },
  };
  return new RunService({
    database,
    skills: new SkillService(database),
    modelFactory: () => model,
    plannerFactory: () => singleStepTestPlanner(),
    assessorFactory: () => approvingTestAssessor(),
    tools: [tool],
    ...options,
  });
}

class ProjectionFailingConnection implements SqlConnection {
  readonly dialect = "sqlite" as const;
  private readonly inner: SqlConnection;
  constructor(inner: SqlConnection) { this.inner = inner; }
  exec(sql: string): Promise<void> { return this.inner.exec(sql); }
  prepare(sql: string): SqlStatement {
    const statement = this.inner.prepare(sql);
    if (!sql.includes("INSERT INTO run_events")) return statement;
    return {
      run: async (...params) => {
        const type = params[2];
        if (type === "tool.result_committed" || type === "tool.projection_failed") {
          throw new Error(`injected event append failure: ${type}`);
        }
        return statement.run(...params);
      },
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
    };
  }
  transaction<T>(operation: () => T | Promise<T>): Promise<T> { return this.inner.transaction(operation); }
  close(): Promise<void> { return Promise.resolve(); }
}
