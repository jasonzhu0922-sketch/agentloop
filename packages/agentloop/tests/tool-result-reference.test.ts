import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import type { ModelMessage } from "../src/runtime/contracts.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { ToolResultRepository, type ToolResultRef } from "../src/runtime/tool-result-repository.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { createToolResultTool } from "../src/tools/tool-result-tool.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import { singleStepTestPlanner, testOwner } from "./runtime-test-helpers.ts";

const runId = "tool-result-ref-run";
const planId = "tool-result-ref-plan";
const stepId = "inspect-values";

async function seedRun(database: AppDatabase): Promise<void> {
  const owner = testOwner();
  const now = Date.now();
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
  `).run(runId, owner.user.id, "inspect exact values", now);
  await database.prepare(`
    INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, input_bindings_json, status, created_at, updated_at)
    VALUES (?, ?, 1, ?, '[]', '[]', 'running', ?, ?)
  `).run(planId, runId, "inspect exact values", now, now);
}

test("successful Tool Actions atomically bind an opaque result ref and authorize exact bounded reads", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await seedRun(database);
    const actions = new RuntimeActionRepository(database);
    const results = new ToolResultRepository(database);
    let ref: ToolResultRef | undefined;
    const value = await actions.execute({
      runId,
      planId,
      stepId,
      kind: "tool_call",
      replayPolicy: "safe",
      deadlineMs: 1_000,
      metadata: { toolCallId: "read-values", toolName: "computer_read_json" },
      prepareResultRef: async (result, action) => {
        ref = await results.prepare({
          actionId: action.id,
          runId,
          planId,
          stepId,
          toolCallId: "read-values",
          toolName: "computer_read_json",
          value: result,
        });
        return ref.resultId;
      },
    }, async () => ({
      schema: "agentloop.jsonRead/v1",
      queries: [{ pointer: "/records", value: [{ id: 7, amount: 12.5 }, { id: 8, amount: 19.75 }] }],
    }));
    assert.equal(value.queries[0]?.value[1]?.amount, 19.75);
    assert.ok(ref);

    const action = (await actions.list(runId))[0];
    assert.equal(action?.state, "succeeded");
    assert.equal(action?.resultRef, ref.resultId);
    const committed = await database.prepare(`
      SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'action.result_committed'
    `).get(runId) as { payload_json: string };
    assert.equal(JSON.parse(committed.payload_json).resultRef, ref.resultId);

    const reader = new ToolRegistry([createToolResultTool(results)]).materialize(createCapabilityGrant({
      actorUserId: testOwner().user.id,
      runId,
      planId,
      stepId,
      depth: 0,
      allowedToolNames: ["read_tool_result"],
      allowedSkillIds: [],
    }));
    const prepared = reader.prepare({
      id: "recover-values",
      name: "read_tool_result",
      arguments: { resultId: ref.resultId, pointer: "/queries/0/value", offset: 1, limit: 1 },
    });
    const recovered = await prepared.tool.execute({ grant: createCapabilityGrant({
      actorUserId: testOwner().user.id,
      runId,
      planId,
      stepId,
      depth: 0,
      allowedToolNames: ["read_tool_result"],
      allowedSkillIds: [],
    }) }, prepared.input) as Record<string, any>;
    assert.deepEqual(recovered.value, [{ id: 8, amount: 19.75 }]);
    assert.deepEqual(recovered.sourceToolResultRef, ref);
    assert.equal(JSON.stringify(prepared.input).includes("sha256"), false);
    assert.equal(JSON.stringify(prepared.input).includes(".agentloop"), false);

    const wrongStep = await results.readAuthorized({ resultId: ref.resultId, runId, planId, stepId: "other-step" });
    assert.equal(wrongStep, undefined, "an opaque ref must not cross the granted Plan step");
  } finally {
    await database.close();
  }
});

test("AgentLoop exposes the Runtime-owned ref alongside the current exact result", async () => {
  const ref = { schema: "agentloop.toolResultRef/v1", resultId: "tr_00000000-0000-4000-8000-000000000001" } as const;
  let turns = 0;
  const result = await runAgentLoop({
    runId,
    input: "read one exact value",
    systemPrompt: "Use the Tool result.",
    tools: new ToolRegistry([{
      name: "computer_read_json",
      description: "test structured read",
      inputSchema: { type: "object" },
      executionMode: "parallel",
      replaySafe: true,
      parse: (input) => input,
      execute: async () => ({
        schema: "agentloop.jsonRead/v1",
        queries: [{ pointer: "/rows", value: [{ name: "alpha", score: 97 }] }],
        caveats: [],
      }),
    }]),
    availableSkills: [],
    maxSteps: 2,
    grant: createCapabilityGrant({
      actorUserId: "owner",
      runId,
      planId,
      stepId,
      depth: 0,
      allowedToolNames: ["computer_read_json"],
      allowedSkillIds: [],
    }),
    actionTracker: {
      executeToolCall: async (_input, operation) => ({ value: await operation(), resultRef: ref }),
    },
    model: {
      limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
      complete: async (input) => {
        turns += 1;
        if (turns === 1) return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "read", name: "computer_read_json", arguments: {} }],
        };
        const tool = input.messages.findLast((message) => message.role === "tool");
        assert.ok(tool && tool.role === "tool");
        const parsed = JSON.parse(tool.content);
        assert.equal(parsed.queries[0].value[0].score, 97);
        assert.deepEqual(parsed.toolResultRef, ref);
        return { content: "score=97", finishReason: "stop", toolCalls: [] };
      },
    },
  });
  assert.equal(result.output, "score=97");
});

test("RunService gives every successful Tool Action a persisted ref and emits it with the Tool result", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const skills = new SkillService(database);
    const tool: RuntimeTool<unknown> = {
      name: "structured_read",
      description: "Return exact structured values",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      executionMode: "parallel",
      replaySafe: true,
      parse: (input) => input,
      execute: async () => ({ schema: "example.values/v1", values: [3, 5, 8] }),
    };
    let calls = 0;
    const runs = new RunService({
      database,
      skills,
      tools: [tool],
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => ({
        assess: async (input) => ({
          id: "assessment",
          planId: input.planId,
          stepId: input.step.id,
          attempt: input.attempt,
          assessmentProfile: input.assessmentProfile,
          assessmentMethod: "model" as const,
          approved: true,
          criteria: input.step.successCriteria.map((criterion) => ({ criterionId: criterion.id, satisfied: true, evidenceRefs: ["structured"] })),
          skills: [],
          evidenceDigest: "structured-read",
          feedback: "approved",
          createdAt: Date.now(),
        }),
      }),
      modelFactory: () => ({
        limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
        complete: async (input) => {
          calls += 1;
          if (calls === 1) return {
            content: "",
            finishReason: "tool_calls" as const,
            toolCalls: [{ id: "values-1", name: "structured_read", arguments: {} }],
          };
          const result = input.messages.findLast((message) => message.role === "tool" && message.name === "structured_read");
          assert.ok(result && result.role === "tool");
          assert.equal(JSON.parse(result.content).values[2], 8);
          return { content: "values inspected", finishReason: "stop" as const, toolCalls: [] };
        },
      }),
      maxSteps: 2,
    });
    const run = await runs.execute(owner.user.id, "inspect values");
    assert.equal(run.status, "completed");
    const action = (await runs.actionsForRun(owner.user.id, run.id)).find((item) => item.kind === "tool_call");
    assert.match(action?.resultRef ?? "", /^tr_/u);
    const row = await database.prepare("SELECT id, content FROM tool_results WHERE action_id = ?")
      .get(action!.id) as { id: string; content: string };
    assert.equal(row.id, action?.resultRef);
    assert.deepEqual(JSON.parse(row.content).values, [3, 5, 8]);
    const completed = (await runs.events(owner.user.id, run.id)).find((event) =>
      event.type === "tool.completed" && event.data.toolCallId === "values-1"
    );
    assert.equal((completed?.data.toolResultRef as { resultId?: string } | undefined)?.resultId, action?.resultRef);
    assert.equal(JSON.parse(String(completed?.data.result)).toolResultRef, undefined);
  } finally {
    await database.close();
  }
});

test("recovery reconstructs the model-visible ref from canonical Tool result plus persisted ref metadata", () => {
  const ref = { schema: "agentloop.toolResultRef/v1", resultId: "tr_00000000-0000-4000-8000-000000000003" } as const;
  const transcript = reconstructRecoveryTranscript({
    userInput: "inspect values",
    stepId,
    events: [
      { seq: 1, type: "plan.step.started", data: { stepId } },
      { seq: 2, type: "assistant.committed", data: {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "values", name: "structured_read", arguments: {} }],
      } },
      { seq: 3, type: "tool.completed", data: {
        toolCallId: "values",
        toolName: "structured_read",
        result: JSON.stringify({ schema: "example.values/v1", values: [13, 21] }),
        toolResultRef: ref,
        invocationStatus: "completed",
        operationStatus: "succeeded",
        isError: false,
      } },
    ],
  });
  const result = transcript.messages.find((message) => message.role === "tool");
  assert.ok(result && result.role === "tool");
  assert.deepEqual(JSON.parse(result.content).toolResultRef, ref);
});

test("consumed and compacted structured reads keep a deterministic Tool result catalog even when the summary omits it", async () => {
  const ref = { schema: "agentloop.toolResultRef/v1", resultId: "tr_00000000-0000-4000-8000-000000000002" } as const;
  const messages: ModelMessage[] = [
    { role: "user", content: "inspect records" },
    { role: "assistant", content: "", toolCalls: [{ id: "read", name: "computer_read_json", arguments: { path: "data.json" } }] },
    { role: "tool", toolCallId: "read", name: "computer_read_json", isError: false, content: JSON.stringify({
      schema: "agentloop.jsonRead/v1",
      path: "data.json",
      sha256: "a".repeat(64),
      root: { type: "object" },
      queries: [{ pointer: "/records", offset: 0, limit: 2, value: [{ id: 1 }, { id: 2 }] }],
      caveats: [],
      toolResultRef: ref,
    }) },
    { role: "assistant", content: "I consumed the exact rows. " + "old reasoning ".repeat(5_000), toolCalls: [{ id: "next", name: "noop", arguments: {} }] },
    { role: "tool", toolCallId: "next", name: "noop", isError: false, content: JSON.stringify({ ok: true }) },
  ];
  let summaryCalls = 0;
  const context = new ContextAssembler({
    runId,
    systemPrompt: "Inspect evidence.",
    runtimeContext: { phase: "execution", content: "Continue the admitted step." },
    policy: { proactiveCompactionTokens: 3_000, preserveRecentTokens: 1_000, pruneProtectTokens: 100 },
    model: {
      limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
      complete: async () => {
        summaryCalls += 1;
        return {
          content: "## Goal\nInspect records\n## Progress\n### Done\n- Read records\n### In Progress\n- Continue\n### Blocked\n- none\n## Key Decisions\n- none\n## Evidence\n- intentionally omitted id\n## Next Steps\n1. Continue\n## Critical Context\n- none",
          finishReason: "stop",
          toolCalls: [],
        };
      },
    },
  });
  context.setPromptProjectionPolicy({
    schema: "agentloop.promptProjectionPolicy/v1",
    policyId: "tool-result-ref-test",
    instruction: "",
    mode: "action_aware",
    largeToolResultProjectionCharacters: 2_048,
    largeToolResultPreviewCharacters: 800,
  });
  const assembly = await context.assemble(messages, []);
  assert.ok(summaryCalls > 0);
  assert.match(assembly.runtimeContext.content, /agentloop\.toolResultCatalog\/v1/);
  assert.match(assembly.runtimeContext.content, new RegExp(ref.resultId));
  assert.match(assembly.runtimeContext.content, /read_tool_result/);
  assert.doesNotMatch(assembly.runtimeContext.content, /\.agentloop\/content-refs/);
  assert.doesNotMatch(assembly.runtimeContext.content, /"sha256":"a{64}"/);

  const restarted = new ContextAssembler({
    runId,
    systemPrompt: "Inspect evidence.",
    runtimeContext: { phase: "execution", content: "Continue the admitted step." },
    model: { limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 }, complete: async () => {
      throw new Error("restart should not compact this bounded transcript");
    } },
  });
  const restored = await restarted.assemble(messages.slice(0, 3), []);
  assert.match(restored.runtimeContext.content, new RegExp(ref.resultId));
});
