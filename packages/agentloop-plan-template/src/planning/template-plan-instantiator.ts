import type { PlanProposal, PlanningExtensionInput, SelectedSkillRole } from "@zhujun/agentloop";
import type { PlanTemplate, PlanStepSkeleton, TaskFingerprint } from "../types.ts";

export function instantiatePlanTemplate(input: {
  readonly template: PlanTemplate;
  readonly task: PlanningExtensionInput;
  readonly fingerprint: TaskFingerprint;
}): PlanProposal {
  const selectedSkillRoles = selectSkillRoles(input.task.selectedSkillRoles, input.template);
  const steps = input.template.planSkeleton.map((step) => ({
    id: step.id,
    kind: "leaf" as const,
    objective: instantiateObjective(step, input.task.input),
    dependencies: step.dependsOn,
    role: step.role,
    skillIds: skillIdsForStep(step, selectedSkillRoles),
    recommendedToolNames: step.requiredCapabilities
      .map((capability) => toolForCapability(capability, input.task.availableToolNames))
      .filter((toolName): toolName is string => toolName !== undefined),
    evidenceContract: {
      requiredKinds: step.requiredEvidenceKinds,
      caveatPolicy: "none" as const,
    },
    successCriteria: [
      {
        id: `${step.id}.evidence`,
        description: successCriterionDescription(step),
        source: "planner" as const,
      },
    ],
  }));
  const selectedSkillIds = unique(steps.flatMap((step) => step.skillIds));
  return {
    schema: "agentloop.outcomePlan/v2",
    shape: inferShape(input.template),
    goal: input.task.input,
    selectedSkillIds,
    ...(selectedSkillRoles.length === 0 ? {} : { selectedSkillRoles }),
    steps,
  };
}

function selectSkillRoles(
  available: readonly SelectedSkillRole[],
  template: PlanTemplate,
): readonly SelectedSkillRole[] {
  const requiredRoleHints = new Set(template.planSkeleton.flatMap((step) => step.skillRoleHints));
  return available.filter((selection) => requiredRoleHints.has(selection.role));
}

function skillIdsForStep(
  step: PlanStepSkeleton,
  selectedSkillRoles: readonly SelectedSkillRole[],
): readonly string[] {
  if (step.skillRoleHints.length === 0) return [];
  const hints = new Set(step.skillRoleHints);
  return unique(selectedSkillRoles
    .filter((selection) => hints.has(selection.role))
    .map((selection) => selection.skillId));
}

function instantiateObjective(step: PlanStepSkeleton, userInput: string): string {
  const objective = step.objective?.trim();
  if (objective !== undefined && objective.length > 0 && hasCurrentInputPlaceholder(objective)) {
    return objective
      .replaceAll("{{input}}", userInput)
      .replaceAll("{input}", userInput)
      .replaceAll("$input", userInput)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }
  return `${preferredObjectivePrefix(userInput)}${userInput}`.slice(0, 500);
}

function hasCurrentInputPlaceholder(value: string): boolean {
  return value.includes("{{input}}") || value.includes("{input}") || value.includes("$input");
}

function preferredObjectivePrefix(userInput: string): string {
  return /[\u3400-\u9fff]/u.test(userInput) ? "完成当前任务：" : "Complete current task: ";
}

function successCriterionDescription(step: PlanStepSkeleton): string {
  if (step.producedEvidenceKinds.length > 0) {
    return `Step produces evidence: ${step.producedEvidenceKinds.join(", ")}.`;
  }
  if (step.requiredEvidenceKinds.length > 0) {
    return `Step satisfies evidence: ${step.requiredEvidenceKinds.join(", ")}.`;
  }
  return "Step completes its planned operation with non-empty output.";
}

function toolForCapability(capability: string, availableToolNames: readonly string[]): string | undefined {
  const available = new Set(availableToolNames);
  if (capability === "artifact_acceptance" && available.has("verify_artifact_acceptance")) return "verify_artifact_acceptance";
  if (capability === "artifact_write" && available.has("computer_write_file")) return "computer_write_file";
  if (capability === "web_research" && available.has("websearch")) return "websearch";
  if (capability === "source_read" && available.has("read_source")) return "read_source";
  if (capability === "visible_directory_read" && available.has("computer_list_directory")) return "computer_list_directory";
  if (available.has(capability)) return capability;
  return undefined;
}

function inferShape(template: PlanTemplate): PlanProposal["shape"] {
  if (template.planSkeleton.length === 1) return "single_leaf";
  if (template.planSkeleton.some((step) => step.role === "fact_acquisition")) return "fact_then_produce";
  return "pipeline";
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
