import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequiredCapabilityReference } from "../src/planning/contracts.ts";
import { parseRequiredCapabilityReferences, resolveCapabilityRequirements } from "../src/planning/capability-requirements.ts";
import { planningCapabilitiesFromSkills, planningCapabilitiesFromTools, requiredToolSourceIdsForConversationTurn } from "../src/planning/step-execution-binding.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import type { ModelAdapter, RuntimeEvent } from "../src/runtime/contracts.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { AppError } from "../src/shared/errors.ts";
import { loadMcpToolsFromConfigWithFactory } from "../src/mcp/mcp-loader.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import { admitPlan } from "../src/planning/admission.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";

test("required resources remain independent of catalog availability and cannot be invented by the resolver", () => {
  const requirements: RequiredCapabilityReference[] = [
    { kind: "skill", reference: "table-analysis" }, { kind: "tool_source", reference: "asset-service" },
  ];
  assert.deepEqual(parseRequiredCapabilityReferences(requirements, "Use table-analysis and asset-service."), requirements);
  assert.equal(parseRequiredCapabilityReferences(requirements, "Explain database modeling."), undefined);
  assert.deepEqual(resolveCapabilityRequirements(requirements, [], []).missing, requirements);
  assert.deepEqual(requiredToolSourceIdsForConversationTurn({
    input: "Use table-analysis and asset-service.", effectiveGoal: "Query records.", allowedTools: [],
    resolution: { requiredCapabilityReferences: requirements } as any, workset: undefined,
  }), ["asset-service"]);
});

test("only the authorized catalog resolves required Skill names, source aliases and tool names", () => {
  const result = resolveCapabilityRequirements([
    { kind: "skill", reference: "table-analysis" }, { kind: "tool_source", reference: "asset-service" },
    { kind: "tool", reference: "query_records" },
  ], [{ id: "private-skill-1", name: "table-analysis" }], [{
    name: "query_records", description: "Read records.", source: { id: "source-1", aliases: ["asset-service"], capabilities: [] },
  }]);
  assert.deepEqual(result, { missing: [], skillIds: ["private-skill-1"], toolSourceIds: ["source-1"] });
  assert.equal(resolveCapabilityRequirements([{ kind: "tool_source", reference: "shared" }], [], [
    { name: "first", description: "", source: { id: "one", aliases: ["shared"], capabilities: [] } },
    { name: "second", description: "", source: { id: "two", aliases: ["shared"], capabilities: [] } },
  ]).missing.length, 1);
});

test("an explicitly required Skill without optional role metadata reaches planning", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-explicit-skill-"));
  const database = new AppDatabase(":memory:");
  const goal = "用 data-analysis 分析2026 年 6 月份各区域的销售额分布";
  try {
    const skills = new SkillService(database);
    const requested = await skills.create("owner", { name: "data-analysis", description: "分析业务数据", instructions: "分析已授权数据源。" });
    assert.equal(requested.agentLoop, undefined);
    let reached = false;
    const model: ModelAdapter = { limits: TEST_MODEL_LIMITS, async complete() {
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
        mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
        taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
          deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
        evidenceStrategy: "source_grounded", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
        userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [{ kind: "skill", reference: "data-analysis" }],
      } }] };
    } };
    const runs = new RunService({ database, skills, workspaceRoot: workspace, modelFactory: () => model,
      plannerFactory: () => ({ plan: async (task) => {
        reached = true;
        assert.ok(task.availableSkills.some((skill) => skill.id === requested.id));
        throw new AppError("PLANNING_ERROR", "explicit skill reached planning", 422);
      } }),
    });
    await assert.rejects(runs.executeConversation("owner", goal), /explicit skill reached planning/);
    assert.equal(reached, true);
  } finally {
    await database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a named metadata-free Skill is bound and actually loaded by the execution leaf", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-explicit-skill-load-"));
  const database = new AppDatabase(":memory:");
  const goal = "用 data-analysis 分析2026 年 6 月份各区域的销售额分布";
  try {
    const skills = new SkillService(database);
    const skill = await skills.create("owner", { name: "data-analysis", description: "分析业务数据", instructions: "分析已授权数据源。" });
    let executionCalls = 0;
    const model: ModelAdapter = { limits: TEST_MODEL_LIMITS, async complete(invocation) {
      if (invocation.runId.startsWith("conversation-turn:")) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
        mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
        taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
          deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
        evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
        userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [{ kind: "skill", reference: "data-analysis" }],
      } }] };
      executionCalls++;
      if (executionCalls === 1) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "data-analysis" } }] };
      assert.ok(invocation.messages.some((message) => message.role === "tool" && message.name === "load_skill"));
      return { content: "已加载指定的分析技能。", finishReason: "stop", toolCalls: [] };
    } };
    const runs = new RunService({ database, skills, workspaceRoot: workspace, modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(), assessorFactory: () => approvingTestAssessor() });
    const run = await runs.executeConversation("owner", goal);
    const plan = (await runs.plan("owner", run.id)).plan;
    assert.ok(plan.selectedSkillIds.includes(skill.id));
    assert.ok(plan.steps.some((step) => step.skillIds.includes(skill.id)));
    const events = await runs.events("owner", run.id);
    assert.ok(events.some((event) => event.type === "tool.completed" && event.data.toolName === "load_skill"));
  } finally {
    await database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("whole-goal admission rejects a plan that substitutes another Skill for a user-required Skill", () => {
  const runId = "run-explicit-skill";
  const skill = { id: "discovered:data-analysis", name: "data-analysis", description: "分析业务数据" } as any;
  const other = { id: "discovered:hr-report-analysis", name: "hr-report-analysis", description: "分析人事数据" } as any;
  const goal = "用 data-analysis 分析销售额";
  const taskIntent = {
    schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
    deliverables: [{ targetId: "answer", purpose: "分析销售额", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
  } as const;
  const understanding = understandTask({ objective: goal, resolvedTaskIntent: taskIntent });
  const canonicalState = createCanonicalRunState({ runId, userInput: goal, understanding, now: 1,
    turnResolution: { taskIntent, requiredCapabilityReferences: [{ kind: "skill", reference: "data-analysis" }] } as any });
  const proposal = { goal, selectedSkillIds: [other.id], steps: [{ id: "answer", objective: "分析销售额", dependencies: [], role: "deliver" as const,
    skillIds: [other.id], targetIds: ["answer"], requiredCapabilities: ["conversation_delivery"],
    successCriteria: [{ id: "answer", description: "完成分析", source: "planner" as const }] }] };
  const base = { runId, canonicalState, availableSkills: [skill, other], availableToolNames: new Set(["load_skill"]) };
  assert.throws(() => admitPlan({ ...base, proposal }), /Plan does not bind user-required Skill discovered:data-analysis/);
  const plan = admitPlan({ ...base, proposal: { ...proposal, selectedSkillIds: [skill.id], steps: [{ ...proposal.steps[0]!, skillIds: [skill.id] }] } });
  assert.deepEqual(plan.selectedSkillIds, [skill.id]);
  assert.deepEqual(plan.steps[0]!.skillIds, [skill.id]);
});

test("an end-to-end primary analysis Skill can bind its own verified API source capability", () => {
  const runId = "run-primary-analysis-source";
  const goal = "用 data-analysis 分析销售额";
  const skill = { id: "discovered:data-analysis", name: "data-analysis", description: "分析业务数据",
    agentLoop: { roles: ["primary_builder", "source_provider"], artifactKinds: ["none"], sourceKinds: ["api"], qaKinds: [],
      executionProfiles: ["local_script"], producesEvidenceKinds: ["source_summary", "explicit_caveats"] } } as any;
  const taskIntent = { schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
    deliverables: [{ targetId: "answer", purpose: "分析销售额", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] } as const;
  const understanding = understandTask({ objective: goal, evidenceDemand: "source_grounded", resolvedTaskIntent: taskIntent });
  const canonicalState = createCanonicalRunState({ runId, userInput: goal, understanding, now: 1,
    turnResolution: { taskIntent, requiredCapabilityReferences: [{ kind: "skill", reference: "data-analysis" }] } as any });
  const tools = [{ name: "load_skill", description: "Load Skill" }, { name: "computer_run_command", description: "Run Skill script" }];
  const capability = `skill_source_provider.api.${skill.id}`;
  const plan = admitPlan({ runId, canonicalState, availableSkills: [skill], availableTools: tools,
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    availableCapabilities: [...planningCapabilitiesFromTools(tools), ...planningCapabilitiesFromSkills([skill])],
    proposal: { goal, selectedSkillIds: [skill.id], selectedSkillRoles: [{ skillId: skill.id, role: "primary_builder", reason: "Owns the analysis" }],
      steps: [{ id: "answer", objective: "查询并分析销售额", dependencies: [], role: "deliver", skillIds: [skill.id], targetIds: ["answer"],
        requiredCapabilities: [capability, "conversation_delivery"], evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" },
        successCriteria: [{ id: "answer", description: "完成有来源的分析", source: "planner" }] }] } });
  assert.ok(plan.steps[0]!.executionBinding.evidenceProducers.some((item) => item.evidenceKind === "source_summary" && item.skillId === skill.id));
  assert.ok(plan.steps[0]!.executionBinding.resolvedToolNames.includes("computer_run_command"));
});

test("source-native tool references require an unambiguous authorized identity and honor requested sources", () => {
  const tools = [
    { name: "mcp_primary_query_records", description: "", source: { id: "primary", toolName: "query_records", aliases: ["primary-data"], capabilities: [] } },
    { name: "mcp_secondary_query_records", description: "", source: { id: "secondary", toolName: "query_records", capabilities: [] } },
  ];
  const required = { kind: "tool", reference: "query_records" } as const;
  assert.deepEqual(resolveCapabilityRequirements([required], [], tools).missing, [required]);
  assert.deepEqual(resolveCapabilityRequirements([required], [], tools.slice(0, 1)), {
    missing: [], skillIds: [], toolSourceIds: ["primary"],
  });
  // Source requirements may follow the tool requirement in the resolver output.
  assert.deepEqual(resolveCapabilityRequirements([required, { kind: "tool_source", reference: "primary-data" }], [], tools), {
    missing: [], skillIds: [], toolSourceIds: ["primary"],
  });
  assert.deepEqual(resolveCapabilityRequirements([required, { kind: "tool_source", reference: "unavailable" }], [], []).missing, [
    required, { kind: "tool_source", reference: "unavailable" },
  ]);
  assert.deepEqual(resolveCapabilityRequirements([{ kind: "tool", reference: tools[1]!.name }], [], tools), {
    missing: [], skillIds: [], toolSourceIds: ["secondary"],
  });
  // A matching suffix alone is not source identity evidence.
  const withoutProvenance = [{ name: "mcp_primary_query_records", description: "", source: { id: "primary", capabilities: [] } }];
  assert.deepEqual(resolveCapabilityRequirements([required], [], withoutProvenance).missing, [required]);
  assert.deepEqual(resolveCapabilityRequirements([
    required, { kind: "tool_source", reference: "primary" },
  ], [], [{ ...tools[0]!, source: { id: "primary", toolName: "other_query", capabilities: [] } }, tools[1]!]).missing, [required]);
  assert.deepEqual(requiredToolSourceIdsForConversationTurn({
    input: "Use query_records.", effectiveGoal: "Query records.", allowedTools: tools.slice(0, 1),
    resolution: { requiredCapabilityReferences: [required] } as any, workset: undefined,
  }), ["primary"]);
  assert.deepEqual(requiredToolSourceIdsForConversationTurn({
    input: "Use query_records.", effectiveGoal: "Query records.", allowedTools: [],
    resolution: { requiredCapabilityReferences: [required] } as any, workset: undefined,
  }), []);
});

test("MCP discovery preserves native tool identity through RunService availability checks into planning", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-mcp-capability-"));
  const database = new AppDatabase(":memory:");
  let planned = false;
  let toolCalls = 0;
  const goal = "Use asset-service MCP tool query_records to query records.";
  try {
    const integration = await loadMcpToolsFromConfigWithFactory({
      servers: [{ key: "asset-service", transport: "http", url: "https://mcp.example.test", toolAllowlist: ["query_records"] }],
    }, { create: async () => ({
      request: async (method) => {
        if (method === "tools/list") return { tools: [
          { name: "query_records", inputSchema: { type: "object" } },
          { name: "blocked_query", inputSchema: { type: "object" } },
        ] };
        toolCalls += 1;
        throw new Error("No query should execute during capability checking");
      },
      close: async () => undefined,
    }) });
    assert.equal(integration.tools.length, 1);
    const model: ModelAdapter = { limits: TEST_MODEL_LIMITS, async complete() {
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
        mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
        taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
          deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
        evidenceStrategy: "source_grounded", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [], memoryAction: "none", memoryIntents: [],
        requiredCapabilityReferences: [{ kind: "tool_source", reference: "asset-service" }, { kind: "tool", reference: "query_records" }],
      } }] };
    } };
    const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: workspace,
      modelFactory: () => model, tools: integration.tools,
      plannerFactory: () => ({ plan: async (task) => {
        planned = true;
        assert.deepEqual(task.canonicalState.intent.requiredToolSourceIds, ["asset-service"]);
        const tool = task.availableTools?.find((tool) => tool.name === "mcp_asset_service_query_records");
        assert.equal(tool?.source?.toolName, "query_records");
        throw new AppError("PLANNING_ERROR", "Reached planning with native MCP identity", 422);
      } }),
    });
    await assert.rejects(runs.executeConversation("owner", goal), /Reached planning with native MCP identity/);
    assert.equal(planned, true);
    assert.equal(toolCalls, 0);
    // tools/list filtering controls availability even when the name is known.
    assert.deepEqual(resolveCapabilityRequirements([{ kind: "tool", reference: "blocked_query" }], [], integration.tools).missing,
      [{ kind: "tool", reference: "blocked_query" }]);
  } finally {
    await database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("missing mandatory capabilities persist a readable terminal outcome before Planner or execution", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-capability-exit-"));
  const database = new AppDatabase(":memory:");
  const requirements: RequiredCapabilityReference[] = [
    { kind: "skill", reference: "table-analysis" }, { kind: "tool_source", reference: "asset-service" },
  ];
  let modelCalls = 0;
  let planned = false;
  const goal = "请使用 table-analysis Skill 和 asset-service MCP 查询记录并说明结果。";
  try {
    const model: ModelAdapter = { limits: TEST_MODEL_LIMITS, async complete(invocation) {
      modelCalls += 1;
      const continuation = invocation.messages.at(-1)?.content === "继续";
      assert.equal(invocation.tools[0]?.name, "resolve_conversation_turn");
      assert.ok((invocation.tools[0]!.inputSchema.required as string[]).includes("requiredCapabilityReferences"));
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
        mode: "execute", relation: continuation ? "continue_prior" : "new_goal", inputMode: "none", effectiveGoal: continuation ? "继续此前任务" : goal,
        ...(continuation ? { targetGoalCandidateId: "goal_candidate_1" } : {}),
        taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
          deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
        evidenceStrategy: "source_grounded", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
        userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: continuation ? [] : requirements,
      } }] };
    } };
    const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => ({ plan: async () => { planned = true; throw new Error("Planner must not run"); } }),
    });
    const run = await runs.executeConversation("owner", goal);
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "CAPABILITY_UNAVAILABLE");
    assert.match(run.output ?? "", /table-analysis/);
    assert.match(run.output ?? "", /asset-service/);
    assert.match(run.output ?? "", /任务未执行/);
    assert.equal(planned, false);
    assert.equal(modelCalls, 1);
    const events = await runs.events("owner", run.id);
    assert.equal(events.filter((event) => event.type === "run.failed").length, 1);
    assert.equal(events.some((event) => ["plan.admitted", "tool.planned", "step.started", "failure_report.started"].includes(event.type)), false);
    const state = await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id = ?").get(run.id) as { state_json: string };
    const canonical = JSON.parse(state.state_json);
    assert.deepEqual(canonical.intent.turnResolution.requiredCapabilityReferences, requirements);
    assert.deepEqual(canonical.intent.requiredToolSourceIds, ["asset-service"]);
    assert.equal(canonical.terminal.reasonCode, "CAPABILITY_UNAVAILABLE");
    const outcome = await database.prepare("SELECT status, reason_code, result_ref, delivery_receipt_json FROM run_outcomes WHERE run_id = ?").get(run.id) as any;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason_code, "CAPABILITY_UNAVAILABLE");
    assert.equal(outcome.result_ref, null);
    assert.equal(outcome.delivery_receipt_json, null);

    const continued = await runs.executeConversation("owner", "继续", { conversationId: run.conversationId });
    assert.equal(continued.errorCode, "CAPABILITY_UNAVAILABLE");
    assert.equal(modelCalls, 2);
    assert.equal(planned, false);
    const continuedState = await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id = ?").get(continued.id) as { state_json: string };
    assert.deepEqual(JSON.parse(continuedState.state_json).intent.turnResolution.requiredCapabilityReferences, requirements);
  } finally {
    await database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("available providers and reuse of a bound Result reach planning; refreshing an unavailable provider stops", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentloop-capability-reuse-"));
  const database = new AppDatabase(":memory:");
  const plannedGoals: string[] = [];
  try {
    const model: ModelAdapter = { limits: TEST_MODEL_LIMITS, async complete(invocation) {
      if (invocation.tools[0]?.name !== "resolve_conversation_turn") {
        return { content: "Reusable evidence.", finishReason: "stop", toolCalls: [] };
      }
      const goal = invocation.messages.at(-1)!.content;
      const reuse = goal.startsWith("Reuse");
      const source = goal.includes("available-service") ? "available-service" : "missing-service";
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
        mode: "execute", relation: reuse ? "refine_prior" : "new_goal", inputMode: reuse ? "prior_result" : "none",
        ...(reuse ? { targetGoalCandidateId: "goal_candidate_1", resultCandidateId: "result_candidate_1" } : {}),
        effectiveGoal: goal,
        taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: true,
          deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
        evidenceStrategy: reuse ? "none" : "source_grounded", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
        userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [{ kind: "tool_source", reference: source }],
      } }] };
    } };
    const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: workspace,
      modelFactory: () => model, assessorFactory: () => approvingTestAssessor(),
      tools: [{ name: "available_query", description: "Query records.",
        source: { id: "available-source", aliases: ["available-service"], capabilities: [] },
        inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
        parse: (input) => input, execute: async () => { throw new Error("No tool should execute in this test"); } }],
      plannerFactory: () => ({ plan: async (task) => {
        const goal = task.canonicalState.intent.userInput;
        if (goal === "seed") return singleStepTestPlanner().plan(task);
        plannedGoals.push(goal);
        if (goal.startsWith("Reuse")) assert.deepEqual(task.canonicalState.intent.requiredToolSourceIds, []);
        else assert.deepEqual(task.canonicalState.intent.requiredToolSourceIds, ["available-source"]);
        throw new AppError("PLANNING_ERROR", "Reached planning", 422);
      } }),
    });
    const seed = await runs.execute("owner", "seed");
    assert.equal(seed.status, "completed");
    const reuseGoal = "Reuse the prior Result from missing-service without refreshing data.";
    await assert.rejects(runs.executeConversation("owner", reuseGoal, { conversationId: seed.conversationId }), /Reached planning/);
    const availableGoal = "Use available-service to query records.";
    await assert.rejects(runs.executeConversation("owner", availableGoal), /Reached planning/);
    const missing = await runs.executeConversation("owner", "Use missing-service to refresh records.");
    assert.equal(missing.errorCode, "CAPABILITY_UNAVAILABLE");
    assert.deepEqual(plannedGoals, [reuseGoal, availableGoal]);
  } finally {
    await database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an Assessment with no repair path ends the loop without granting retry grace", async () => {
  const events: RuntimeEvent[] = [];
  let modelCalls = 0;
  let assessments = 0;
  const grant = createCapabilityGrant({ actorUserId: "owner", runId: "no-repair", depth: 0,
    workspaceRoot: "/workspace", allowedToolNames: [], allowedSkillIds: [] });
  await assert.rejects(runAgentLoop({ runId: grant.runId, systemPrompt: "Answer from evidence.", input: "Query records.",
    model: { limits: TEST_MODEL_LIMITS, async complete() {
      modelCalls += 1;
      return { content: "The query identity lacks access; no count was obtained.", finishReason: "stop", toolCalls: [] };
    } },
    tools: new ToolRegistry([]), grant, maxSteps: 20, candidateRepairGraceSteps: 4, deferFailureReport: true,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async () => {
      assessments += 1;
      return { approved: false, feedback: "No available path can obtain the required data.",
        failedBoundary: { stepId: "acquire", missingEvidenceKinds: ["record_counts"], violatedSkillRequirements: [],
          reusableEvidenceRefs: [], suggestedRepairShape: "fail" } };
    },
  }), (error: unknown) => error instanceof AppError && error.code === "STEP_NOT_COMPLETED" && error.details?.repairExhausted === true);
  assert.equal(modelCalls, 1);
  assert.equal(assessments, 1);
  assert.equal(events.some((event) => event.type === "loop.candidate_repair_grace_granted"), false);
  assert.equal(events.filter((event) => event.type === "candidate.repair_stopped").length, 1);
});
