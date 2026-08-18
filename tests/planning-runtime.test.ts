import assert from "node:assert/strict";
import test from "node:test";
import { AgentService } from "../src/agents/agent-service.ts";
import { AuthService } from "../src/auth/auth-service.ts";
import { admitPlan } from "../src/planning/admission.ts";
import type { PlanProposal, Planner } from "../src/planning/contracts.ts";
import { ModelStepAssessor, RuleBasedStepAssessor } from "../src/planning/assessor.ts";
import { ModelPlanner } from "../src/planning/planner.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import type { RuntimeTool } from "../src/runtime/tool-registry.ts";
import { SkillService, type PrivateSkill } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("ModelPlanner fails closed when the model returns prose instead of submit_plan", async () => {
  const planner = new ModelPlanner(new StaticModel({ content: "Here is a markdown plan", toolCalls: [], finishReason: "stop" }));
  await assert.rejects(
    () => planner.plan({
      runId: "run-1",
      input: "do work",
      agent: agentFixture(),
      availableSkills: [],
      availableToolNames: [],
    }),
    (error: unknown) => {
      assert.equal(hasCode(error, "PLANNING_ERROR"), true);
      assert.deepEqual((error as { details?: unknown }).details, {
        planningTurn: 3,
        finishReason: "stop",
        toolCallCount: 0,
        toolCallNames: [],
        responseContentLength: 23,
        responseContentPreview: "Here is a markdown plan",
      });
      return true;
    },
  );
});

test("ModelPlanner canonicalizes duplicate names in the set-valued Tool capability field", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "plan",
      name: "submit_plan",
      arguments: {
        goal: "inspect then build",
        selectedSkillIds: [],
        steps: [{
          id: "build",
          objective: "build output",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["computer_read_file", "computer_write_file", "computer_write_file"],
          successCriteria: [{ id: "built", description: "output exists" }],
        }],
      },
    }],
  }));
  const plan = await planner.plan({
    runId: "run-1",
    input: "build",
    agent: agentFixture(),
    availableSkills: [],
    availableToolNames: ["computer_read_file", "computer_write_file"],
  });
  assert.deepEqual(plan.steps[0].requiredToolNames, ["computer_read_file", "computer_write_file"]);
});

test("ModelPlanner repairs an invalid structured Plan without weakening the schema", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "invalid-plan",
            name: "submit_plan",
            arguments: {
              goal: "build",
              selectedSkillIds: [],
              steps: [{
                id: "build",
                objective: { invalid: true },
                dependencies: [],
                skillIds: [],
                requiredToolNames: [],
                successCriteria: [{ id: "built", description: "output exists" }],
              }],
            },
          }],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /objective must be a string/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "repaired-plan",
          name: "submit_plan",
          arguments: {
            goal: "build",
            selectedSkillIds: [],
            steps: [{
              id: "build",
              objective: "build output",
              dependencies: [],
              skillIds: [],
              requiredToolNames: [],
              successCriteria: [{ id: "built", description: "output exists" }],
            }],
          },
        }],
      };
    },
  };
  const plan = await new ModelPlanner(model).plan({
    runId: "run-1",
    input: "build",
    agent: agentFixture(),
    availableSkills: [],
    availableToolNames: [],
  });
  assert.equal(calls, 2);
  assert.equal(plan.steps[0].objective, "build output");
});

test("ModelPlanner loads the exact Skill body before authoring and repairing a bound Plan", async () => {
  const skill = skillFixture({ instructions: "EXACT-PLANNING-INSTRUCTIONS" });
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill", "submit_plan"]);
        assert.equal(request.toolChoice, "required");
        assert.match(request.runtimeContext?.content ?? "", /<available_skills>/);
        assert.match(request.systemPrompt, /cannot retroactively make the current step admissible/);
        assert.doesNotMatch(request.systemPrompt, /EXACT-PLANNING-INSTRUCTIONS/);
        assert.doesNotMatch(request.messages[0].content, /EXACT-PLANNING-INSTRUCTIONS/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "load", name: "load_skill", arguments: { name: skill.name } }],
        };
      }
      const loaded = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
      assert.match(loaded?.content ?? "", /EXACT-PLANNING-INSTRUCTIONS/);
      if (calls === 3) {
        assert.match(request.runtimeContext?.content ?? "", /not bound to any Plan step/);
      }
      const unbound = calls === 2;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `plan-${calls}`,
          name: "submit_plan",
          arguments: {
            goal: "materialize and verify",
            selectedSkillIds: [skill.id],
            steps: [{
              id: "materialize-and-verify",
              objective: "materialize and verify",
              dependencies: [],
              skillIds: unbound ? [] : [skill.id],
              requiredToolNames: [],
              successCriteria: [{ id: "verified", description: "artifact exists and is valid" }],
            }],
          },
        }],
      };
    },
  };
  const plan = await new ModelPlanner(model).plan({
    runId: "run-1",
    input: "materialize and verify",
    agent: agentFixture(),
    availableSkills: [skill],
    availableToolNames: ["load_skill"],
  });
  assert.equal(calls, 3);
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0].skillIds, [skill.id]);
});

test("ModelPlanner keeps optional refinement out of the terminal Plan scope", async () => {
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      assert.match(request.systemPrompt, /Keep the Plan scoped to the user's requested deliverable/);
      assert.match(request.systemPrompt, /Do not add optional polish, critique, or follow-up work/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_plan",
          arguments: {
            goal: "Create a steel company homepage",
            selectedSkillIds: [],
            steps: [{
              id: "build-and-verify-homepage",
              objective: "Create and verify the requested homepage",
              dependencies: [],
              skillIds: [],
              requiredToolNames: [],
              successCriteria: [{ id: "homepage-ready", description: "The requested homepage is present and verified" }],
            }],
          },
        }],
      };
    },
  };
  const plan = await new ModelPlanner(model).plan({
    runId: "run-1",
    input: "Create a steel company homepage",
    agent: agentFixture(),
    availableSkills: [],
    availableToolNames: [],
  });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, "build-and-verify-homepage");
});

test("legacy interrupted Runs enter recovery review instead of being terminally failed on restart", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("interrupted@example.com", "interrupted secure password");
    const agent = agents.create(owner.user.id, {
      name: "interrupted-agent",
      systemPrompt: "Complete the task.",
      providerKey: "scenario",
    });
    const runId = "interrupted-run";
    database.raw.prepare(`
      INSERT INTO runs(
        id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, agent.id, "create an artifact", Date.now());
    const plans = new PlanRepository(database);
    const plan = plans.create(admitPlan({
      runId,
      proposal: {
        goal: "create an artifact",
        selectedSkillIds: [],
        steps: [step("create-artifact")],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    plans.startStep(plan.id, "create-artifact");
    const runs = new RunService({ database, skills, agents, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }) });

    assert.equal(runs.reconcileInterruptedRuns(), 1);
    assert.equal(runs.get(owner.user.id, runId).status, "running");
    assert.equal(plans.get(plan.id).status, "running");
    assert.equal(plans.get(plan.id).steps[0].status, "running");
    const actions = runs.actionsForRun(owner.user.id, runId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, "recovery_review");
    assert.equal(actions[0].state, "recovery_required");
    assert.equal(actions[0].metadata.reason, "legacy_state_incomplete");
    assert.equal(runs.events(owner.user.id, runId).at(-1)?.type, "action.recovery_required");
    assert.equal(runs.reconcileInterruptedRuns(), 0);
  } finally {
    database.close();
  }
});

test("Admission rejects cycles, unknown dependencies, unbound Skills, and missing Skill activation", () => {
  const skill = skillFixture();
  const base: PlanProposal = {
    goal: "goal",
    selectedSkillIds: [],
    steps: [step("a")],
  };
  assert.throws(
    () => admitPlan({
      runId: "run", proposal: { ...base, steps: [{ ...step("a"), dependencies: ["missing"] }] },
      availableSkills: [], availableToolNames: new Set(),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED"),
  );
  assert.throws(
    () => admitPlan({
      runId: "run",
      proposal: { ...base, steps: [{ ...step("a"), dependencies: ["b"] }, { ...step("b"), dependencies: ["a"] }] },
      availableSkills: [], availableToolNames: new Set(),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED"),
  );
  assert.throws(
    () => admitPlan({
      runId: "run", proposal: { ...base, selectedSkillIds: [skill.id] },
      availableSkills: [skill], availableToolNames: new Set(["load_skill"]),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED"),
  );
  assert.throws(
    () => admitPlan({
      runId: "run",
      proposal: { ...base, selectedSkillIds: [skill.id], steps: [{ ...step("a"), skillIds: [skill.id] }] },
      availableSkills: [skill], availableToolNames: new Set(),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED"),
  );
});

test("Admission adds only the generic Skill activation Tool to a Skill-bound Step", async () => {
  const skill = skillFixture();
  const plan = admitPlan({
    runId: "run",
    proposal: {
      goal: "verify artifact",
      selectedSkillIds: [skill.id],
      steps: [{ ...step("qa"), skillIds: [skill.id], requiredToolNames: ["computer_read_file"] }],
    },
    availableSkills: [skill],
    availableToolNames: new Set(["computer_read_file", "load_skill"]),
  });
  assert.deepEqual(plan.steps[0].requiredToolNames, ["computer_read_file", "load_skill"]);
  assert.deepEqual(plan.steps[0].successCriteria, [{
    id: "qa-done",
    description: "qa is done",
    source: "planner",
  }]);

  const assessor = new ModelStepAssessor(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "assessment",
      name: "submit_assessment",
      arguments: {
        criteria: [
          { criterionId: "qa-done", satisfied: true, rationale: "QA passed", evidenceRefs: ["read"] },
        ],
        skills: [{
          skillId: skill.id,
          followed: true,
          rationale: "The QA-only step followed the bound Skill without rewriting the artifact",
          evidenceRefs: ["read"],
        }],
        feedback: "",
      },
    }],
  }));
  const assessment = await assessor.assess({
    runId: "run",
    planId: plan.id,
    step: plan.steps[0],
    skills: [skill],
    evidence: {
      candidateOutput: "Artifact QA passed",
      toolCalls: [{ toolCallId: "read", toolName: "computer_read_file", isError: false, result: "valid" }],
      modelSteps: 1,
    },
    attempt: 1,
  });
  assert.equal(assessment.approved, true);
  assert.equal(assessment.skills[0].followed, true);
});

test("ModelStepAssessor repairs invalid structured arguments without approving by default", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "bad", name: "submit_assessment", arguments: "not-an-object" }],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /must be a JSON object/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "repaired",
          name: "submit_assessment",
          arguments: {
            criteria: [{
              criterionId: "done",
              satisfied: true,
              rationale: "Canonical evidence proves completion",
              evidenceRefs: ["candidateOutput"],
            }],
            skills: [],
            feedback: "",
          },
        }],
      };
    },
  };
  const assessment = await new ModelStepAssessor(model).assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("assess"),
      position: 0,
      status: "running",
      successCriteria: [{ id: "done", description: "Work is complete", source: "planner" }],
    },
    skills: [],
    evidence: { candidateOutput: "complete", toolCalls: [], modelSteps: 1 },
    attempt: 1,
  });
  assert.equal(calls, 2);
  assert.equal(assessment.approved, true);
});

test("Plan-bound Skill instructions are loaded on demand and compliance is persisted", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("planning@example.com", "planning secure password");
    const skill = skills.create(owner.user.id, {
      name: "strict-private",
      description: "Private procedure",
      instructions: "MANDATORY-PRIVATE-INSTRUCTION",
    });
    const agent = agents.create(owner.user.id, {
      name: "worker",
      systemPrompt: "Do the admitted step.",
      providerKey: "scenario",
      skillIds: [skill.id],
    });
    const model = new InspectSkillModel();
    const runs = new RunService({
      database,
      skills,
      agents,
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingSkillAssessor(),
    });
    const run = await runs.execute(owner.user.id, agent.id, "apply private procedure");
    assert.equal(run.status, "completed");
    assert.equal(model.sawInstruction, true);
    const detail = runs.plan(owner.user.id, run.id);
    assert.deepEqual(detail.plan.steps[0].skillIds, [skill.id]);
    assert.equal(detail.assessments.at(-1)?.skills[0].followed, true);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "skill.activation.required").length, 1);
    assert.equal(events.filter((event) => event.type === "skill.activated").length, 1);
  } finally {
    database.close();
  }
});

test("Tools are materialized from each Plan step rather than the whole Agent profile", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("tools@example.com", "tools secure password");
    const agent = agents.create(owner.user.id, {
      name: "two-step",
      systemPrompt: "Follow the two-step plan.",
      providerKey: "scenario",
      toolNames: ["computer_read_file"],
    });
    const model = new StepToolVisibilityModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "two steps",
        selectedSkillIds: [],
        steps: [
          step("first"),
          { ...step("second"), dependencies: ["first"], requiredToolNames: ["computer_read_file"] },
        ],
      }),
    };
    const runs = new RunService({
      database, skills, agents, modelFactory: () => model, plannerFactory: () => planner,
      assessorFactory: () => new RuleBasedStepAssessor(),
    });
    const run = await runs.execute(owner.user.id, agent.id, "two steps");
    assert.equal(run.status, "completed");
    assert.deepEqual(model.visibleTools, [[], ["computer_read_file"]]);
  } finally {
    database.close();
  }
});

test("rule-based assessment cannot claim Skill compliance from activation alone", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("criteria@example.com", "criteria secure password");
    const skill = skills.create(owner.user.id, {
      name: "semantic-check",
      description: "Requires semantic review",
      instructions: "Apply the rule.",
    });
    const agent = agents.create(owner.user.id, {
      name: "local-only",
      systemPrompt: "Try to finish.",
      providerKey: "scenario",
      maxSteps: 3,
      skillIds: [skill.id],
    });
    const runs = new RunService({
      database, skills, agents, modelFactory: () => new LoadThenClaimModel(),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => new RuleBasedStepAssessor(),
    });
    let runId = "";
    await assert.rejects(
      () => runs.execute(owner.user.id, agent.id, "semantic task"),
      (error: unknown) => {
        runId = String((error as { details?: { runId?: string } }).details?.runId ?? "");
        return hasCode(error, "RUN_LIMIT_EXCEEDED");
      },
    );
    const detail = runs.plan(owner.user.id, runId);
    assert.equal(detail.assessments.length, 2);
    assert.ok(detail.assessments.every((item) => !item.approved));
    assert.equal(runs.get(owner.user.id, runId).status, "failed");
  } finally {
    database.close();
  }
});

test("Skill loading, structured planning, execution, assessment, and terminal commit form one complete chain", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("full-chain@example.com", "full chain secure password");
    const skill = skills.create(owner.user.id, {
      name: "evidence-chain",
      description: "Require evidence in the answer",
      instructions: "Include canonical evidence.",
    });
    const agent = agents.create(owner.user.id, {
      name: "model-planned",
      systemPrompt: "Complete the planned task.",
      providerKey: "openai-compatible",
      skillIds: [skill.id],
    });
    const model = new FullChainModel(skill.id);
    const runs = new RunService({ database, skills, agents, modelFactory: () => model });
    const run = await runs.execute(owner.user.id, agent.id, "produce answer");
    assert.equal(run.status, "completed");
    assert.equal(run.output, "answer with canonical evidence");
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    const actions = runs.actionsForRun(owner.user.id, run.id);
    assert.ok(actions.every((action) => action.state === "succeeded"));
    assert.ok(actions.some((action) => action.kind === "planning"));
    assert.ok(actions.some((action) => action.kind === "model_turn"));
    assert.ok(actions.some((action) => action.kind === "assessment"));
    const outcome = database.raw.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("budgeted convergence still requires assessment before TerminalCommitter completes the Run", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("convergence@example.com", "convergence secure password");
    const agent = agents.create(owner.user.id, {
      name: "converging-agent",
      systemPrompt: "Use canonical evidence, then complete the admitted step.",
      providerKey: "scenario",
      maxSteps: 2,
      toolNames: ["collect_proof"],
    });
    let executions = 0;
    const proofTool: RuntimeTool<unknown> = {
      name: "collect_proof",
      description: "Collect the proof required by the current step",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async () => {
        executions += 1;
        return { artifact: "ready", validation: "passed" };
      },
    };
    const model = new TerminalConvergenceModel();
    const runs = new RunService({
      database,
      skills,
      agents,
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => new RuleBasedStepAssessor(),
      tools: [proofTool],
    });

    const run = await runs.execute(owner.user.id, agent.id, "produce a verified artifact");

    assert.equal(run.status, "completed");
    assert.equal(run.output, "verified artifact ready; evidence: collect_proof");
    assert.equal(executions, 1);
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    const proofAction = runs.actionsForRun(owner.user.id, run.id)
      .find((action) => action.kind === "tool_call");
    assert.equal(proofAction?.state, "succeeded");
    assert.equal(proofAction?.replayPolicy, "safe");
    assert.equal(runs.events(owner.user.id, run.id).filter((event) => event.type === "loop.convergence_requested").length, 1);
    const outcome = database.raw.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("an approved recovery revision can retire an unfinished safe tail step and complete only through TerminalCommitter", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("recovery-revision@example.com", "recovery revision secure password");
    const agent = agents.create(owner.user.id, {
      name: "recovery-revision-agent", systemPrompt: "Recover the Plan.", providerKey: "scenario",
    });
    const runId = "recovery-revision-run";
    database.raw.prepare(`
      INSERT INTO runs(id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, agent.id, "produce the requested artifact", Date.now());
    const plans = new PlanRepository(database);
    const plan = plans.create(admitPlan({
      runId,
      proposal: {
        goal: "produce the requested artifact",
        selectedSkillIds: [],
        steps: [step("build"), { ...step("critique-polish"), dependencies: ["build"] }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    plans.startStep(plan.id, "build");
    plans.saveAssessment({
      id: "build-assessment", planId: plan.id, stepId: "build", attempt: 1, approved: true,
      criteria: [{ criterionId: "build-done", satisfied: true, rationale: "canonical evidence", evidenceRefs: ["candidateOutput"] }],
      skills: [], evidenceDigest: "build-evidence", feedback: "", createdAt: Date.now(),
    });
    plans.completeStep(plan.id, "build", "verified artifact", { candidateOutput: "verified artifact", toolCalls: [], modelSteps: 1 });
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({
      runId, planId: plan.id, stepId: "critique-polish", kind: "model_turn", replayPolicy: "safe", deadlineMs: 1_000,
    });
    database.raw.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    assert.equal(actions.reconcileRunningRuns(), 1);
    const runs = new RunService({
      database, skills, agents, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async () => ({
          actionId: action.id, expectedActionRevision: 2, decision: "revise_plan", rationale: "The requested artifact is already assessed; optional polish has no effect.", evidenceRefs: ["build-assessment"],
          planRevision: { goal: "produce the requested artifact", selectedSkillIds: [], steps: [step("build")] },
        }),
      }),
      planRevisionAssessorFactory: () => ({
        assess: async () => ({ approved: true, feedback: "", evidenceRefs: ["build-assessment"] }),
      }),
    });

    const recovery = await runs.advanceRecovery(owner.user.id, runId);
    assert.equal(recovery.state, undefined);
    assert.equal(recovery.decisions[0]?.state, "admitted");
    assert.equal(recovery.planRevisionAssessments[0]?.approved, true);
    assert.equal(runs.get(owner.user.id, runId).status, "completed");
    assert.equal(runs.get(owner.user.id, runId).output, "verified artifact");
    const revised = runs.plan(owner.user.id, runId).plan;
    assert.equal(revised.status, "completed");
    assert.ok(revised.steps.find((item) => item.id === "critique-polish")?.retiredAt !== undefined);
    const outcome = database.raw.prepare("SELECT reason_code FROM run_outcomes WHERE run_id = ?").get(runId) as { reason_code: string };
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("recovery never resumes an unsafe Action and preserves the Run for a new decision", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("recovery-unsafe@example.com", "recovery unsafe secure password");
    const agent = agents.create(owner.user.id, { name: "unsafe-recovery-agent", systemPrompt: "Recover.", providerKey: "scenario" });
    const runId = "unsafe-recovery-run";
    database.raw.prepare(`
      INSERT INTO runs(id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, agent.id, "perform external effect", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    database.raw.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    actions.reconcileRunningRuns();
    const runs = new RunService({
      database, skills, agents, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async () => ({ actionId: action.id, expectedActionRevision: 2, decision: "resume_step", rationale: "retry", evidenceRefs: [] }),
      }),
    });

    await assert.rejects(() => runs.advanceRecovery(owner.user.id, runId), (error: unknown) => hasCode(error, "TOOL_POLICY_DENIED"));
    assert.equal(runs.get(owner.user.id, runId).status, "running");
    const recovery = runs.recoveryForRun(owner.user.id, runId);
    assert.equal(recovery.state?.state, "waiting_recovery");
    assert.equal(recovery.decisions[0]?.state, "rejected");
  } finally {
    database.close();
  }
});

test("recovery records a user question instead of inferring an unsafe external fact", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("recovery-question@example.com", "recovery question secure password");
    const agent = agents.create(owner.user.id, { name: "question-recovery-agent", systemPrompt: "Recover.", providerKey: "scenario" });
    const runId = "question-recovery-run";
    database.raw.prepare(`
      INSERT INTO runs(id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, agent.id, "confirm whether email was sent", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    database.raw.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    actions.reconcileRunningRuns();
    const runs = new RunService({
      database, skills, agents, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async () => ({
          actionId: action.id, expectedActionRevision: 2, decision: "ask_user", rationale: "The external effect is unknown.", evidenceRefs: [],
          question: "Please confirm whether the email was delivered.",
        }),
      }),
    });

    const recovery = await runs.advanceRecovery(owner.user.id, runId);
    assert.equal(recovery.state?.state, "waiting_user");
    assert.equal(recovery.state?.question, "Please confirm whether the email was delivered.");
    assert.equal(recovery.decisions[0]?.state, "admitted");
    assert.equal(runs.get(owner.user.id, runId).status, "running");
  } finally {
    database.close();
  }
});

test("safe recovery rebuilds only complete exchanges, resumes the interrupted step, and continues dependent Plan work", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("recovery-resume@example.com", "recovery resume secure password");
    const agent = agents.create(owner.user.id, { name: "resume-agent", systemPrompt: "Resume the Plan.", providerKey: "scenario" });
    const runId = "recovery-resume-run";
    database.raw.prepare(`
      INSERT INTO runs(id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, agent.id, "recover the interrupted work", Date.now());
    const plans = new PlanRepository(database);
    const plan = plans.create(admitPlan({
      runId,
      proposal: {
        goal: "recover the interrupted work",
        selectedSkillIds: [],
        steps: [step("build"), { ...step("verify"), dependencies: ["build"] }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    plans.startStep(plan.id, "build");
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({
      runId, planId: plan.id, stepId: "build", kind: "model_turn", replayPolicy: "safe", deadlineMs: 1_000,
    });
    database.raw.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES
        (?, 20, 'plan.step.started', ?, ?),
        (?, 21, 'assistant.committed', ?, ?),
        (?, 22, 'tool.effect_pending', ?, ?)
    `).run(
      runId, JSON.stringify({ planId: plan.id, stepId: "build" }), Date.now(),
      runId, JSON.stringify({ step: 1, content: "", toolCalls: [{ id: "unfinished-tool", name: "external_write", arguments: {} }] }), Date.now(),
      runId, JSON.stringify({ step: 1, toolCallId: "unfinished-tool", toolName: "external_write", replaySafe: true }), Date.now(),
    );
    database.raw.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    actions.reconcileRunningRuns();
    let modelCalls = 0;
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          assert.deepEqual(request.messages, [{ role: "user", content: "recover the interrupted work" }]);
          assert.match(request.runtimeContext?.content ?? "", /unfinished-tool/);
          return { content: "rebuilt artifact", toolCalls: [], finishReason: "stop" };
        }
        assert.match(request.runtimeContext?.content ?? "", /"id":"verify"/);
        return { content: "verified rebuilt artifact", toolCalls: [], finishReason: "stop" };
      },
    };
    const runs = new RunService({
      database, skills, agents, modelFactory: () => model,
      recoveryPlannerFactory: () => ({
        decide: async () => ({ actionId: action.id, expectedActionRevision: 2, decision: "resume_step", rationale: "Safe model turn can restart from persisted facts.", evidenceRefs: [] }),
      }),
      assessorFactory: () => approvingSkillAssessor(),
    });

    await runs.advanceRecovery(owner.user.id, runId);
    const resumed = await runs.resumeRecovery(owner.user.id, runId);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.output, "verified rebuilt artifact");
    assert.equal(modelCalls, 2);
    const detail = runs.plan(owner.user.id, runId);
    assert.ok(detail.plan.steps.every((item) => item.status === "completed"));
    assert.equal(detail.assessments.length, 2);
    assert.ok(detail.assessments.every((assessment) => assessment.approved));
    assert.equal(runs.recoveryForRun(owner.user.id, runId).state, undefined);
  } finally {
    database.close();
  }
});

test("a persisted user recovery response reopens Planner decision-making for the same Action", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("recovery-answer@example.com", "recovery answer secure password");
    const agent = agents.create(owner.user.id, { name: "answer-agent", systemPrompt: "Recover.", providerKey: "scenario" });
    const runId = "recovery-answer-run";
    database.raw.prepare(`
      INSERT INTO runs(id, owner_user_id, agent_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, agent.id, "confirm external effect", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    database.raw.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    actions.reconcileRunningRuns();
    let decisions = 0;
    const runs = new RunService({
      database, skills, agents, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async (input) => {
          decisions += 1;
          if (decisions === 1) {
            assert.deepEqual(input.userResponses, []);
            return {
              actionId: action.id, expectedActionRevision: 2, decision: "ask_user", rationale: "External effect is unknown.", evidenceRefs: [],
              question: "Was the external effect applied?",
            };
          }
          assert.equal(input.userResponses[0]?.response, "No, it was not applied.");
          return { actionId: action.id, expectedActionRevision: 2, decision: "fail", rationale: "User confirmed no external effect.", evidenceRefs: [] };
        },
      }),
    });

    await runs.advanceRecovery(owner.user.id, runId);
    const answered = runs.respondRecovery(owner.user.id, runId, "No, it was not applied.");
    assert.equal(answered.state?.state, "waiting_recovery");
    assert.equal(answered.userResponses[0]?.response, "No, it was not applied.");
    await runs.advanceRecovery(owner.user.id, runId);
    assert.equal(decisions, 2);
    assert.equal(runs.get(owner.user.id, runId).status, "failed");
    assert.equal(runs.recoveryForRun(owner.user.id, runId).decisions.filter((item) => item.state === "admitted").length, 2);
  } finally {
    database.close();
  }
});

class StaticModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private readonly response: ModelResponse;
  constructor(response: ModelResponse) { this.response = response; }
  async complete(): Promise<ModelResponse> { return this.response; }
}

class InspectSkillModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sawInstruction = false;
  private calls = 0;
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.match(request.runtimeContext?.content ?? "", /strict-private/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /MANDATORY-PRIVATE-INSTRUCTION/);
      assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill"]);
      assert.equal(request.toolChoice, "required");
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "strict-private" } }],
      };
    }
    const loaded = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
    this.sawInstruction = loaded?.content.includes("MANDATORY-PRIVATE-INSTRUCTION") ?? false;
    return { content: "instruction applied", toolCalls: [], finishReason: "stop" };
  }
}

class LoadThenClaimModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private loaded = false;
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!this.loaded) {
      this.loaded = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "semantic-check" } }],
      };
    }
    return { content: "claim", toolCalls: [], finishReason: "stop" };
  }
}

class StepToolVisibilityModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  visibleTools: string[][] = [];
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.visibleTools.push(request.tools.map((tool) => tool.name));
    return { content: `step-${this.visibleTools.length}`, toolCalls: [], finishReason: "stop" };
  }
}

class FullChainModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;
  private readonly skillId: string;
  constructor(skillId: string) { this.skillId = skillId; }
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill", "submit_plan"]);
      assert.match(request.runtimeContext?.content ?? "", /evidence-chain/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /Include canonical evidence/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "planner-load", name: "load_skill", arguments: { name: "evidence-chain" } }],
      };
    }
    if (this.calls === 2) {
      const loaded = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
      assert.match(loaded?.content ?? "", /Include canonical evidence/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_plan",
          arguments: {
            goal: "produce answer",
            selectedSkillIds: [this.skillId],
            steps: [{
              id: "answer",
              objective: "produce the evidence-backed answer",
              dependencies: [],
              skillIds: [this.skillId],
              requiredToolNames: [],
              successCriteria: [{ id: "answer-ready", description: "An answer is produced" }],
            }],
          },
        }],
      };
    }
    if (this.calls === 3) {
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /Include canonical evidence/);
      assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill"]);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "execution-load", name: "load_skill", arguments: { name: "evidence-chain" } }],
      };
    }
    if (this.calls === 4) {
      const loaded = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
      assert.match(loaded?.content ?? "", /Include canonical evidence/);
      return { content: "answer with canonical evidence", toolCalls: [], finishReason: "stop" };
    }
    assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_assessment"]);
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "assessment",
        name: "submit_assessment",
        arguments: {
          criteria: [
            { criterionId: "answer-ready", satisfied: true, rationale: "Answer exists", evidenceRefs: ["candidateOutput"] },
          ],
          skills: [{
            skillId: this.skillId,
            followed: true,
            rationale: "The exact bound Skill was applied",
            evidenceRefs: ["candidateOutput"],
          }],
          feedback: "",
        },
      }],
    };
  }
}

class TerminalConvergenceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["collect_proof"]);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "proof-1", name: "collect_proof", arguments: {} }],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "verified artifact ready; evidence: collect_proof",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

function step(id: string): PlanProposal["steps"][number] {
  return {
    id,
    objective: id,
    dependencies: [],
    skillIds: [],
    requiredToolNames: [],
    successCriteria: [{ id: `${id}-done`, description: `${id} is done`, source: "planner" }],
  };
}

function skillFixture(overrides: Partial<PrivateSkill> = {}): PrivateSkill {
  return {
    id: "skill-1", ownerUserId: "user-1", name: "skill", description: "skill",
    instructions: "instructions", sourceKind: "inline",
    version: 1, contentHash: "hash", updatedAt: 1, ...overrides,
  };
}

function approvingSkillAssessor(): import("../src/planning/contracts.ts").StepAssessor {
  return {
    assess: async (input) => ({
      id: `assessment-${input.step.id}-${input.attempt}`,
      planId: input.planId,
      stepId: input.step.id,
      attempt: input.attempt,
      approved: true,
      criteria: input.step.successCriteria.map((criterion) => ({
        criterionId: criterion.id,
        satisfied: true,
        rationale: "Verified by the focused test assessor",
        evidenceRefs: ["candidateOutput"],
      })),
      skills: input.skills.map((skill) => ({
        skillId: skill.id,
        followed: true,
        rationale: "The exact Skill body was loaded before completion",
        evidenceRefs: ["load_skill"],
      })),
      evidenceDigest: "test-evidence",
      feedback: "",
      createdAt: Date.now(),
    }),
  };
}

function agentFixture() {
  return {
    id: "agent-1", ownerUserId: "user-1", name: "agent", systemPrompt: "prompt",
    providerKey: "scenario", modelId: "model", maxSteps: 4, maxDepth: 1,
    skillIds: [], childAgentIds: [], toolNames: [], createdAt: 1, updatedAt: 1,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}
