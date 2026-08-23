import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import type { StepAssessor } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("AgentLoop is a single agent: no delegation, and private Skills load through their granted tool", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("skill-owner@example.com", "skill owner secure password");
    const skill = skills.create(owner.user.id, {
      name: "private-brief",
      description: "Use the approved internal brief",
      instructions: [
        "---",
        "agentloop:",
        "  roles:",
        "    - primary_builder",
        "  artifactKinds:",
        "    - none",
        "  sourceKinds: []",
        "  qaKinds: []",
        "---",
        "SECRET-INSTRUCTION: cite internal evidence before answering.",
      ].join("\n"),
    });
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new SingleAgentModel(skill.id),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingAssessor(),
    });

    const run = await runs.execute(owner.user.id, "use the brief");
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

class SingleAgentModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private readonly skillId: string;
  private calls = 0;

  constructor(skillId: string) {
    this.skillId = skillId;
  }

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    assert.equal(request.tools.some((tool) => tool.name === "delegate_task"), false);
    this.calls += 1;
    if (this.calls === 1) {
      assert.match(request.runtimeContext?.content ?? "", /private-brief/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /SECRET-INSTRUCTION/);
      assert.ok(request.tools.some((tool) => tool.name === "load_skill"));
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
