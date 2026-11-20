import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { RunService } from "../src/runtime/run-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { createRuntimeCapabilitySnapshotFromSources } from "../src/runtime/capability-snapshot.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

for (const scenario of ["preserve", "repair", "exhausted"] as const) test(`Steer delivery decision ${scenario} preserves the goal and is recoverable`, async () => {
  const db = new AppDatabase(":memory:");
  const intent = { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
    deliverables: [{ targetId: "a_share_market_today_analysis_answer", purpose: "分析今天 A 股情况", expectedArtifactCount: 1,
      action: "none", kind: "none", surface: "conversation" }] };
  let runs: RunService, injected = false, decisions = 0, allowResume = false, plans = 0;
  try {
    const base = singleStepTestPlanner();
    const skills = new SkillService(db, { skillPackageRoots: [
      resolve(import.meta.dirname, "../../../apps/agentloop-multi-runtime/custom-skills/data-analysis"),
      resolve(import.meta.dirname, "../../agentloop-skills/skills/research"),
    ] });
    await skills.refreshSkillDirectory();
    runs = new RunService({ database: db, skills, assessorFactory: approvingTestAssessor,
      runtimeCapabilitySnapshotProvider: () => [createRuntimeCapabilitySnapshotFromSources({ scope: "runtime_configured", capturedAt: 1,
        sources: [{ label: "Web search", state: "load_failed", unavailableReason: "web_search_credentials_missing", operations: [] }] })],
      plannerFactory: () => ({ plan: async task => {
        plans++;
        assert.match(JSON.stringify(task.planningExtensionContexts), /web_search_credentials_missing/);
        assert.ok(!task.availableSkills.some(skill => skill.name === "data-analysis"), "initial and Steer planning preserve source relevance");
        assert.ok(!task.capabilityRecovery?.availableSkills.some(skill => skill.name === "data-analysis"), "evidence-gap recovery cannot recall an unrelated database");
        assert.ok(!task.capabilityRecovery?.availableCapabilities.some(capability => capability.id.includes("discovered:data-analysis")));
        if (plans > 1) assert.deepEqual(task.canonicalState.intent.understanding.deliverables, intent.deliverables);
        const proposal = await base.plan({ ...task, availableSkills: [] });
        return { ...proposal, steps: proposal.steps.map(step => ({ ...step,
          requiredCapabilities: ["authorized_tool_use", "conversation_delivery"],
          evidenceContract: { requiredKinds: ["source_summary" as const], caveatPolicy: "mark_unverified_facts" as const },
        })) };
      } }),
      planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "Aligned with the amended source constraint", evidenceRefs: [] }) }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.tools.some(tool => tool.name === "resolve_conversation_turn")) return {
          content: "", finishReason: "tool_calls", toolCalls: [{ id: "intent", name: "resolve_conversation_turn", arguments: {
            mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: "分析今天 A 股情况", taskIntent: intent,
            evidenceStrategy: "source_grounded", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
          } }],
        };
        if (request.tools.some(tool => tool.name === "submit_run_input_decision")) {
          decisions++;
          const context = JSON.parse(request.runtimeContext!.content);
          const malformed = !allowResume && (scenario === "exhausted" || (scenario === "repair" && decisions === 1));
          if (scenario !== "preserve" && decisions > 1 && !allowResume) {
            assert.match(context.validationFeedback.at(-1).feedback, /targetId/);
            assert.equal(context.validationFeedback.at(-1).decision.taskIntent.deliverables[0].targetId, "中文标识");
          }
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "decision", name: "submit_run_input_decision", arguments: {
            kind: "amend", explanation: "保留分析目标，改用联网信息", effectiveGoal: "联网获取今天 A 股信息并分析", userConstraints: ["数据库没有行情，不再探查业务库"],
            taskIntent: malformed ? { ...intent, deliverables: [{ ...intent.deliverables[0], targetId: "中文标识" }] } : null,
          } }] };
        }
        if (!injected) {
          injected = true;
          await runs.submitInput("owner", request.runId, { requestId: "steer-source", text: "大哥，这个还是要联网找今天的A股信息，数据库里没有信息的。" });
        }
        assert.match(request.runtimeContext!.content, /web_search_credentials_missing/);
        return { content: "后续执行已采用补充要求。", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", "帮我分析一下今天 A 股的情况");
    const events = await runs.events("owner", run.id);
    assert.equal(events.some(event => event.type === "run.failed"), false);
    assert.equal(events.filter(event => event.type === "run.input.decision_attempt_failed").length, scenario === "preserve" ? 0 : scenario === "repair" ? 1 : 3);
    assert.equal(run.status, scenario === "exhausted" ? "running" : "completed");
    assert.equal((await runs.inputMessages("owner", run.id))[0]?.status, scenario === "exhausted" ? "needs_clarification" : "applied");
    if (scenario === "exhausted") {
      assert.equal(plans, 1, "do not resume stale planning when the amendment is invalid");
      const request = await runs.currentHumanLoop("owner", run.id);
      assert.equal(request?.resume.mode, "run_input");
      allowResume = true;
      await runs.respondHumanLoop("owner", run.id, request!.id, { clarification: "保留分析目标，按刚才的联网要求重试" }, request!.revision);
      await runs.whenRunIdle(run.id);
      for (let i = 0; i < 100 && (await runs.get("owner", run.id)).status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal((await runs.get("owner", run.id)).status, "completed");
    }
  } finally { await db.close(); }
});

test("Steer interrupts an outstanding provider wait before its normal timeout", async () => {
  const db = new AppDatabase(":memory:");
  let entered!: (runId: string) => void;
  const waiting = new Promise<string>(resolve => { entered = resolve; });
  let first = true, providerAborted = false;
  try {
    const runs = new RunService({ database: db, skills: new SkillService(db), plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request, signal) => {
        if (request.tools.some(tool => tool.name === "submit_run_input_decision")) return {
          content: "", finishReason: "tool_calls", toolCalls: [{ id: "decision", name: "submit_run_input_decision", arguments: { kind: "answer", explanation: "正在按原目标执行。" } }],
        };
        if (first) {
          first = false; entered(request.runId);
          await new Promise((_, reject) => {
            signal!.addEventListener("abort", () => { providerAborted = true; reject(signal!.reason); }, { once: true });
          });
        }
        return { content: "已完成原目标。", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const completion = runs.execute("owner", "Answer the question.");
    const runId = await waiting;
    await runs.submitInput("owner", runId, { requestId: "during-model-wait", text: "现在进展如何？" });
    const run = await completion;
    assert.equal(providerAborted, true);
    assert.equal(run.status, "completed");
    assert.equal((await runs.inputMessages("owner", runId))[0]?.status, "answered");
    assert.ok((await runs.events("owner", runId)).some(event => event.type === "model.request.interrupted" && event.data.reason === "steer_pending"));
  } finally { await db.close(); }
});

test("Steer interruption drains an already dispatched unsafe Tool and preserves its receipt", { timeout: 5000 }, async () => {
  const db = new AppDatabase(":memory:");
  let started!: (runId: string) => void, finish!: () => void;
  const toolStarted = new Promise<string>(resolve => { started = resolve; });
  const toolRelease = new Promise<void>(resolve => { finish = resolve; });
  let first = true, effects = 0, toolWasAborted = false;
  try {
    const runs = new RunService({ database: db, skills: new SkillService(db), plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      tools: [{ name: "record_effect", description: "Record an external effect once", inputSchema: { type: "object" }, executionMode: "exclusive", replaySafe: false,
        parse: value => value, execute: async context => {
          effects++; started(context.grant.runId); await toolRelease;
          toolWasAborted = context.signal?.aborted === true;
          return { receipt: "confirmed-external-effect" };
        } }],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS,
        complete: async () => ({ content: "", finishReason: "tool_calls", toolCalls: [{ id: "input", name: "submit_run_input_decision", arguments: { kind: "answer", explanation: "动作已经确认完成。" } }] }),
        streamComplete: async (request, sink, signal) => {
          if (first) {
            first = false;
            await sink({ type: "tool_call_ready", index: 0, id: "effect", name: "record_effect", arguments: {} });
            await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
          }
          assert.ok(request.messages.some(message => message.role === "tool" && message.content.includes("confirmed-external-effect")));
          return { content: "动作已完成，回执已保留。", finishReason: "stop", toolCalls: [] };
        },
      }),
    });
    const completion = runs.execute("owner", "Perform the requested action and report the result.");
    const runId = await toolStarted;
    await runs.submitInput("owner", runId, { requestId: "during-effect", text: "进展如何？" });
    finish();
    const run = await completion;
    assert.equal(run.status, "completed");
    assert.equal(effects, 1);
    assert.equal(toolWasAborted, false);
    const events = await runs.events("owner", runId);
    assert.equal(events.filter(event => event.type === "tool.completed" && event.data.toolName === "record_effect").length, 1);
    assert.equal((await runs.inputMessages("owner", runId))[0]?.status, "answered");
  } finally { finish(); await db.close(); }
});
