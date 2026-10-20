import assert from "node:assert/strict";
import test from "node:test";
import { ModelStepAssessor } from "../src/planning/assessor.ts";
import type { StepAssessmentInput } from "../src/planning/contracts.ts";
import type { ModelInvocation, RuntimeEvent } from "../src/runtime/contracts.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { AppError } from "../src/shared/errors.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

const userInput = "Reply with exactly: browser production smoke passed";
const output = "browser production smoke passed";

function assessmentInput(): StepAssessmentInput {
  return {
    runId: "run-contract", planId: "plan-contract", attempt: 1, assessmentProfile: "result_judged",
    canonicalState: createCanonicalRunState({ runId: "run-contract", userInput,
      understanding: understandTask({ objective: userInput }), now: 1 }),
    step: {
      id: "response", kind: "leaf", position: 0, status: "running", objective: userInput,
      dependencies: [], skillIds: [], requiredCapabilities: [], requiredFacts: [], refinementState: "not_refinable",
      executionBinding: { schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: [],
        evidenceProducers: [], sourceKinds: [], sideEffect: "none", evidenceKinds: [], targetIds: [] },
      successCriteria: [{ id: "answered", description: "Return the exact requested reply.", source: "task",
        verification: "model_judged", blocking: true }],
    },
    skills: [], evidence: { candidateOutput: output, modelSteps: 1, toolCalls: [] },
  };
}

function submission(input: StepAssessmentInput,
  contractCheck: unknown = { status: "valid", rationale: "The criterion follows directly from the exact-reply request." },
  failedBoundary: unknown = null,
) {
  return { content: "", finishReason: "tool_calls" as const, toolCalls: [{ id: "assessment", name: "submit_assessment", arguments: {
    criteria: input.step.successCriteria.map((criterion) => ({ criterionId: criterion.id, satisfied: true,
      rationale: "The candidate exactly matches the requested reply.", evidenceRefs: ["candidateOutput"], contractCheck })),
    skills: [], feedback: "The candidate fulfills the requested reply.", failedBoundary,
  } }] };
}

function assertStrictObjects(schema: any): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    for (const property of Object.values(schema.properties)) assertStrictObjects(property);
  }
  if (types.includes("array")) assertStrictObjects(schema.items);
}

test("assessment uses one strict explicit-state schema, including nullable failure and an exact current step ID", async () => {
  const input = assessmentInput();
  await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
    const tool = request.tools[0]!;
    assert.equal(tool.strict, true);
    const schema = tool.inputSchema as any;
    assertStrictObjects(schema);
    const check = schema.properties.criteria.items.properties.contractCheck;
    assert.deepEqual(check.properties.status.enum, ["valid", "invalid"]);
    assert.equal(check.properties.rationale.minLength, 1);
    assert.equal(schema.properties.criteria.items.properties.contractIssue, undefined);
    assert.deepEqual(schema.properties.failedBoundary.type, ["object", "null"]);
    assert.deepEqual(schema.properties.failedBoundary.properties.stepId.enum, [input.step.id]);
    return submission(input);
  } }).assess(input);
});

for (const rationale of ["None.", "No unsupported requirement was added.", "该条件忠实反映用户要求，没有契约问题。", "This condition is necessary for the original goal."]) {
  test(`a valid contract check cannot become a conflict because of explanatory prose: ${rationale}`, async () => {
    const input = assessmentInput();
    let calls = 0;
    const events: RuntimeEvent[] = [];
    const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
      calls += 1;
      return submission(input, { status: "valid", rationale });
    } }).assess(input, undefined, async (event) => { events.push(event); });
    assert.equal(calls, 1);
    assert.equal(result.approved, true);
    assert.equal(result.criteria[0]!.satisfied, true);
    assert.equal(result.criteria[0]!.status, "satisfied");
    assert.equal(result.criteria[0]!.contractIssue, undefined);
    assert.equal(result.failedBoundary, undefined);
    assert.equal(events.some((event) => event.type === "assessment.validation.rejected"), false);
  });
}

test("an explicit invalid condition overrides satisfied=true and preserves its reason for canonical Plan revision", async () => {
  const input = assessmentInput();
  const reason = "A separate proof document is an execution method, not a necessary result condition.";
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
    return submission(input, { status: "invalid", rationale: reason });
  } }).assess(input);
  assert.equal(result.approved, false);
  assert.equal(result.criteria[0]!.satisfied, false);
  assert.equal(result.criteria[0]!.status, "conflict");
  assert.equal(result.criteria[0]!.contractIssue, reason);
  assert.equal(result.failedBoundary?.suggestedRepairShape, "revise_plan");
  assert.equal(result.failedBoundary?.unmetCriteria?.[0]?.contractIssue, reason);
  assert.deepEqual(result.failedBoundary?.missingEvidenceKinds, []);
});

test("a valid condition does not approve an unsatisfied result or erase its gap when failedBoundary is null", async () => {
  const input = assessmentInput();
  const response = submission(input);
  response.toolCalls[0]!.arguments.criteria[0]!.satisfied = false;
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() { return response; } }).assess(input);
  assert.equal(result.approved, false);
  assert.equal(result.criteria[0]!.status, "unverified");
  assert.equal(result.criteria[0]!.contractIssue, undefined);
  assert.equal(result.failedBoundary?.stepId, input.step.id);
  assert.equal(result.failedBoundary?.unmetCriteria?.[0]?.criterionId, "answered");
});

for (const check of [undefined, null, "", "None.", {}, { status: "unknown", rationale: "No issue." },
  { status: "valid", rationale: "" }, { status: "invalid", rationale: " " }]) {
  test(`malformed contract state remains an assessment error, not implicit approval: ${JSON.stringify(check)}`, async () => {
    const input = assessmentInput();
    let calls = 0;
    await assert.rejects(new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
      calls += 1;
      const response = submission(input);
      response.toolCalls[0]!.arguments.criteria[0]!.contractCheck = check;
      return response;
    } }).assess(input), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "ASSESSMENT_ERROR");
      assert.match(error.message, /contractCheck/);
      return true;
    });
    assert.equal(calls, 3);
  });
}

for (const stepId of ["", "another-step"]) {
  test(`a non-null failedBoundary must identify the current step: ${JSON.stringify(stepId)}`, async () => {
    const input = assessmentInput();
    await assert.rejects(new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
      return submission(input, { status: "valid", rationale: "The criterion is justified." }, {
        stepId, missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [], suggestedRepairShape: "repair_leaf",
      });
    } }).assess(input), /failedBoundary.stepId/);
  });
}

test("a missing failedBoundary is not a second implicit no-failure representation", async () => {
  const input = assessmentInput();
  await assert.rejects(new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
    const response = submission(input);
    response.toolCalls[0]!.arguments.failedBoundary = undefined;
    return response;
  } }).assess(input), /failedBoundary must be a JSON object/);
});

test("a real proposed failure boundary preserves reusable evidence and the selected repair shape", async () => {
  const input = assessmentInput();
  const response = submission(input, { status: "valid", rationale: "The exact reply is required." }, {
    stepId: input.step.id, missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: ["candidateOutput"], suggestedRepairShape: "repair_leaf",
  });
  response.toolCalls[0]!.arguments.criteria[0]!.satisfied = false;
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() { return response; } }).assess(input);
  assert.equal(result.approved, false);
  assert.equal(result.failedBoundary?.suggestedRepairShape, "repair_leaf");
  assert.deepEqual(result.failedBoundary?.reusableEvidenceRefs, ["candidateOutput"]);
});

test("bounded structure repair preserves valid judgments instead of filling a text field with a fabricated conflict", async () => {
  const input = assessmentInput();
  let calls = 0;
  const events: RuntimeEvent[] = [];
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
    calls += 1;
    const response = submission(input);
    if (calls === 1) {
      const criterion = response.toolCalls[0]!.arguments.criteria[0]! as Record<string, unknown>;
      delete criterion.contractCheck;
      criterion.contractIssue = "";
      return response;
    }
    assert.match(request.runtimeContext!.content, /Preserve the substantive judgments/);
    assert.match(request.runtimeContext!.content, /failedBoundary: null/);
    assert.match(request.runtimeContext!.content, /contractCheck/);
    if (calls === 2) response.toolCalls[0]!.arguments.failedBoundary = {
      stepId: "", missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [], suggestedRepairShape: "repair_leaf",
    };
    return response;
  } }).assess(input, undefined, async (event) => { events.push(event); });
  assert.equal(calls, 3);
  assert.equal(result.approved, true);
  assert.equal(result.criteria[0]!.contractIssue, undefined);
  assert.equal(events.filter((event) => event.type === "assessment.validation.rejected").length, 2);
});

test("the production exact-reply scenario reaches persisted assessment, formal Result and terminal delivery with the new contract", async () => {
  const database = new AppDatabase(":memory:");
  let assessmentCalls = 0;
  try {
    const runs = new RunService({ database, skills: new SkillService(database), tools: [],
      plannerFactory: () => ({ async plan(task) {
        const proposal = await singleStepTestPlanner().plan(task);
        return { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
          successCriteria: step.successCriteria.map((criterion) => ({ ...criterion, verification: "model_judged" as const })),
        })) };
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, async complete(request: ModelInvocation) {
        if (request.phase !== "assessment") return { content: output, finishReason: "stop", toolCalls: [] };
        assessmentCalls += 1;
        const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "assess", name: "submit_assessment", arguments: {
          criteria: context.step.successCriteria.map((criterion: { id: string }) => ({ criterionId: criterion.id,
            satisfied: true, rationale: "The candidate exactly fulfills the requested reply.", evidenceRefs: ["candidateOutput"],
            contractCheck: { status: "valid", rationale: "No unsupported requirement was added." } })),
          skills: [], feedback: "The candidate exactly fulfills the requested conversation reply.", failedBoundary: null,
        } }] };
      } }),
    });
    const run = await runs.execute("owner", userInput);
    assert.equal(run.status, "completed");
    assert.equal(run.output, output);
    assert.equal(assessmentCalls, 1);
    const events = await runs.events("owner", run.id);
    assert.equal(events.some((event) => event.type === "assessment.validation.rejected"), false);
    assert.equal(events.some((event) => event.type === "terminal.delivery_committed"), true);
    assert.equal(events.some((event) => event.type === "run.completed"), true);
    const assessments = await database.prepare("SELECT approved, criteria_json FROM skill_compliance_assessments WHERE plan_id IN (SELECT id FROM plans WHERE run_id = ?)")
      .all<{ approved: number; criteria_json: string }>(run.id);
    assert.equal(assessments.length, 1);
    assert.equal(assessments[0]!.approved, 1);
    assert.equal(JSON.parse(assessments[0]!.criteria_json).every((criterion: { satisfied: boolean; contractIssue?: string }) =>
      criterion.satisfied && criterion.contractIssue === undefined), true);
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM run_outcomes WHERE run_id = ?")
      .get<{ count: number }>(run.id))!.count, 1);
  } finally { await database.close(); }
});
