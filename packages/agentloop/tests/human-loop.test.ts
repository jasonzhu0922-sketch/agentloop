import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { HumanLoopRepository } from "../src/runtime/human-loop.ts";
import { RunRepository } from "../src/storage/repositories/run-repository.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { createHumanLoopTool, HUMAN_LOOP_TOOL_NAME } from "../src/tools/human-loop-tool.ts";
import { AppError } from "../src/shared/errors.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("HumanLoopRepository persists a typed request and accepts exactly one schema-valid response", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunRepository(database);
    await runs.insertRun({ id: "run-hil", ownerUserId: "user-hil", allowDangerousTools: false, input: "choose", createdAt: Date.now() });
    const humanLoops = new HumanLoopRepository(database);
    const request = await humanLoops.create({
      runId: "run-hil", origin: "tool", kind: "selection", title: "Choose", prompt: "Choose a target", rationale: "Targets differ", evidenceRefs: ["tool-call-1"],
      responseSchema: { type: "select", minSelections: 1, maxSelections: 1, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      resume: { mode: "continue_step" },
    });
    assert.equal((await humanLoops.current("run-hil"))?.id, request.id);
    await assert.rejects(() => humanLoops.respond({ requestId: request.id, runId: "run-hil", actorUserId: "user-hil", expectedRevision: request.revision, value: ["missing"] }));
    const response = await humanLoops.respond({ requestId: request.id, runId: "run-hil", actorUserId: "user-hil", expectedRevision: request.revision, value: ["a"] });
    assert.deepEqual(response.value, ["a"]);
    assert.equal(await humanLoops.current("run-hil"), undefined);
    await assert.rejects(() => humanLoops.respond({ requestId: request.id, runId: "run-hil", actorUserId: "user-hil", expectedRevision: request.revision, value: ["b"] }));
  } finally { database.close(); }
});

test("generic request_human_loop Tool stops the loop before a completion candidate", async () => {
  const grant = createCapabilityGrant({ actorUserId: "user-hil", runId: "run-hil-tool", depth: 0, allowedToolNames: [HUMAN_LOOP_TOOL_NAME], allowedSkillIds: [] });
  await assert.rejects(() => runAgentLoop({
    runId: grant.runId, systemPrompt: "test", input: "need a choice", grant, maxSteps: 2,
    tools: new ToolRegistry([createHumanLoopTool()]),
    model: { limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "", finishReason: "tool_calls", toolCalls: [{
      id: "ask", name: HUMAN_LOOP_TOOL_NAME, arguments: {
        kind: "selection", title: "Choose", prompt: "Choose", rationale: "Ambiguous", evidenceRefs: [],
        responseSchema: { type: "select", minSelections: 1, maxSelections: 1, options: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
        resume: { mode: "continue_step" },
      },
    }] }) },
  }), (error: unknown) => error instanceof AppError && error.code === "HUMAN_LOOP_REQUIRED");
});
