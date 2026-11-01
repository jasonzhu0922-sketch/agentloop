import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { AppError } from "../src/shared/errors.ts";
import type { RuntimeTool } from "../src/tools/tool-registry.ts";
import { approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

function fixtureTool(name: string, transport: string): RuntimeTool {
  return {
    name, description: "Find items in the authorized archive.",
    source: {
      id: `${transport}.unseen-service`, displayName: `${transport} archive service`, transport, aliases: ["unseen-service"],
      capabilities: [{ id: "custom_archive.find", category: "read", label: "Find archive items" }],
    },
    inputSchema: { type: "object", properties: { privateInputField: { type: "string" } } },
    executionMode: "parallel", replaySafe: true, parse: (input) => input,
    execute: async () => { throw new Error("Catalog discovery must not invoke a tool"); },
  };
}

function resolution(mode: "execute" | "reply" | "clarify", goal: string) {
  return {
    content: "", finishReason: "tool_calls" as const,
    toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
      mode, relation: "new_goal", inputMode: "none", effectiveGoal: goal,
      taskIntent: {
        schema: "agentloop.conversationTaskIntent/v1", operation: mode === "reply" ? "answer" : "lookup",
        requiresExecution: mode === "execute", deliverables: [{
          targetId: "answer", purpose: goal, expectedArtifactCount: 1,
          action: "none", kind: "none", surface: "conversation",
        }],
      },
      evidenceStrategy: mode === "execute" ? "source_grounded" : "none",
      sourceBinding: { mode: "none", visibleDirectoryIds: [] },
      userConstraints: [], requiredCapabilityReferences: [],
    } }],
  };
}

function contextPayload(content: string) {
  const start = content.indexOf("\n");
  const end = content.lastIndexOf("\n");
  return JSON.parse(content.slice(start + 1, end));
}

test("intent resolution sees the authorized Run capability catalog before deciding mode, and Planner reuses it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-intent-catalog-"));
  const database = new AppDatabase(":memory:");
  const dynamic = fixtureTool("dynamic_archive_find", "connector");
  const core = fixtureTool("core_archive_find", "mcp");
  const order: string[] = [];
  const goal = "Search my authorized archive for a specific topic and summarize up to five matching items.";
  try {
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root, tools: [core],
      runToolProvider: { resolve: async (request) => {
        order.push("discover");
        assert.deepEqual(request.connectionIds, ["chosen-connection"]);
        assert.equal(request.actorUserId, "owner");
        return [dynamic];
      } },
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        order.push("resolve-intent");
        assert.deepEqual(order, ["discover", "resolve-intent"]);
        assert.deepEqual(request.tools.map((tool) => tool.name), ["resolve_conversation_turn"]);
        const context = contextPayload(request.runtimeContext!.content);
        assert.deepEqual(context.visibleDirectories, []);
        assert.deepEqual(context.sources, []);
        const metadata = context.availableTools.find((tool: { name: string }) => tool.name === dynamic.name);
        assert.equal(metadata.description, dynamic.description);
        assert.deepEqual(metadata.source, dynamic.source);
        assert.ok(context.availableTools.some((tool: { name: string }) => tool.name === core.name));
        assert.equal(request.runtimeContext!.content.includes("privateInputField"), false, "intent gets metadata, not invocation schemas");
        assert.match(request.systemPrompt, /A tool-free resolver is not an unavailable service/);
        assert.match(request.systemPrompt, /Generic capability or service descriptions are not exact/);
        return resolution("execute", goal);
      } }),
      plannerFactory: () => ({ plan: async (task) => {
        order.push("plan");
        assert.notEqual(task.responseOnly, true);
        assert.ok(task.availableTools?.some((tool) => tool.name === dynamic.name));
        assert.ok(task.availableCapabilities?.some((capability) => capability.id === "custom_archive.find"));
        assert.deepEqual(task.canonicalState.intent.turnResolution?.requiredCapabilityReferences, []);
        throw new AppError("PLANNING_ERROR", "catalog_reached_planner", 422);
      } }),
    });
    await assert.rejects(runs.executeConversation("owner", goal, { connectorConnectionIds: ["chosen-connection"] }), /catalog_reached_planner/);
    assert.deepEqual(order, ["discover", "resolve-intent", "plan"], "the selected provider must be materialized only once");
    const events = await database.prepare("SELECT type FROM run_events").all() as Array<{ type: string }>;
    assert.equal(events.some((event) => event.type === "tool.dispatched"), false);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["reply", "clarify"] as const) {
  test(`capability metadata does not grant execution authority to ${mode} turns`, async () => {
    const root = await mkdtemp(join(tmpdir(), `agentloop-catalog-${mode}-`));
    const database = new AppDatabase(":memory:");
    const tool = fixtureTool("archive_find", "connector");
    let discoveries = 0;
    const goal = mode === "reply" ? "Hello" : "Find some items; I have not decided which archive or topic yet.";
    try {
      const runs = new RunService({
        database, skills: new SkillService(database), workspaceRoot: root,
        assessorFactory: () => approvingTestAssessor(),
        runToolProvider: { resolve: async () => { discoveries += 1; return [tool]; } },
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
          if (request.runId.startsWith("conversation-turn:")) {
            assert.ok(contextPayload(request.runtimeContext!.content).availableTools.some((item: { name: string }) => item.name === tool.name));
            return resolution(mode, goal);
          }
          assert.deepEqual(request.tools, [], "reply/clarify must remain tool-free despite catalog discovery");
          return { content: mode === "reply" ? "Hello." : "Which archive and topic do you want?", finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.executeConversation("owner", goal, { connectorConnectionIds: ["chosen-connection"] });
      assert.equal(run.status, "completed", run.output);
      assert.equal(discoveries, 1);
      const events = await runs.events("owner", run.id);
      assert.equal(events.find((event) => event.type === "conversation.turn.resolved")?.data.mode, mode);
      assert.equal(events.some((event) => event.type === "tool.dispatched"), false);
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("intent catalog honors empty connection selection and dangerous-tool restrictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-intent-no-connections-"));
  const database = new AppDatabase(":memory:");
  let discoveries = 0;
  try {
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root,
      assessorFactory: () => approvingTestAssessor(),
      runToolProvider: { resolve: async () => { discoveries += 1; return [fixtureTool("unselected_tool", "connector")]; } },
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) {
          const names = contextPayload(request.runtimeContext!.content).availableTools.map((tool: { name: string }) => tool.name);
          assert.equal(names.includes("unselected_tool"), false);
          assert.equal(names.includes("computer_run_command"), false);
          assert.equal(names.includes("computer_write_file"), false);
          return resolution("reply", "Hello");
        }
        return { content: "Hello.", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", "Hello", { allowDangerousTools: false, connectorConnectionIds: [] });
    assert.equal(run.status, "completed");
    assert.equal(discoveries, 0);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a current authorized-capability reply receives a frozen redacted inventory without gaining tool authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-capability-reply-"));
  const database = new AppDatabase(":memory:");
  const connector = fixtureTool("archive_find", "connector");
  const mcp = fixtureTool("archive_lookup", "mcp");
  const goal = "我当前已授权的服务能做什么？";
  try {
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root, tools: [mcp],
      assessorFactory: () => approvingTestAssessor(),
      runToolProvider: { resolve: async () => [connector] },
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) return resolution("reply", goal);
        assert.deepEqual(request.tools, [], "an informational capability reply remains tool-free");
        const content = request.runtimeContext!.content;
        assert.match(content, /agentloop\.runtimeCapabilitySnapshot\/v1/);
        assert.match(content, /connector archive service/);
        assert.match(content, /mcp archive service/);
        assert.equal(content.includes("privateInputField"), false, "schemas must not enter the reply context");
        assert.equal(content.includes("chosen-connection"), false, "connection identifiers must not enter the reply context");
        return { content: "已授权的服务可以检索归档内容。", finishReason: "stop" as const, toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", goal, { connectorConnectionIds: ["chosen-connection"] });
    assert.equal(run.status, "completed", run.output);
    const events = await runs.events("owner", run.id);
    const snapshotEvent = events.find((event) => event.type === "runtime.capability_snapshot.created");
    assert.ok(snapshotEvent, "the selected capability inventory is auditable");
    const snapshot = snapshotEvent.data.snapshot as { schema: string; capturedAt: number; sources: Array<{ authorization: string; label: string }> };
    assert.equal(snapshot.schema, "agentloop.runtimeCapabilitySnapshot/v1");
    assert.equal(typeof snapshot.capturedAt, "number");
    assert.deepEqual(snapshot.sources.map((source) => source.authorization), ["selected_for_run", "selected_for_run"]);
    assert.equal(JSON.stringify(snapshot).includes("chosen-connection"), false);
    assert.equal(events.some((event) => event.type === "tool.dispatched"), false);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("an empty selected capability inventory is a truthful tool-free reply context", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-empty-capability-reply-"));
  const database = new AppDatabase(":memory:");
  const goal = "What can my currently authorized services do?";
  try {
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root,
      assessorFactory: () => approvingTestAssessor(),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) return resolution("reply", goal);
        assert.deepEqual(request.tools, []);
        assert.match(request.runtimeContext!.content, /"sources":\[\]/);
        return { content: "No selected authorized service is available for this Run.", finishReason: "stop" as const, toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", goal, { connectorConnectionIds: [] });
    assert.equal(run.status, "completed", run.output);
    const events = await runs.events("owner", run.id);
    assert.equal(events.some((event) => event.type === "tool.dispatched"), false);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
