import type { PlanTemplate } from "../types.ts";
import type { TaskFingerprint } from "../types.ts";
import { tokenizeInstructionText } from "../semantic/instruction-tokens.ts";
import { templateInstructionTokens, templateOperationHints } from "./template-signals.ts";

const SPECIFIC_OBJECTIVE_TOKEN_MIN = 3;
const DISJOINT_SPECIFIC_INSTRUCTION_CAP = 0.69;

export function scoreTemplateMatch(input: {
  readonly fingerprint: TaskFingerprint;
  readonly template: PlanTemplate;
}): number {
  const { fingerprint, template } = input;
  const intentScore = overlapScore(fingerprint.intentHints, [template.intentFamily, ...template.positiveExampleRefs]);
  const operationScore = overlapScore(fingerprint.operationHints, templateOperationHints(template));
  const objectiveTokens = templateObjectiveInstructionTokens(template);
  const instructionScore = overlapScore(
    fingerprint.instructionTokens,
    objectiveTokens.length > 0 ? objectiveTokens : templateInstructionTokens(template),
  );
  const inputScore = template.sourceNeed === fingerprint.sourceNeed ? 1 : 0;
  const artifactScore = template.artifactKind === fingerprint.artifactKind ? 1 : 0;
  const capabilityScore = coverageScore(fingerprint.requiredCapabilities, template.requiredCapabilities);
  const skillAffinityScore = template.planSkeleton.some((step) => step.skillRoleHints.some((hint) => fingerprint.skillHints.includes(hint))) ? 1 : 0.5;
  const reliabilityScore = reliability(template);
  const raw =
    0.18 * intentScore
    + 0.14 * operationScore
    + 0.22 * instructionScore
    + 0.14 * inputScore
    + 0.1 * artifactScore
    + 0.12 * capabilityScore
    + 0.03 * skillAffinityScore
    + 0.07 * reliabilityScore;
  const score = Math.max(0, Math.min(1, Number(raw.toFixed(4))));
  if (hasDisjointSpecificInstructionFingerprint(fingerprint.instructionTokens, objectiveTokens, instructionScore)) {
    return Math.min(score, DISJOINT_SPECIFIC_INSTRUCTION_CAP);
  }
  return score;
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

function templateObjectiveInstructionTokens(template: PlanTemplate): readonly string[] {
  const tokens = new Set<string>();
  for (const step of template.planSkeleton) {
    for (const token of tokenizeInstructionText(step.objective ?? "")) tokens.add(token);
  }
  return [...tokens];
}

function hasDisjointSpecificInstructionFingerprint(
  taskTokens: readonly string[],
  templateObjectiveTokens: readonly string[],
  instructionScore: number,
): boolean {
  return instructionScore === 0
    && taskTokens.length >= SPECIFIC_OBJECTIVE_TOKEN_MIN
    && templateObjectiveTokens.length >= SPECIFIC_OBJECTIVE_TOKEN_MIN;
}

function reliability(template: PlanTemplate): number {
  const stats = template.reliability;
  if (stats.completedRuns === 0) return template.status === "active" ? 0.7 : 0.5;
  const failurePenalty = Math.max(stats.planAdmissionFailureRate, stats.assessmentFailureRate, stats.repairRate / 2);
  return Math.max(0, Math.min(1, 1 - failurePenalty));
}
