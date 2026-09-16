import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SqlToolResultStore } from "../src/storage/repositories/tool-result-store.ts";
import type { RuntimeTool } from "../src/tools/tool-registry.ts";
import { AppError } from "../src/shared/errors.ts";
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
          locator = /locator=(tool-result:\/\/[0-9a-f-]+)/.exec(projected?.role === "tool" ? projected.content : "")?.[1] ?? "";
          sha256 = /sha256=([0-9a-f]{64})/.exec(projected?.role === "tool" ? projected.content : "")?.[1] ?? "";
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
