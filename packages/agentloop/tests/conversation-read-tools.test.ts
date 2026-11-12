import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunService } from "../src/runtime/run-service.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { toolNamesForConversationMode } from "../src/runtime/conversation-tool-policy.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import type { ModelResponse } from "../src/runtime/contracts.ts";

function resolve(goal: string, extra: Record<string, unknown> = {}): ModelResponse {
  return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
    mode: "reply", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
    evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
    userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
    taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
      deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
    ...extra,
  } }] };
}
function text(content: string): ModelResponse { return { content, finishReason: "stop", toolCalls: [] }; }
function call(name: string, args: Record<string, unknown>): ModelResponse {
  return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `call-${name}`, name, arguments: args }] };
}
function tool(name: string, effect?: "read" | "write", replaySafe = true): RuntimeTool {
  return { name, description: "Host-declared operation", effect, replaySafe, executionMode: "parallel",
    inputSchema: { type: "object" }, parse: input => input, execute: async () => ({ value: "live-observation" }) };
}

test("reply authority uses declared effects independently of tool names, replay safety and metadata availability", () => {
  const tools = [tool("observe", "read", false), tool("read_but_mutate", "write"), tool("get_unknown"), tool("not_authorized", "read")];
  const authorized = ["observe", "read_but_mutate", "get_unknown"];
  assert.deepEqual(toolNamesForConversationMode("reply", tools, authorized), ["observe"]);
  assert.deepEqual(toolNamesForConversationMode("clarify", tools, authorized), []);
  assert.deepEqual(toolNamesForConversationMode("execute", tools, authorized), authorized);
  // Even an old recovery name-list cannot restore writers or newly reclassified tools.
  const grant = createCapabilityGrant({ actorUserId: "owner", runId: "run", depth: 0,
    allowedToolNames: authorized, allowedSkillIds: [], toolEffectScope: "read" });
  const materialized = new ToolRegistry(tools).materialize(grant);
  assert.deepEqual(materialized.definitions.map(item => item.name), ["observe"]);
  for (const name of ["read_but_mutate", "get_unknown", "not_authorized"]) {
    assert.throws(() => materialized.prepare({ id: "denied", name, arguments: {} }), /not available/);
  }
  assert.deepEqual(new ToolRegistry([tool("observe", "write")]).materialize(grant).definitions, []);
});

test("reply can select a generic service reader and then a visible file without becoming execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-read-reply-"));
  const visible = await mkdtemp(join(tmpdir(), "agentloop-read-source-"));
  const db = new AppDatabase(":memory:");
  let reads = 0, executionTurns = 0, assessments = 0;
  const observe = { ...tool("observe_catalog", "read", false), execute: async () => { reads++; return { status: "live-observation" }; } };
  try {
    await writeFile(join(visible, "state.txt"), "file-observation");
    const service = new RunService({ database: db, skills: new SkillService(db), workspaceRoot: root,
      tools: [observe, tool("read_mutation", "write"), tool("unclassified")],
      assessorFactory: () => ({ assess: async input => {
        assessments++;
        assert.deepEqual(input.evidence.toolCalls.map(item => item.toolName), ["observe_catalog", "visible_read_file", "read_result"]);
        assert.match(input.evidence.candidateOutput, /live-observation.*file-observation/);
        return approvingTestAssessor().assess(input);
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.runId.startsWith("conversation-turn:")) return resolve("Explain the current state", { evidenceStrategy: "lookup_lite" });
        assert.equal(request.phase, "execution");
        const names = request.tools.map(item => item.name);
        assert.ok(names.includes("observe_catalog"));
        assert.ok(names.includes("visible_read_file"));
        for (const denied of ["read_mutation", "unclassified", "computer_run_command", "computer_write_file", "visible_extract_tables"]) {
          assert.equal(names.includes(denied), false);
        }
        executionTurns++;
        if (executionTurns === 1) return call("observe_catalog", {});
        if (executionTurns === 2) return call("visible_read_file", { rootId: "visible_dir_1", path: "state.txt" });
        if (executionTurns === 3) {
          const receipt = request.messages.filter(item => item.role === "tool" && item.name === "visible_read_file").at(-1);
          const resultId = JSON.stringify(receipt).match(/rr_[0-9a-f-]{36}/)?.[0];
          assert.ok(resultId);
          return call("read_result", { resultId });
        }
        assert.match(JSON.stringify(request.messages), /live-observation/);
        assert.match(JSON.stringify(request.messages), /file-observation/);
        return text("live-observation and file-observation");
      } }),
    });
    const run = await service.executeConversation("owner", "Explain the current state", { visibleDirectories: [visible] });
    assert.equal(run.status, "completed", JSON.stringify((await service.events("owner", run.id)).slice(-8)));
    assert.equal(reads, 1); assert.equal(executionTurns, 4); assert.equal(assessments, 1);
    const events = await service.events("owner", run.id);
    const resolved = events.find(event => event.type === "conversation.turn.resolved")!.data;
    assert.equal(resolved.mode, "reply"); assert.equal(resolved.evidenceDemand, "lookup_lite");
    assert.equal(events.some(event => event.type === "conversation.turn.resolution_rejected"), false);
    const { plan } = await service.plan("owner", run.id);
    assert.deepEqual(plan.selectedSkillIds, []);
    assert.equal(plan.steps.length, 1);
    assert.ok(plan.steps[0].evidence?.publishedResult?.inputs?.length);
    const row = await db.prepare("SELECT context_json FROM run_planning_recovery WHERE run_id = ?").get(run.id) as { context_json: string };
    const persisted = JSON.parse(row.context_json);
    assert.ok(persisted.allowedToolNames.includes("observe_catalog"));
    assert.equal(persisted.allowedToolNames.includes("computer_write_file"), false);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); await rm(visible, { recursive: true, force: true }); }
});

test("a reply reads a bound prior Result exactly and publishes its provenance without resolver repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-prior-result-reply-"));
  const db = new AppDatabase(":memory:");
  let turn = 0, read = false, skippedRead = false, resultId = "";
  try {
    const options = { database: db, skills: new SkillService(db), workspaceRoot: root,
      assessorFactory: () => approvingTestAssessor(),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.runId.startsWith("conversation-turn:")) {
          turn++;
          if (turn === 1) return resolve("State the stored definitions");
          const context = JSON.parse(request.runtimeContext!.content.split("\n").slice(1, -1).join("\n"));
          assert.equal(context.conversationWorkingSet.reusableResultCandidates.length > 0, true);
          if (turn === 3) {
            assert.ok(context.conversationWorkingSet.priorGoalCandidates.some((item: { priorIntent?: { mode: string; inputMode: string } }) =>
              item.priorIntent?.mode === "reply" && item.priorIntent.inputMode === "prior_result"));
            return resolve("Acknowledge the prior explanation");
          }
          return resolve("Explain group from the stored definitions", { relation: "continue_prior", inputMode: "prior_result",
            resultCandidateId: context.conversationWorkingSet.reusableResultCandidates[0].candidateId });
        }
        if (turn === 3) return text("Understood.");
        if (turn === 1) return text("Definitions: demo is demonstration data; group is consolidated group reporting.");
        const context = request.runtimeContext!.content;
        const match = context.match(/rr_[0-9a-f-]{36}/);
        assert.ok(match); resultId = match[0];
        if (!skippedRead) { skippedRead = true; return text("An unsupported answer without reading the bound input."); }
        if (!read) { read = true; return call("read_result", { resultId }); }
        assert.match(JSON.stringify(request.messages), /consolidated group reporting/);
        return text("group means consolidated group reporting in the prior definitions.");
      } }),
    } satisfies ConstructorParameters<typeof RunService>[0];
    const service = new RunService(options);
    const first = await service.executeConversation("owner", "State the stored definitions");
    const second = await service.executeConversation("owner", "Explain group from those definitions", { conversationId: first.conversationId });
    assert.equal(second.status, "completed"); assert.equal(turn, 2); assert.equal(read, true);
    const events = await service.events("owner", second.id);
    assert.equal(events.some(event => event.type === "conversation.turn.resolution_rejected"), false);
    const resolution = events.find(event => event.type === "conversation.turn.resolved")!.data;
    assert.equal(resolution.mode, "reply"); assert.equal(resolution.inputMode, "prior_result");
    assert.ok(events.some(event => event.type === "candidate.dependency_results_unread"));
    assert.equal((resolution.targetResult as { resultId: string }).resultId, resultId);
    const { plan } = await service.plan("owner", second.id);
    assert.ok(plan.steps[0].evidence?.publishedResult?.inputs.some(ref => ref.resultId === resultId));
    assert.equal(plan.steps[0].evidence?.toolCalls.filter(item => item.toolName === "read_result").length, 1);
    const restarted = new RunService(options);
    const third = await restarted.executeConversation("owner", "Understood", { conversationId: first.conversationId });
    assert.equal(third.status, "completed");
    assert.equal(turn, 3);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("a reply cannot execute a writer even when the model requests one", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-denied-reply-"));
  const db = new AppDatabase(":memory:");
  let writes = 0, turns = 0;
  try {
    const service = new RunService({ database: db, skills: new SkillService(db), workspaceRoot: root,
      tools: [{ ...tool("mutate_resource", "write"), execute: async () => { writes++; return "changed"; } }],
      assessorFactory: () => approvingTestAssessor(),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.runId.startsWith("conversation-turn:")) return resolve("Explain the resource");
        assert.equal(request.tools.some(item => item.name === "mutate_resource"), false);
        if (turns++ === 0) return call("mutate_resource", {});
        return text("The requested mutation was not authorized.");
      } }),
    });
    const run = await service.executeConversation("owner", "Explain the resource");
    const events = await service.events("owner", run.id);
    assert.equal(writes, 0);
    assert.ok(events.some(event => event.type === "tool.rejected" && event.data.toolName === "mutate_resource"));
    assert.equal(events.some(event => event.type === "tool.completed" && event.data.toolName === "mutate_resource"), false);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
