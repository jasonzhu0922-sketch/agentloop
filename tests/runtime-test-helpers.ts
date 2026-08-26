import { randomUUID } from "node:crypto";
import type { Planner, StepAssessor } from "../src/planning/contracts.ts";

export const TEST_MODEL_LIMITS = {
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 8_192,
} as const;

export function singleStepTestPlanner(): Planner {
  return {
    plan: async (task) => ({
      goal: task.input,
      schema: "agentloop.outcomePlan/v2",
      shape: "single_leaf",
      selectedSkillRoles: task.availableSkills.map((skill) => ({
        skillId: skill.id,
        role: "primary_builder",
        reason: "Focused test Skill selection",
      })),
      selectedSkillIds: task.availableSkills.map((skill) => skill.id),
      steps: [{
        id: "test-step",
        objective: task.input,
        dependencies: [],
        role: "deliver",
        skillIds: task.availableSkills.map((skill) => skill.id),
        recommendedToolNames: [...task.availableToolNames],
        evidenceContract: { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" },
        successCriteria: [{
          id: "test-output",
          description: "Produce a non-empty result for the focused test",
          source: "task",
        }],
      }],
    }),
  };
}

export function approvingTestAssessor(): StepAssessor {
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
        rationale: "Approved by the explicit focused-test assessor",
        evidenceRefs: ["candidateOutput"],
      })),
      skills: input.skills.map((skill) => ({
        skillId: skill.id,
        followed: true,
        rationale: "Approved by the explicit focused-test assessor",
        evidenceRefs: ["load_skill"],
      })),
      evidenceDigest: "focused-test-evidence",
      feedback: "",
      createdAt: Date.now(),
    }),
  };
}
