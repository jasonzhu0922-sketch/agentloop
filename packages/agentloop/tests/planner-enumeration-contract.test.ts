import assert from "node:assert/strict";
import test from "node:test";
import { ModelPlanner } from "../src/planning/planner.ts";
import type { ModelAdapter, ModelResponse } from "../src/runtime/contracts.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { admitPlan } from "../src/planning/admission.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { ModelStepAssessor } from "../src/planning/assessor.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { buildStepRuntimeContextSnapshot } from "../src/runtime/execution-context-policy.ts";
import { buildTaskProfile } from "../src/runtime/dynamic-prompt.ts";

function factRepairFixture() {
  const runId = "run-fact-contract-repair";
  const objective = "示例公司的现任董事长是谁？";
  const tools = [{ name: "webfetch", description: "Read a current public source" }];
  const canonicalState = createCanonicalRunState({ runId, userInput: objective, now: 1,
    understanding: understandTask({ objective, toolNames: ["webfetch"], resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
      deliverables: [{ targetId: "answer", purpose: objective, expectedArtifactCount: 1,
        action: "none", kind: "none", surface: "conversation" }],
    } }),
  });
  const fact = { id: "current-chairman", description: "示例公司现任董事长的姓名", evidenceKinds: ["source_summary"],
    basis: { kind: "user_requirement", intentId: canonicalState.intent.id, targetIds: ["answer"],
      rationale: "The user explicitly requests the current holder of this role." } };
  return {
    fact,
    task: { runId, canonicalState, availableSkills: [], availableTools: tools, availableToolNames: ["webfetch"] },
    response(requiredFact: Record<string, unknown>): ModelResponse {
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "fact-plan", name: "submit_outcome_plan", arguments: {
        schema: "agentloop.outcomePlan/v2", goal: objective, shape: "single_leaf", selectedSkillRoles: [],
        leaves: [{ id: "answer", objective, requiredFacts: [requiredFact], dependsOn: [], role: "deliver", skillIds: [],
          requiredCapabilities: ["web_research", "conversation_delivery"], sourceConstraint: null,
          evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" }, targetIds: ["answer"] }],
      } }] };
    },
  };
}

test("a forbidden requirement followed by missing fact fields gets bounded repairs without losing the requested fact", async () => {
  const fixture = factRepairFixture();
  let calls = 0;
  const failures: string[] = [];
  const proposal = await new ModelPlanner({
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(request) {
      calls += 1;
      if (calls === 1) return fixture.response({ ...fixture.fact,
        basis: { ...fixture.fact.basis, requirement: "Resolver-authored constraint absent from the user input" } });
      if (calls === 2) {
        assert.match(request.runtimeContext!.content, /requirement is Runtime-owned and must not be submitted/);
        // The live failure repaired basis while omitting both sibling fields.
        return fixture.response({ description: fixture.fact.description, basis: fixture.fact.basis });
      }
      assert.match(request.runtimeContext!.content, /argument schema before Runtime Admission/);
      assert.match(request.runtimeContext!.content, /missing required fields: id, evidenceKinds/);
      assert.match(request.runtimeContext!.content, /Do not remove sibling fields when repairing basis/);
      return fixture.response(fixture.fact);
    },
  }).plan(fixture.task, undefined, async (event) => {
    if (event.type === "planning.contract_failed") failures.push(String(event.data.validationError));
  });
  assert.equal(calls, 3);
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /requirement is Runtime-owned and must not be submitted/);
  assert.equal(failures[1], "leaves[0].requiredFacts[0] is missing required fields: id, evidenceKinds");
  assert.deepEqual(proposal.steps[0]!.requiredFacts, [{ ...fixture.fact,
    basis: { ...fixture.fact.basis, requirement: fixture.task.canonicalState.intent.userInput } }]);
  assert.equal(proposal.steps[0]!.successCriteria.find((criterion) => criterion.id === "required_fact:current-chairman")?.blocking, true);
});

test("invalid fact arguments stay rejected and argument repair cannot loop or bypass the turn limit", async (t) => {
  const fixture = factRepairFixture();
  for (const [name, fields] of [
    ["missing fields", { description: fixture.fact.description, basis: fixture.fact.basis }],
    ["null evidence", { ...fixture.fact, evidenceKinds: null }],
    ["scalar evidence", { ...fixture.fact, evidenceKinds: "source_summary" }],
    ["empty evidence", { ...fixture.fact, evidenceKinds: [] }],
    ["oversized evidence", { ...fixture.fact, evidenceKinds: Array(21).fill("source_summary") }],
    ["unknown evidence", { ...fixture.fact, evidenceKinds: ["invented_receipt"] }],
  ] as const) {
    await t.test(name, async () => {
      let calls = 0;
      const planner = new ModelPlanner({ limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
        async complete() { calls += 1; return fixture.response(fields); } });
      await assert.rejects(planner.plan(fixture.task), /requiredFacts\[0\]/);
      assert.equal(calls, 2);
    });
  }
  let calls = 0;
  const planner = new ModelPlanner({ limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete() { calls += 1; return fixture.response({ ...fixture.fact, evidenceKinds: null }); } },
  { maxPlanningTurns: 1 });
  await assert.rejects(planner.plan(fixture.task), /evidenceKinds must be an array/);
  assert.equal(calls, 1);
});

test("an artifact edit with no factual lookup keeps its exact output requirements in goal acceptance", async () => {
  const runId = "run-artifact-edit-goal";
  const objective = "在 daz 这个 sheet 顶部增加表头行，一共三列：姓名 工号 年龄";
  const tools = [{ name: "computer_write_file", description: "Write a workspace file" }];
  const canonicalState = createCanonicalRunState({ runId, userInput: objective, now: 1,
    understanding: understandTask({ objective, toolNames: ["computer_write_file"], resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "transform_artifact", requiresExecution: true,
      deliverables: [{ targetId: "updated-workbook", purpose: objective, expectedArtifactCount: 1,
        action: "modify", kind: "spreadsheet", format: "xlsx", surface: "workspace_artifact" }],
    } }),
  });
  const proposal = await new ModelPlanner({
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(request) {
      assert.match(JSON.stringify(request.tools[0]!.inputSchema), /Use \[\] for artifact edits that request no factual lookup/);
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "edit-workbook", name: "submit_outcome_plan", arguments: {
        schema: "agentloop.outcomePlan/v2", goal: objective, shape: "single_leaf", selectedSkillRoles: [],
        leaves: [{ id: "edit", objective, requiredFacts: [], dependsOn: [], role: "produce", skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"], sourceConstraint: null,
          evidenceContract: { requiredKinds: ["artifact_path", "artifact_non_empty"], caveatPolicy: "none" },
          targetIds: ["updated-workbook"] }],
      } }] };
    },
  }).plan({ runId, canonicalState, availableSkills: [], availableTools: tools, availableToolNames: ["computer_write_file"] });
  const step = proposal.steps[0]!;
  assert.deepEqual(step.requiredFacts, []);
  const goal = step.successCriteria.find((criterion) => criterion.id === "requested_goal");
  assert.ok(goal?.blocking);
  assert.ok(goal.description.includes(objective));
  assert.equal(goal.verification, "model_judged");
  assert.equal(goal.basis?.requirement, objective);
  assert.deepEqual(goal.basis?.targetIds, ["updated-workbook"]);
});

test("Planner makes an enumerated user request reject summaries and representative samples", async () => {
  const runId = "run-enumeration-contract";
  const objective = "宝武共享的公司领导有哪些人？请列出姓名和职务。";
  const tools = [
    { name: "websearch", description: "Search public sources." },
    { name: "webfetch", description: "Read a public source." },
  ];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    async complete(): Promise<ModelResponse> {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "enumerated-answer",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: objective,
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: [{
              id: "leadership-answer",
              objective: "Answer the company leadership question.",
              dependsOn: [],
              role: "deliver",
              skillIds: [],
              requiredCapabilities: ["web_research", "conversation_delivery"],
              sourceConstraint: null,
              evidenceContract: {
                requiredKinds: ["source_summary", "source_urls", "explicit_caveats"],
                caveatPolicy: "mark_unverified_facts",
              },
              targetIds: [],
            }],
          },
        }],
      };
    },
  };

  const proposal = await new ModelPlanner(model).plan({
    runId,
    canonicalState: createCanonicalRunState({
      runId,
      userInput: objective,
      understanding: understandTask({ objective, toolNames: tools.map((tool) => tool.name) }),
      now: 1,
    }),
    availableSkills: [],
    availableToolNames: tools.map((tool) => tool.name),
    availableTools: tools,
  });

  const criterion = proposal.steps[0]?.successCriteria.find((entry) => entry.id === "requested_enumeration");
  assert.ok(criterion);
  assert.match(criterion.description, /representative examples/i);
});

test("a narrowed Plan objective cannot replace the original requested facts in conversation acceptance", async () => {
  const runId = "run-original-goal-preservation";
  const objective = "示例公司的董事长是谁，总裁是谁？";
  const tools = [{ name: "webfetch", description: "Read a current public source" }];
  const proposal = await new ModelPlanner({
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    complete: async () => ({ content: "", finishReason: "tool_calls", toolCalls: [{
      id: "narrowed-source-plan", name: "submit_outcome_plan", arguments: {
        schema: "agentloop.outcomePlan/v2", goal: "列出登记人员和总经理", shape: "single_leaf", selectedSkillRoles: [],
        leaves: [{ id: "answer", objective: "列出登记董事长和总经理，加未核实说明", dependsOn: [], role: "deliver",
          skillIds: [], requiredCapabilities: ["web_research", "conversation_delivery"], sourceConstraint: null,
          evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" },
          targetIds: ["requested-answer"] }],
      },
    }] }),
  }).plan({
    runId, availableSkills: [], availableTools: tools, availableToolNames: tools.map((tool) => tool.name),
    canonicalState: createCanonicalRunState({ runId, userInput: objective, now: 1,
      understanding: understandTask({ objective: "查询登记董事长和总经理", toolNames: tools.map((tool) => tool.name),
        resolvedTaskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
          deliverables: [{ targetId: "requested-answer", purpose: "查询登记人员", expectedArtifactCount: 1,
            action: "none", kind: "none", surface: "conversation" }] } }),
    }),
  });
  const criterion = proposal.steps[0]?.successCriteria.find((entry) => entry.id === "requested_goal");
  assert.ok(criterion);
  assert.equal(criterion.source, "task");
  assert.equal(criterion.blocking, true);
  assert.ok(criterion.description.includes(objective));
});

test("requested facts survive model planning, persisted admission, execution and assessment independently of source fields", async () => {
  const runId = "requested-fact-chain";
  const objective = "示例公司的现任董事长是谁，总裁是谁？";
  const tools = [{ name: "webfetch", description: "Read a current public source" }];
  const canonicalState = createCanonicalRunState({ runId, userInput: objective, now: 1,
    understanding: understandTask({ objective, toolNames: ["webfetch"], resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
      deliverables: [{ targetId: "answer", purpose: objective, expectedArtifactCount: 1,
        action: "none", kind: "none", surface: "conversation" }],
    } }),
  });
  const facts = [
    { id: "chairman", description: "示例公司现任董事长的姓名", evidenceKinds: ["source_summary"] },
    { id: "president", description: "示例公司现任总裁的姓名，不能以登记总经理代替", evidenceKinds: ["source_summary"] },
  ].map((fact) => ({ ...fact, basis: {
    kind: "user_requirement" as const, intentId: canonicalState.intent.id, targetIds: ["answer"],
    rationale: "The user explicitly requests the current holder of this role.",
  } }));
  const proposal = await new ModelPlanner({
    limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
    complete: async (request) => {
      const schema = JSON.stringify(request.tools[0]?.inputSchema);
      assert.match(schema, /requiredFacts/);
      assert.match(request.systemPrompt, /before selecting source capabilities/);
      return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "fact-plan", name: "submit_outcome_plan", arguments: {
        schema: "agentloop.outcomePlan/v2", goal: objective, shape: "single_leaf", selectedSkillRoles: [],
        leaves: [{ id: "answer", objective, requiredFacts: facts, dependsOn: [], role: "deliver", skillIds: [],
          requiredCapabilities: ["web_research", "conversation_delivery"], sourceConstraint: null,
          evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" }, targetIds: ["answer"] }],
      } }] };
    },
  }).plan({ runId, canonicalState, availableSkills: [], availableTools: tools, availableToolNames: ["webfetch"] });
  const database = new AppDatabase(":memory:");
  try {
    await database.prepare(`INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, 'owner', NULL, 0, 0, 'running', ?, 1)`).run(runId, objective);
    const repository = new PlanRepository(database);
    await repository.create(admitPlan({ runId, canonicalState, proposal, availableSkills: [],
      availableToolNames: new Set(["webfetch"]), availableTools: tools }));
    const plan = await repository.getByRun(runId);
    assert.ok(plan);
    const step = plan.steps[0]!;
    assert.deepEqual(step.requiredFacts, facts.map((fact) => ({ ...fact, basis: { ...fact.basis, requirement: objective } })));
    for (const fact of facts) {
      const criterion = step.successCriteria.find((item) => item.id === `required_fact:${fact.id}`);
      assert.ok(criterion?.blocking);
      assert.equal(criterion.verification, "model_judged");
      assert.ok(criterion.description.includes(fact.description));
    }
    const context = buildStepRuntimeContextSnapshot({ step, plan, skills: [], workspaceRoot: "/workspace",
      taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", sourceNeed: "source_grounded" }),
      operationProfile: { id: "web_research" }, requiresFileOutput: false });
    assert.match(context.content, /"requiredFacts":/);
    for (const fact of facts) assert.ok(context.content.includes(fact.description));
    let assessed = false;
    const assessment = await new ModelStepAssessor({
      limits: { contextWindowTokens: 40_000, maxOutputTokens: 2_048 },
      complete: async (request) => {
        for (const fact of facts) assert.ok(request.runtimeContext?.content.includes(fact.description));
        assessed = true;
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "assess", name: "submit_assessment", arguments: {
          criteria: step.successCriteria.map((criterion) => ({ criterionId: criterion.id,
            satisfied: criterion.id !== "required_fact:president", rationale: "登记总经理不能证明现任总裁", evidenceRefs: [],
            contractCheck: { status: "valid", rationale: "用户要求区分董事长与现任总裁。" } })),
          skills: [], feedback: "补查总裁的现任任免信息，保留已有董事长证据。", failedBoundary: null,
        } }] };
      },
    }).assess({ runId, planId: plan.id, canonicalState, step, skills: [], attempt: 1,
      evidence: { candidateOutput: "董事长张甲；登记总经理李乙，总裁尚未核实。", modelSteps: 1, toolCalls: [] } });
    assert.equal(assessed, true);
    assert.equal(assessment.approved, false);
  } finally {
    await database.close();
  }
});
