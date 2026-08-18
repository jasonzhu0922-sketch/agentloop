import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { ModelAdapter, ModelInvocation, RuntimeContextSnapshot, RuntimeEventSink } from "../runtime/contracts.ts";
import { completeWithStreaming } from "../runtime/model-streaming.ts";
import type {
  CriterionAssessment,
  SkillAssessment,
  SkillComplianceAssessment,
  StepAssessmentInput,
  StepAssessor,
} from "./contracts.ts";

const SUBMIT_ASSESSMENT_TOOL = {
  name: "submit_assessment",
  description: "Submit a criterion-by-criterion and Skill-by-Skill completion assessment.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["criteria", "skills", "feedback"],
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterionId", "satisfied", "rationale", "evidenceRefs"],
          properties: {
            criterionId: { type: "string" },
            satisfied: { type: "boolean" },
            rationale: { type: "string" },
            evidenceRefs: { type: "array", items: { type: "string" } },
          },
        },
      },
      skills: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["skillId", "followed", "rationale", "evidenceRefs"],
          properties: {
            skillId: { type: "string" },
            followed: { type: "boolean" },
            rationale: { type: "string" },
            evidenceRefs: { type: "array", items: { type: "string" } },
          },
        },
      },
      feedback: { type: "string" },
    },
  },
} as const;

const MAX_ASSESSMENT_ATTEMPTS = 3;

export class ModelStepAssessor implements StepAssessor {
  private readonly model: ModelAdapter;

  constructor(model: ModelAdapter) {
    this.model = model;
  }

  async assess(input: StepAssessmentInput, signal?: AbortSignal, emit?: RuntimeEventSink): Promise<SkillComplianceAssessment> {
    const messages: ModelInvocation["messages"] = [];
    let lastError = new AppError("ASSESSMENT_ERROR", "Assessor did not produce a valid assessment", 422);
    let runtimeDirective: string | undefined;
    for (let attempt = 1; attempt <= MAX_ASSESSMENT_ATTEMPTS; attempt += 1) {
      const invocation: ModelInvocation = {
        runId: input.runId,
        systemPrompt: [
          "You are the independent completion assessor in a plan-first agent runtime.",
          "Assess only the supplied candidate and canonical tool evidence.",
          "A tool result, artifact, trace, or model claim is not sufficient by itself.",
          "Every criterion and every bound Skill must receive exactly one assessment.",
          "The exact loaded Skill body is the only domain-workflow authority; assess adherence to it directly without inventing wrapper criteria.",
          "Return exactly one submit_assessment tool call. Do not execute the task or rewrite the answer.",
        ].join("\n"),
        phase: "assessment",
        runtimeContext: assessmentRuntimeContext(input, attempt, runtimeDirective),
        messages,
        tools: [SUBMIT_ASSESSMENT_TOOL],
        toolChoice: { name: SUBMIT_ASSESSMENT_TOOL.name },
      };
      const response = emit === undefined
        ? await this.model.complete(invocation, signal)
        : await completeWithStreaming({
          model: this.model,
          invocation,
          emit,
          signal,
          base: { phase: "assessment", stepId: input.step.id, attempt },
        });
      try {
        if (
          response.finishReason === "length"
          || response.toolCalls.length !== 1
          || response.toolCalls[0].name !== SUBMIT_ASSESSMENT_TOOL.name
        ) {
          throw new AppError(
            "ASSESSMENT_ERROR",
            "Assessor must submit exactly one complete structured assessment",
            422,
          );
        }
        return parseAssessment(input, response.toolCalls[0].arguments);
      } catch (error) {
        lastError = error instanceof AppError && error.code === "ASSESSMENT_ERROR"
          ? error
          : new AppError("ASSESSMENT_ERROR", error instanceof Error ? error.message : "Invalid assessment", 422);
        if (attempt === MAX_ASSESSMENT_ATTEMPTS) break;
        runtimeDirective = JSON.stringify({
          assessmentRepair: {
            attempt: attempt + 1,
            validationError: lastError.message,
            instruction: "Resubmit the entire assessment as exactly one valid submit_assessment tool call.",
          },
        });
      }
    }
    throw lastError;
  }
}

export class RuleBasedStepAssessor implements StepAssessor {
  async assess(input: StepAssessmentInput): Promise<SkillComplianceAssessment> {
    const nonEmpty = input.evidence.candidateOutput.trim().length > 0;
    const criteria: CriterionAssessment[] = input.step.successCriteria.map((criterion) => {
      return {
        criterionId: criterion.id,
        satisfied: nonEmpty,
        rationale: nonEmpty
          ? "The candidate contains an observable result"
          : "The candidate output is empty",
        evidenceRefs: nonEmpty ? ["candidateOutput"] : [],
      };
    });
    const skills: SkillAssessment[] = input.skills.map((skill) => ({
      skillId: skill.id,
      followed: false,
      rationale: "Skill adherence requires a model-backed or policy-backed assessor; activation alone is not compliance",
      evidenceRefs: [`skill:${skill.id}:${skill.contentHash}`],
    }));
    return buildAssessment(input, criteria, skills, "");
  }
}

function parseAssessment(input: StepAssessmentInput, value: unknown): SkillComplianceAssessment {
  try {
    const record = requireRecord(value, "submit_assessment arguments");
    if (!Array.isArray(record.criteria) || !Array.isArray(record.skills)) {
      throw new TypeError("criteria and skills must be arrays");
    }
    const criteria = record.criteria.map((item, index): CriterionAssessment => {
      const row = requireRecord(item, `criteria[${index}]`);
      if (typeof row.satisfied !== "boolean") throw new TypeError(`criteria[${index}].satisfied must be boolean`);
      return {
        criterionId: requireString(row.criterionId, `criteria[${index}].criterionId`, { max: 128 }),
        satisfied: row.satisfied,
        rationale: requireString(row.rationale, `criteria[${index}].rationale`, { max: 4_000 }),
        evidenceRefs: requireStringArray(row.evidenceRefs, `criteria[${index}].evidenceRefs`, 100),
      };
    });
    const skills = record.skills.map((item, index): SkillAssessment => {
      const row = requireRecord(item, `skills[${index}]`);
      if (typeof row.followed !== "boolean") throw new TypeError(`skills[${index}].followed must be boolean`);
      return {
        skillId: requireString(row.skillId, `skills[${index}].skillId`, { max: 128 }),
        followed: row.followed,
        rationale: requireString(row.rationale, `skills[${index}].rationale`, { max: 4_000 }),
        evidenceRefs: requireStringArray(row.evidenceRefs, `skills[${index}].evidenceRefs`, 100),
      };
    });
    assertExactIds(
      criteria.map((item) => item.criterionId),
      input.step.successCriteria.map((item) => item.id),
      "criterion",
    );
    assertExactIds(skills.map((item) => item.skillId), input.skills.map((item) => item.id), "Skill");
    const feedback = typeof record.feedback === "string" ? record.feedback.trim().slice(0, 8_000) : "";
    return buildAssessment(input, criteria, skills, feedback);
  } catch (error) {
    if (error instanceof AppError && error.code === "ASSESSMENT_ERROR") throw error;
    throw new AppError(
      "ASSESSMENT_ERROR",
      error instanceof Error ? `Invalid assessment: ${error.message}` : "Invalid assessment",
      422,
    );
  }
}

function buildAssessment(
  input: StepAssessmentInput,
  criteria: readonly CriterionAssessment[],
  skills: readonly SkillAssessment[],
  feedback: string,
): SkillComplianceAssessment {
  const approved = input.evidence.candidateOutput.trim().length > 0
    && criteria.every((item) => item.satisfied)
    && skills.every((item) => item.followed);
  return {
    id: randomUUID(),
    planId: input.planId,
    stepId: input.step.id,
    attempt: input.attempt,
    approved,
    criteria,
    skills,
    evidenceDigest: evidenceDigest(input.evidence),
    feedback: approved ? "" : feedback || defaultFeedback(criteria, skills),
    createdAt: Date.now(),
  };
}

function assessmentView(input: StepAssessmentInput): Record<string, unknown> {
  return {
    step: {
      id: input.step.id,
      objective: input.step.objective,
      successCriteria: input.step.successCriteria,
    },
    skills: input.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      contentHash: skill.contentHash,
      sourceKind: skill.sourceKind,
      ...(skill.package === undefined ? {} : {
        package: {
          packageHash: skill.package.packageHash,
          entrypointPath: skill.package.entrypointPath,
          ...(skill.package.url === undefined ? {} : {
            sourceUrl: skill.package.url,
            sourceRevision: skill.package.revision,
          }),
        },
      }),
      instructions: skill.instructions,
    })),
    evidence: input.modelEvidence ?? input.evidence,
    ...(input.contextSummary === undefined ? {} : { contextSummary: input.contextSummary }),
  };
}

function assessmentRuntimeContext(
  input: StepAssessmentInput,
  attempt: number,
  runtimeDirective: string | undefined,
): RuntimeContextSnapshot {
  return {
    id: `${input.runId}:assessment:${input.step.id}:${attempt}`,
    phase: "assessment",
    ...(attempt === 1 ? {} : { supersedesId: `${input.runId}:assessment:${input.step.id}:${attempt - 1}` }),
    content: [
      "<assessment_context source=\"server\">",
      JSON.stringify(assessmentView(input)),
      "</assessment_context>",
      ...(runtimeDirective === undefined ? [] : [
        "<runtime_directive>",
        runtimeDirective,
        "</runtime_directive>",
      ]),
    ].join("\n"),
  };
}

function evidenceDigest(evidence: unknown): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function assertExactIds(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) {
    throw new AppError("ASSESSMENT_ERROR", `Assessment must cover every ${label} exactly once`, 422);
  }
  const expectedSet = new Set(expected);
  if (actual.some((id) => !expectedSet.has(id))) {
    throw new AppError("ASSESSMENT_ERROR", `Assessment contains an unknown ${label} ID`, 422);
  }
}

function defaultFeedback(
  criteria: readonly CriterionAssessment[],
  skills: readonly SkillAssessment[],
): string {
  const failedCriteria = criteria.filter((item) => !item.satisfied).map((item) => item.criterionId);
  const failedSkills = skills.filter((item) => !item.followed).map((item) => item.skillId);
  return `Completion rejected. Unsatisfied criteria: ${failedCriteria.join(", ") || "none"}; `
    + `non-compliant Skills: ${failedSkills.join(", ") || "none"}. Repair the same step and resubmit.`;
}
