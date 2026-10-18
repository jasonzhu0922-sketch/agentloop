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
  const facts = [
    { id: "chairman", description: "示例公司现任董事长的姓名", evidenceKinds: ["source_summary"] },
    { id: "president", description: "示例公司现任总裁的姓名，不能以登记总经理代替", evidenceKinds: ["source_summary"] },
  ];
  const canonicalState = createCanonicalRunState({ runId, userInput: objective, now: 1,
    understanding: understandTask({ objective, toolNames: ["webfetch"], resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
      deliverables: [{ targetId: "answer", purpose: objective, expectedArtifactCount: 1,
        action: "none", kind: "none", surface: "conversation" }],
    } }),
  });
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
    assert.deepEqual(step.requiredFacts, facts);
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
            satisfied: criterion.id !== "required_fact:president", rationale: "登记总经理不能证明现任总裁", evidenceRefs: [] })),
          skills: [], feedback: "补查总裁的现任任免信息，保留已有董事长证据。",
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
