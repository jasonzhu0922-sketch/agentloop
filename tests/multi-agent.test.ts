import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AgentDefinition } from "../src/agents/agent-service.ts";
import { AgentService } from "../src/agents/agent-service.ts";
import { AuthService } from "../src/auth/auth-service.ts";
import type { StepAssessor } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("an authorized child gets its own run, lineage, context, and narrowed depth budget", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("owner@example.com", "owner secure password");
    const stranger = await auth.register("stranger@example.com", "stranger secure password");
    const childOnlySkill = skills.create(owner.user.id, {
      name: "child-only",
      description: "Must not expand through delegation",
      instructions: "CHILD-ONLY-SECRET",
    });

    const child = agents.create(owner.user.id, {
      name: "child",
      systemPrompt: "Complete one bounded child task.",
      providerKey: "scenario",
      modelId: "scenario-child",
      maxDepth: 0,
      skillIds: [childOnlySkill.id],
      toolNames: ["computer_read_file"],
    });
    const parent = agents.create(owner.user.id, {
      name: "parent",
      systemPrompt: "Delegate the bounded calculation.",
      providerKey: "scenario",
      modelId: "scenario-parent",
      maxDepth: 3,
      childAgentIds: [child.id],
    });
    const runs = new RunService({
      database,
      skills,
      agents,
      modelFactory: scenarioModelFactory,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingAssessor(),
      globalMaxDepth: 4,
    });

    const parentRun = await runs.execute(owner.user.id, parent.id, "delegate this task");
    assert.equal(parentRun.status, "completed");
    assert.match(parentRun.output ?? "", /child completed/);

    const childRow = database.raw
      .prepare("SELECT id, parent_run_id, depth, owner_user_id, output FROM runs WHERE agent_id = ?")
      .get(child.id) as {
        id: string;
        parent_run_id: string;
        depth: number;
        owner_user_id: string;
        output: string;
      };
    assert.equal(childRow.parent_run_id, parentRun.id);
    assert.equal(childRow.depth, 1);
    assert.equal(childRow.owner_user_id, owner.user.id);
    assert.equal(childRow.output, "child completed: compute 6 * 7");
    assert.throws(
      () => runs.get(stranger.user.id, parentRun.id),
      (error: unknown) => error !== null
        && typeof error === "object"
        && "code" in error
        && (error as { code: unknown }).code === "NOT_FOUND",
    );

    const parentEvents = runs.events(owner.user.id, parentRun.id);
    assert.ok(parentEvents.some((event) => event.type === "tool.effect_pending"));
    assert.ok(parentEvents.some((event) => event.type === "tool.completed"));
    const childEvents = runs.events(owner.user.id, childRow.id);
    assert.equal(childEvents[0].type, "run.started");
    assert.equal(childEvents[0].data.parentRunId, parentRun.id);
  } finally {
    database.close();
  }
});

test("a Plan-bound private Skill is loaded on demand through its granted tool", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const agents = new AgentService(database, skills);
    const owner = await auth.register("skill-owner@example.com", "skill owner secure password");
    const skill = skills.create(owner.user.id, {
      name: "private-brief",
      description: "Use the approved internal brief",
      instructions: "SECRET-INSTRUCTION: cite internal evidence before answering.",
    });
    const agent = agents.create(owner.user.id, {
      name: "skill-user",
      systemPrompt: "Load the private brief when needed.",
      providerKey: "scenario",
      modelId: "skill-loading",
      skillIds: [skill.id],
    });
    const runs = new RunService({
      database,
      skills,
      agents,
      modelFactory: () => new SkillLoadingModel(),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingAssessor(),
    });

    const run = await runs.execute(owner.user.id, agent.id, "use the brief");
    assert.equal(run.status, "completed");
    assert.equal(run.output, "private skill loaded and applied");
    const events = runs.events(owner.user.id, run.id);
    const completed = events.find(
      (event) => event.type === "tool.completed" && event.data.toolName === "load_skill",
    );
    assert.match(String(completed?.data.result), /SECRET-INSTRUCTION/);
  } finally {
    database.close();
  }
});

function scenarioModelFactory(agent: AgentDefinition): ModelAdapter {
  return agent.name === "parent" ? new ParentScenarioModel(agent.childAgentIds[0]) : new ChildScenarioModel();
}

class ParentScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private readonly childAgentId: string;
  private calls = 0;

  constructor(childAgentId: string) {
    this.childAgentId = childAgentId;
  }

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.ok(request.tools.some((tool) => tool.name === "delegate_task"));
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "delegate-1",
          name: "delegate_task",
          arguments: { agentId: this.childAgentId, task: "compute 6 * 7" },
        }],
      };
    }
    const childResult = request.messages.find((message) => message.role === "tool" && message.name === "delegate_task");
    assert.ok(childResult !== undefined);
    const parsed = JSON.parse(childResult.content) as { output: string };
    return { content: `parent received: ${parsed.output}`, finishReason: "stop", toolCalls: [] };
  }
}

class ChildScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    assert.equal(request.tools.some((tool) => tool.name === "delegate_task"), false);
    assert.equal(request.tools.some((tool) => tool.name === "computer_read_file"), false);
    assert.doesNotMatch(request.systemPrompt, /CHILD-ONLY-SECRET/);
    const userMessage = request.messages.find((message) => message.role === "user");
    return {
      content: `child completed: ${userMessage?.content ?? ""}`,
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class SkillLoadingModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.match(request.runtimeContext?.content ?? "", /private-brief/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /SECRET-INSTRUCTION/);
      assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill"]);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load-1", name: "load_skill", arguments: { name: "private-brief" } }],
      };
    }
    const result = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
    assert.match(result?.content ?? "", /SECRET-INSTRUCTION/);
    return { content: "private skill loaded and applied", finishReason: "stop", toolCalls: [] };
  }
}

function approvingAssessor(): StepAssessor {
  return {
    assess: async (input) => ({
      id: randomUUID(),
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
