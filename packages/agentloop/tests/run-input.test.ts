import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { RunInputRepository } from "../src/runtime/run-input-repository.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { TerminalCommitter } from "../src/runtime/terminal-committer.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

async function seed(db: AppDatabase) {
  await db.prepare("INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at) VALUES ('r', 'owner', 0, 0, 'running', 'Task', 1)").run();
}

test("Run input is ordered, owner scoped, idempotent across terminal retries and fenced against Tool dispatch", async () => {
  const db = new AppDatabase(":memory:");
  try {
    await seed(db);
    const queue = new RunInputRepository(db);
    await assert.rejects(queue.accept("other", "r", { requestId: "one", text: "hello" }), { code: "NOT_FOUND" });
    const [first, retry] = await Promise.all([queue.accept("owner", "r", { requestId: "one", text: "hello" }), queue.accept("owner", "r", { requestId: "one", text: "hello" })]);
    assert.equal(first.id, retry.id); assert.equal(first.seq, 1);
    await assert.rejects(queue.accept("owner", "r", { requestId: "one", text: "different" }), { code: "CONFLICT" });
    await assert.rejects(new RuntimeActionRepository(db).execute({ runId: "r", kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1000 }, async () => assert.fail("pending input must fence Tool effects")), { code: "STEER_PENDING" });
    const message = await queue.claim("r", "worker-one");
    await assert.rejects(queue.claim("r", "worker-two"), { code: "CONFLICT" });
    await assert.rejects(queue.finish(message!, "worker-two", "answered", {}), { code: "CONFLICT" });
    await queue.finish(message!, "worker-one", "answered", { explanation: "Working" });
    await queue.checkpoint("r");
    await db.transaction(async () => { await queue.assertDrained("r"); await db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'r'").run(); });
    assert.equal((await queue.accept("owner", "r", { requestId: "one", text: "hello" })).status, "answered");
    await assert.rejects(queue.accept("owner", "r", { requestId: "two", text: "new" }), { code: "CONFLICT" });
  } finally { await db.close(); }
});

for (const boundary of ["before_dispatch", "tool_completed", "terminal_commit"] as const) test(`Steer at ${boundary} preserves receipts and fences stale effects`, async () => {
  const db = new AppDatabase(":memory:");
  let runs: RunService, injected = false, effects = 0, modelCalls = 0;
  const originalCommit = TerminalCommitter.prototype.commitCompleted;
  const inject = async (runId: string) => {
    if (injected) return;
    injected = true;
    await runs.submitInput("owner", runId, { requestId: "boundary-input", text: "How is it going?" });
  };
  if (boundary === "terminal_commit") TerminalCommitter.prototype.commitCompleted = async function(runId, planId, output) {
    await inject(runId);
    return originalCommit.call(this, runId, planId, output);
  };
  try {
    runs = new RunService({ database: db, skills: new SkillService(db),
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      tools: [{ name: "external_effect", description: "Record a confirmed external action", inputSchema: { type: "object" },
        executionMode: "exclusive", replaySafe: false, parse: value => value,
        execute: async context => { effects++; if (boundary === "tool_completed") await inject(context.grant.runId); return { receipt: "effect-confirmed" }; } }],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.tools.some(tool => tool.name === "submit_run_input_decision")) return {
          content: "", finishReason: "tool_calls", toolCalls: [{ id: "decision", name: "submit_run_input_decision", arguments: { kind: "answer", explanation: "The recorded task is in progress." } }],
        };
        modelCalls++;
        if (modelCalls === 1) {
          if (boundary === "before_dispatch") await inject(request.runId);
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "effect-one", name: "external_effect", arguments: {} }] };
        }
        if (boundary === "tool_completed") assert.ok(request.messages.some(message => message.role === "tool" && message.content.includes("effect-confirmed")), "resumed model must receive the committed receipt");
        return { content: "Task finished with the recorded evidence.", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.execute("owner", "Answer the question using the available action.");
    assert.equal(run.status, "completed");
    assert.equal(effects, boundary === "before_dispatch" ? 0 : 1);
    assert.equal((await runs.inputMessages("owner", run.id))[0]?.status, "answered");
    const events = await runs.events("owner", run.id);
    assert.ok(events.findIndex(event => event.type === "run.input.decided") < events.findIndex(event => event.type === "run.completed"));
  } finally { TerminalCommitter.prototype.commitCompleted = originalCommit; await db.close(); }
});

test("input during initial planning pauses before admission and resumes the same Run after clarification", async () => {
  const db = new AppDatabase(":memory:");
  let runs: RunService, plans = 0, decisions = 0, executions = 0;
  const planner = singleStepTestPlanner();
  try {
    runs = new RunService({ database: db, skills: new SkillService(db), assessorFactory: approvingTestAssessor,
      plannerFactory: () => ({ plan: async task => {
        if (++plans === 1) await runs.submitInput("owner", task.runId, { requestId: "planning-input", text: "Use the other scope" });
        return planner.plan(task);
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async input => {
        if (input.tools.some(tool => tool.name === "submit_run_input_decision")) return {
          content: "", finishReason: "tool_calls", toolCalls: [{ id: "decision", name: "submit_run_input_decision", arguments: {
            kind: ++decisions === 1 ? "clarify" : "answer", explanation: "Which scope should be used?",
          } }],
        };
        executions++; return { content: "Completed in the confirmed scope.", finishReason: "stop", toolCalls: [] };
      } }),
    });
    let run = await runs.execute("owner", "Answer the question.");
    assert.equal(run.status, "running"); assert.equal(executions, 0);
    assert.equal((await db.prepare("SELECT id FROM plans WHERE run_id = ?").all(run.id)).length, 0);
    const request = await runs.currentHumanLoop("owner", run.id);
    assert.equal(request?.planId, undefined);
    await runs.respondHumanLoop("owner", run.id, request!.id, { clarification: "Keep the original scope" }, request!.revision);
    for (let attempt = 0; attempt < 100 && run.status === "running"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5)); run = await runs.get("owner", run.id);
    }
    assert.equal(run.status, "completed"); assert.equal(executions, 1);
    assert.deepEqual((await runs.inputMessages("owner", run.id)).map(message => message.status), ["needs_clarification", "answered"]);
  } finally { await db.close(); }
});

test("expired consumer can be replaced and cancellation preserves pending messages with a reason", async () => {
  const db = new AppDatabase(":memory:");
  try {
    await seed(db);
    const queue = new RunInputRepository(db);
    await queue.accept("owner", "r", { requestId: "one", text: "hello" });
    await queue.claim("r", "old", 1);
    const reclaimed = await queue.claim("r", "new");
    await assert.rejects(queue.finish(reclaimed!, "old", "applied", {}), { code: "CONFLICT" });
    await db.transaction(async () => { await queue.stop("r", "CANCELLED"); await db.prepare("UPDATE runs SET status = 'cancelled' WHERE id = 'r'").run(); });
    assert.equal((await queue.list("r"))[0]!.status, "unprocessed");
    assert.equal((await queue.list("r"))[0]!.decision?.reason, "CANCELLED");
  } finally { await db.close(); }
});

for (const kind of ["answer", "amend", "clarify"] as const) test(`active Run consumes ${kind} before assessing stale output`, async () => {
  const db = new AppDatabase(":memory:");
  let runs: RunService, injected = false, calls = 0, plans = 0, decisions = 0;
  const base = singleStepTestPlanner();
  try {
    runs = new RunService({ database: db, skills: new SkillService(db), assessorFactory: () => approvingTestAssessor(),
      plannerFactory: () => ({ plan: async task => { plans++; return await base.plan(task); } }),
      planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "Aligned with user steer", evidenceRefs: [] }) }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.runId.startsWith("conversation-turn:")) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "intent", name: "resolve_conversation_turn", arguments: {
          mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: "Answer the requested question.",
          taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: true,
            deliverables: [{ targetId: "answer", purpose: "Answer the requested question", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
          evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
        } }] };
        if (request.tools.some(tool => tool.name === "submit_run_input_decision")) {
          decisions++;
          const state = (await runs.plan("owner", request.runId)).plan;
          const target = state.steps[0]!.executionBinding.targetIds[0]!;
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "decision", name: "submit_run_input_decision", arguments: {
            kind: request.messages.at(-1)?.content === "progress while paused" ? "answer" : kind === "clarify" && decisions > 1 ? "amend" : kind, explanation: kind === "answer" ? "The task is in progress." : "Focus the answer on East China.",
            effectiveGoal: "Answer the requested question, focused on East China.", userConstraints: ["Focus on East China"],
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
              deliverables: [{ targetId: target, purpose: "Answer focused on East China", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation", format: null }] },
          } }] };
        }
        calls++;
        if (!injected) {
          injected = true;
          await runs.submitInput("owner", request.runId, { requestId: "steer-one", text: kind === "answer" ? "How is it going?" : "Focus on East China" });
          return { content: "Stale draft", finishReason: "stop", toolCalls: [] };
        }
        return { content: "The answer focused on East China.", finishReason: "stop", toolCalls: [] };
      } }),
    });
    let run = await runs.executeConversation("owner", "Answer the requested question.");
    if (kind === "clarify") {
      assert.equal(run.status, "running");
      const request = await runs.currentHumanLoop("owner", run.id);
      assert.equal(request?.resume.mode, "run_input");
      assert.equal(calls, 1, "ambiguous input pauses the original execution");
      // Durable acceptance without an in-process wake models a lost wake/restart scan.
      await new RunInputRepository(db).accept("owner", run.id, { requestId: "paused-progress", text: "progress while paused" });
      await runs.reconcileRunInputs([run.id]);
      assert.equal((await runs.currentHumanLoop("owner", run.id))?.id, request!.id);
      assert.equal((await runs.currentHumanLoop("owner", run.id))?.revision, request!.revision);
      assert.equal((await runs.inputMessages("owner", run.id))[1]?.status, "answered");
      await runs.respondHumanLoop("owner", run.id, request!.id, { clarification: "Focus on East China" }, request!.revision);
      for (let attempt = 0; attempt < 100 && run.status === "running"; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5)); run = await runs.get("owner", run.id);
      }
    }
    assert.equal(run.status, "completed", JSON.stringify((await runs.events("owner", run.id)).filter(e => /failed|waiting/.test(e.type))));
    assert.equal(run.output, "The answer focused on East China.");
    const messages = await runs.inputMessages("owner", run.id);
    assert.equal(messages[0]!.status, kind === "answer" ? "answered" : kind === "clarify" ? "needs_clarification" : "applied");
    if (kind === "clarify") assert.equal(messages[2]?.status, "applied");
    assert.equal(plans, kind === "answer" ? 1 : 2); assert.equal(calls, 2);
    const plan = (await runs.plan("owner", run.id)).plan;
    assert.equal(plan.version, kind === "answer" ? 1 : 2);
    assert.ok(!(await runs.events("owner", run.id)).some(e => e.type === "plan.step.completed" && e.data.output === "Stale draft"));
  } finally { await db.close(); }
});
