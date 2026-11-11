import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunService } from "../src/runtime/run-service.ts";
import { createRuntimeCapabilitySnapshotFromSources } from "../src/runtime/capability-snapshot.ts";
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
      memoryAction: "none", memoryIntents: [],
    } }],
  };
}

function contextPayload(content: string) {
  const start = content.indexOf("\n");
  const end = content.lastIndexOf("\n");
  return JSON.parse(content.slice(start + 1, end));
}

for (const fixture of [
  { name: "data-analysis", input: "你看看你的skill 清单里有没有 data-analysis 这个技能", mode: "reply" },
  { name: "data-analysis", input: "你看看你的skill 清单里有没有 data-analysis 这个技能？", mode: "reply" },
  { name: "archive-query", input: "介绍一下 archive-query 的用途", mode: "reply" },
  { name: "archive-query", input: "用 archive-query 处理一下", mode: "clarify" },
] as const) {
  test(`Skill metadata cannot turn a resolved ${fixture.mode} into execution: ${fixture.input}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentloop-skill-reference-"));
    const database = new AppDatabase(":memory:");
    let replyCalls = 0;
    try {
      const skills = new SkillService(database);
      const skill = await skills.create("owner", {
        name: fixture.name, description: "Query and analyze authorized business data.",
        instructions: [
          "---", `name: ${fixture.name}`, "description: Query and analyze authorized business data.",
          "agentloop:", "  roles:", "    - primary_builder", "  artifactKinds:", "    - none",
          "  sourceKinds:", "    - database", "  producesEvidenceKinds:", "    - source_summary",
          "    - record_counts", "---", "PRIVATE DATABASE WORKFLOW",
        ].join("\n"),
      });
      assert.deepEqual(skill.agentLoop?.sourceKinds, ["database"]);
      const output = fixture.mode === "reply" ? `清单中有 ${fixture.name}，可用于查询和分析业务数据。` : "请说明要处理的具体对象和任务。";
      const runs = new RunService({ database, skills, workspaceRoot: root,
        assessorFactory: () => approvingTestAssessor(),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          if (request.runId.startsWith("conversation-turn:")) {
            const catalog = contextPayload(request.runtimeContext!.content).availableSkills;
            assert.ok(catalog.some((item: { name: string }) => item.name === fixture.name));
            return resolution(fixture.mode, fixture.input);
          }
          replyCalls += 1;
          assert.equal(request.phase, "execution", "a metadata reply needs no model-generated execution plan");
          assert.deepEqual(request.tools, [], "mentioning a Skill grants no tool authority");
          assert.doesNotMatch(request.runtimeContext!.content, /PRIVATE DATABASE WORKFLOW/);
          if (fixture.mode === "reply") {
            assert.match(request.runtimeContext!.content, /available_skill_catalog/);
            assert.ok(request.runtimeContext!.content.includes(skill.name));
          }
          return { content: output, finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.executeConversation("owner", fixture.input);
      assert.equal(run.status, "completed", run.output);
      assert.equal(run.output, output);
      assert.equal(replyCalls, 1);
      const events = await runs.events("owner", run.id);
      const resolved = events.find(event => event.type === "conversation.turn.resolved")!.data;
      assert.equal(resolved.mode, fixture.mode);
      assert.equal((resolved.taskIntent as { requiresExecution: boolean }).requiresExecution, false);
      assert.equal(resolved.evidenceDemand, "none");
      assert.deepEqual(resolved.userConstraints, []);
      assert.deepEqual(resolved.requiredCapabilityReferences, []);
      assert.equal(events.some(event => ["tool.dispatched", "planning.contract_failed"].includes(event.type)), false);
      const { plan } = await runs.plan("owner", run.id);
      assert.deepEqual(plan.selectedSkillIds, []);
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("a clarification is reviewed with the complete Skill catalog before skipping planning", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-clarify-review-"));
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    await skills.create("owner", { name: "archive-search", description: "Search private catalog metadata", instructions: "PRIVATE SKILL BODY" });
    let calls = 0;
    const goal = "查找内部目录中与采购合同有关的接口";
    const runs = new RunService({ database, skills, workspaceRoot: root,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        assert.ok(request.runId.startsWith("conversation-turn:"));
        calls += 1;
        const context = contextPayload(request.runtimeContext!.content);
        assert.ok(context.availableSkills.some((skill: { name: string; description: string }) =>
          skill.name === "archive-search" && skill.description === "Search private catalog metadata"));
        assert.doesNotMatch(request.runtimeContext!.content, /PRIVATE SKILL BODY/);
        if (calls === 1) return resolution("clarify", "需要先提供目录地址");
        assert.match(request.systemPrompt, /Review the proposed clarification/);
        return resolution("execute", goal);
      } }),
      plannerFactory: () => ({ plan: async (task) => {
        assert.equal(task.responseOnly, undefined);
        assert.equal(task.canonicalState.intent.turnResolution?.mode, "execute");
        assert.deepEqual(task.canonicalState.intent.turnResolution?.userConstraints, []);
        throw new AppError("PLANNING_ERROR", "clarify_review_reached_planner", 422);
      } }),
    });
    await assert.rejects(runs.executeConversation("owner", goal), /clarify_review_reached_planner/);
    assert.equal(calls, 2);
    const events = await database.prepare("SELECT type FROM run_events").all() as Array<{ type: string }>;
    assert.ok(events.some((event) => event.type === "conversation.turn.clarification_review_started"));
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a materially ambiguous request can remain a tool-free clarification after review", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-clarify-ambiguous-"));
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    await skills.create("owner", { name: "archive-search", description: "Search an archive", instructions: "Search the archive." });
    let calls = 0;
    const runs = new RunService({ database, skills, workspaceRoot: root, assessorFactory: () => approvingTestAssessor(),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) { calls += 1; return resolution("clarify", "Which archive and topic?"); }
        assert.deepEqual(request.tools, []);
        return { content: "请说明要查询哪个目录和主题。", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", "查找一些东西");
    assert.equal(run.status, "completed");
    assert.equal(calls, 2);
    const events = await runs.events("owner", run.id);
    assert.equal(events.find((event) => event.type === "conversation.turn.resolved")?.data.mode, "clarify");
    assert.equal(events.some((event) => event.type === "tool.dispatched"), false);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

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
    const snapshot = snapshotEvent.data.snapshot as { schema: string; scope: string; capturedAt: number; sources: Array<{ state: string; label: string }> };
    assert.equal(snapshot.schema, "agentloop.runtimeCapabilitySnapshot/v1");
    assert.equal(snapshot.scope, "run_authorized");
    assert.equal(typeof snapshot.capturedAt, "number");
    assert.deepEqual(snapshot.sources.map((source) => source.state), ["selected_for_run", "selected_for_run"]);
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

test("assessment receives the same frozen capability inventory as a capability reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-capability-assessment-"));
  const database = new AppDatabase(":memory:");
  const tool = fixtureTool("archive_find", "connector");
  const goal = "What can my currently authorized services do?";
  try {
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root,
      runToolProvider: { resolve: async () => [tool] },
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) return resolution("reply", goal);
        if (request.phase === "assessment") {
          const match = request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n<\/assessment_context>/);
          assert.ok(match, "assessment must receive server-authored context");
          const context = JSON.parse(match[1]!);
          assert.equal(context.runtimeCapabilitySnapshot.schema, "agentloop.runtimeCapabilitySnapshot/v1");
          assert.equal(context.runtimeCapabilitySnapshot.sources[0].state, "selected_for_run");
          assert.match(context.evidence.candidateOutput, /authorized archive/);
          assert.match(request.systemPrompt, /frozen server-authored fact/);
          return { content: "", finishReason: "tool_calls" as const, toolCalls: [{
            id: "assessment", name: "submit_assessment", arguments: {
              criteria: context.step.successCriteria.map((criterion: { id: string }) => ({
                criterionId: criterion.id, satisfied: true,
                rationale: "The candidate accurately summarizes the frozen selected-service capability inventory.",
                evidenceRefs: ["candidateOutput", "runtimeCapabilitySnapshot"],
                contractCheck: { status: "valid", rationale: "A direct answer to the requested inventory is required." },
              })),
              skills: [], feedback: "", failedBoundary: null,
            },
          }] };
        }
        assert.deepEqual(request.tools, []);
        return { content: "The authorized archive service can find archive items.", finishReason: "stop" as const, toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", goal, { connectorConnectionIds: ["chosen-connection"] });
    assert.equal(run.status, "completed", run.output);
    const events = await runs.events("owner", run.id);
    assert.equal(events.find((event) => event.type === "skill.compliance.assessed")?.data.approved, true);
    assert.equal(events.some((event) => event.type === "tool.dispatched"), false);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a system-wide MCP inventory uses configured scope, not the selected-Run inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-configured-capability-reply-"));
  const database = new AppDatabase(":memory:");
  const selected = fixtureTool("selected_archive_find", "connector");
  const goal = "系统当前已接入的 MCP 工具有什么能力？";
  const configured = createRuntimeCapabilitySnapshotFromSources({
    scope: "runtime_configured",
    capturedAt: 1,
    sources: [{
      label: "Route guidance service",
      transport: "mcp",
      state: "loaded_for_runtime",
      capabilities: [{ id: "route.plan", category: "navigation", label: "Plan a route" }],
      operations: [{ label: "plan_route", description: "Plan a route at https://internal.example/route with secret=route-secret-value without invoking it." }],
      identityValues: ["private-route-key", "route-secret-alias"],
    }],
  });
  try {
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root,
      runToolProvider: { resolve: async () => [selected] },
      runtimeCapabilitySnapshotProvider: () => [configured],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) {
          const context = contextPayload(request.runtimeContext!.content);
          assert.deepEqual(context.runtimeCapabilityInventories.map((item: { scope: string }) => item.scope), ["run_authorized", "runtime_configured"]);
          return resolution("reply", goal);
        }
        if (request.phase === "assessment") {
          const match = request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n<\/assessment_context>/);
          assert.ok(match);
          const context = JSON.parse(match[1]!);
          assert.equal(context.runtimeCapabilitySnapshot.scope, "runtime_configured");
          assert.equal(context.runtimeCapabilityInventory.availability, "available");
          return { content: "", finishReason: "tool_calls" as const, toolCalls: [{
            id: "assessment", name: "submit_assessment", arguments: {
              criteria: context.step.successCriteria.map((criterion: { id: string }) => ({
                criterionId: criterion.id, satisfied: true, rationale: "The reply describes the frozen configured-service inventory.",
                evidenceRefs: ["candidateOutput", "runtimeCapabilitySnapshot"],
                contractCheck: { status: "valid", rationale: "The user requested this inventory." },
              })), skills: [], feedback: "", failedBoundary: null,
            },
          }] };
        }
        assert.deepEqual(request.tools, [], "configured metadata never grants reply-time tool authority");
        const content = request.runtimeContext!.content;
        assert.match(content, /Route guidance service/);
        assert.match(content, /runtime_configured/);
        assert.equal(content.includes("connector archive service"), false, "only the requested scope enters the reply context");
        assert.equal(content.includes("private-route-key"), false, "configuration identity is redacted");
        assert.equal(content.includes("https://internal.example/route"), false, "endpoints are redacted");
        assert.equal(content.includes("route-secret-value"), false, "credential-like values are redacted");
        return { content: "已配置并加载的 Route guidance service 可规划路线。", finishReason: "stop" as const, toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", goal, { connectorConnectionIds: ["chosen-connection"] });
    assert.equal(run.status, "completed", run.output);
    const events = await runs.events("owner", run.id);
    const snapshots = events.filter((event) => event.type === "runtime.capability_snapshot.created")
      .map((event) => (event.data.snapshot as { scope: string }).scope);
    assert.deepEqual(snapshots, ["run_authorized", "runtime_configured"]);
    assert.equal(events.some((event) => event.type === "tool.dispatched"), false);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("missing configured metadata cannot turn a selected-Run inventory into a system absence claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-missing-configured-capability-"));
  const database = new AppDatabase(":memory:");
  const goal = "列出所有已配置的 MCP 工具能力";
  try {
    const runs = new RunService({
      database, skills: new SkillService(database), workspaceRoot: root,
      assessorFactory: () => approvingTestAssessor(),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.runId.startsWith("conversation-turn:")) {
          const context = contextPayload(request.runtimeContext!.content);
          assert.deepEqual(context.runtimeCapabilityInventories.map((item: { scope: string }) => item.scope), ["run_authorized"]);
          return resolution("reply", goal);
        }
        assert.deepEqual(request.tools, []);
        assert.match(request.runtimeContext!.content, /"availability":"not_provided"/);
        return { content: "此运行时没有提供“已配置 MCP 目录”的元数据，因此不能据本次运行的授权清单判断系统是否配置了服务。", finishReason: "stop" as const, toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", goal);
    assert.equal(run.status, "completed", run.output);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

for (const goal of ["你有什么能力？", "你能帮我做些什么？", "Tell me how you can help."]) {
  test(`ordinary capability reply and assessment share the same descriptive evidence: ${goal}`, async () => {
    const database = new AppDatabase(":memory:");
    let executionCatalog: unknown;
    let assessed = false;
    try {
      const skills = new SkillService(database);
      const skill = await skills.create("owner", { name: "archive-notes", description: "Summarize archive notes", instructions: "PRIVATE WORKFLOW BODY" });
      const runs = new RunService({ database, skills,
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          if (request.runId.startsWith("conversation-turn:")) return resolution("reply", goal);
          if (request.phase === "assessment") {
            const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
            assessed = true;
            assert.deepEqual(context.runtimeSkillCatalog, executionCatalog);
            assert.deepEqual(context.skills, [], "descriptive registration must not imply Skill activation");
            assert.equal(context.runtimeCapabilitySnapshot.scope, "run_authorized");
            assert.deepEqual(context.runtimeCapabilitySnapshot.sources, []);
            assert.doesNotMatch(request.runtimeContext!.content, /PRIVATE WORKFLOW BODY/);
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "assess", name: "submit_assessment", arguments: {
              criteria: context.step.successCriteria.map((criterion: { id: string }) => ({ criterionId: criterion.id, satisfied: true,
                rationale: "The reply describes registered metadata without claiming authorization or invocation.",
                evidenceRefs: ["candidateOutput", "runtimeSkillCatalog", "runtimeCapabilitySnapshot"],
                contractCheck: { status: "valid", rationale: "Answer the capability question." } })),
              skills: [], concernResolutions: [], feedback: "", failedBoundary: null,
            } }] };
          }
          assert.deepEqual(request.tools, []);
          const prompt = `${request.systemPrompt}\n${request.runtimeContext!.content}`;
          const catalog = prompt.match(/<available_skill_catalog[^>]*>\n([^\n]+)\n/);
          assert.ok(catalog);
          executionCatalog = JSON.parse(catalog[1]!).skills;
          assert.deepEqual(executionCatalog, [{ id: skill.id, name: skill.name, description: skill.description }]);
          assert.match(prompt, /"scope":"run_authorized"/);
          return { content: "已注册 archive-notes Skill，可按其声明整理笔记。本次没有已授权的外部服务。", finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.executeConversation("owner", goal);
      assert.equal(run.status, "completed", run.output);
      assert.equal(assessed, true);
      assert.equal((await runs.events("owner", run.id)).some(event => event.type === "tool.dispatched"), false);
    } finally { database.close(); }
  });
}
