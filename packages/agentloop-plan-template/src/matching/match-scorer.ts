import type { PlanTemplate } from "../types.ts";
import type { TaskFingerprint } from "../types.ts";
import { taskInstructionTokens, templateInstructionTokens, templateOperationHints } from "./template-signals.ts";

export function scoreTemplateMatch(input: {
  readonly fingerprint: TaskFingerprint;
  readonly template: PlanTemplate;
}): number {
  const { fingerprint, template } = input;
  const intentScore = overlapScore(fingerprint.intentHints, [template.intentFamily, ...template.positiveExampleRefs]);
  const operationScore = overlapScore(fingerprint.operationHints, templateOperationHints(template));
  const instructionScore = overlapScore(fingerprint.instructionTokens, templateInstructionTokens(template));
  const inputScore = template.sourceNeed === fingerprint.sourceNeed ? 1 : 0;
  const artifactScore = template.artifactKind === fingerprint.artifactKind ? 1 : 0;
  const capabilityScore = coverageScore(fingerprint.requiredCapabilities, template.requiredCapabilities);
  const skillAffinityScore = template.planSkeleton.some((step) => step.skillRoleHints.some((hint) => fingerprint.skillHints.includes(hint))) ? 1 : 0.5;
  const reliabilityScore = reliability(template);
  const raw =
    0.2 * intentScore
    + 0.15 * operationScore
    + 0.2 * instructionScore
    + 0.2 * inputScore
    + 0.15 * artifactScore
    + 0.15 * capabilityScore
    + 0.1 * skillAffinityScore
    + 0.1 * reliabilityScore;
  return Math.max(0, Math.min(1, Number(raw.toFixed(4))));
}

function overlapScore(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const normalizedRight = right.map((value) => value.toLowerCase());
  let matches = 0;
  for (const value of left) {
    const normalized = value.toLowerCase();
    if (normalizedRight.some((candidate) => candidate.includes(normalized) || normalized.includes(candidate))) matches += 1;
  }
  return matches / left.length;
}

function coverageScore(taskCapabilities: readonly string[], templateCapabilities: readonly string[]): number {
  if (templateCapabilities.length === 0) return 1;
  const available = new Set(taskCapabilities);
  return templateCapabilities.filter((item) => available.has(item)).length / templateCapabilities.length;
}

function reliability(template: PlanTemplate): number {
  const stats = template.reliability;
  if (stats.completedRuns === 0) return template.status === "active" ? 0.7 : 0.5;
  const failurePenalty = Math.max(stats.planAdmissionFailureRate, stats.assessmentFailureRate, stats.repairRate / 2);
  return Math.max(0, Math.min(1, 1 - failurePenalty));
}
