import assert from "node:assert/strict";
import test from "node:test";
import { ModelStepAssessor } from "../src/planning/assessor.ts";
import type { StepAssessmentInput } from "../src/planning/contracts.ts";
import type { ModelAdapter, RuntimeEvent } from "../src/runtime/contracts.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { AppError } from "../src/shared/errors.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";

function assessmentInput(): StepAssessmentInput {
  return {
    runId: "run-identity", planId: "plan-identity", attempt: 1,
    canonicalState: createCanonicalRunState({
      runId: "run-identity", userInput: "Analyze the queried table.", now: 1,
      understanding: understandTask({ objective: "Analyze the queried table." }),
    }),
    step: {
      id: "acquire", objective: "Publish query evidence.", role: "fact_acquisition",
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1", requiredCapabilities: [], resolvedToolNames: [],
        evidenceProducers: [], sourceKinds: [], sideEffect: "none", evidenceKinds: [], targetIds: [],
      },
      successCriteria: [{ id: "query-facts", description: "The query facts are supported.",
        source: "task", verification: "model_judged", blocking: true }],
    },
    skills: [
      { id: "discovered:table-analysis", name: "table-analysis", version: 1, sourceKind: "package",
        contentHash: "analysis-hash", description: "Analyze table evidence.", instructions: "Read the table.", ownerUserId: "owner" },
      { id: "private-97bc", name: "query-provider", version: 1, sourceKind: "inline",
        contentHash: "provider-hash", description: "Read query evidence.", instructions: "Query read-only.", ownerUserId: "owner" },
    ],
    evidence: { candidateOutput: "The table has 46 columns, backed by the query.", modelSteps: 1, toolCalls: [] },
  } as unknown as StepAssessmentInput;
}

function response(input: StepAssessmentInput, skillIds = input.skills.map((skill) => skill.id), criterionIds = input.step.successCriteria.map((criterion) => criterion.id)) {
  return {
    content: "", finishReason: "tool_calls" as const,
    toolCalls: [{ id: "assessment-call", name: "submit_assessment", arguments: {
      criteria: criterionIds.map((criterionId) => ({ criterionId, satisfied: true, rationale: "Supported.", evidenceRefs: [] })),
      skills: skillIds.map((skillId) => ({ skillId, status: "not_assessed", followed: false, rationale: "QA not rerun.", evidenceRefs: [] })),
      feedback: "",
    } }],
  };
}

const limits = { contextWindowTokens: 100_000, maxOutputTokens: 8_192 };

test("assessment schema binds exact current Skill and criterion IDs rather than evidence names", async () => {
  const input = assessmentInput();
  const model: ModelAdapter = { limits, async complete(invocation) {
    const schema = invocation.tools[0]!.inputSchema as any;
    assert.deepEqual(schema.properties.skills.items.properties.skillId.enum, ["discovered:table-analysis", "private-97bc"]);
    assert.equal(schema.properties.skills.minItems, 2);
    assert.equal(schema.properties.skills.maxItems, 2);
    assert.deepEqual(schema.properties.criteria.items.properties.criterionId.enum, ["query-facts"]);
    assert.equal(schema.properties.criteria.minItems, 1);
    assert.equal(schema.properties.criteria.maxItems, 1);
    return response(input);
  } };
  const result = await new ModelStepAssessor(model).assess(input);
  assert.deepEqual(result.skills.map((skill) => skill.skillId), input.skills.map((skill) => skill.id));
  assert.equal(result.approved, true);

  // An empty Skill set must stay empty without producing an invalid enum: [].
  const emptyInput = { ...input, skills: [] };
  await new ModelStepAssessor({ limits, async complete(invocation) {
    const schema = invocation.tools[0]!.inputSchema as any;
    assert.equal(schema.properties.skills.maxItems, 0);
    assert.equal(schema.properties.skills.minItems, 0);
    assert.equal(schema.properties.skills.items.properties.skillId.enum, undefined);
    return response(emptyInput);
  } }).assess(emptyInput);
});

test("unique Skill names resolve in one assessment call and preserve observations and audit references", async () => {
  const input = assessmentInput();
  const events: RuntimeEvent[] = [];
  let calls = 0;
  const submitted = response(input, input.skills.map((skill) => skill.name));
  const model: ModelAdapter = { limits, async complete() {
    calls += 1;
    return submitted;
  } };
  const result = await new ModelStepAssessor(model).assess(input, undefined, async (event) => { events.push(event); });
  assert.equal(calls, 1);
  assert.equal(result.approved, true);
  assert.deepEqual(result.skills, submitted.toolCalls[0]!.arguments.skills.map((skill, index) => ({
    ...skill, skillId: input.skills[index]!.id, submittedSkillReference: skill.skillId,
  })));
  assert.deepEqual(submitted.toolCalls[0]!.arguments.skills.map((skill) => skill.skillId), input.skills.map((skill) => skill.name));
  assert.equal(events.filter((event) => event.type === "assessment.validation.rejected").length, 0);
  assert.deepEqual(events.find((event) => event.type === "assessment.skill_identity.resolved")?.data.resolutions,
    input.skills.map((skill) => ({ submittedReference: skill.name, skillId: skill.id })));

  const database = new AppDatabase(":memory:");
  try {
    await database.prepare(`INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, 'owner', 0, 0, 'running', 'Analyze table', 1)`).run(input.runId);
    await database.prepare(`INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, status, created_at, updated_at)
      VALUES (?, ?, 1, 'Analyze table', '[]', 'running', 1, 1)`).run(input.planId, input.runId);
    await database.prepare(`INSERT INTO plan_steps(plan_id, step_id, position, objective, dependencies_json,
      skill_ids_json, recommended_tool_names_json, success_criteria_json, status)
      VALUES (?, ?, 0, 'Publish query evidence', '[]', ?, '[]', ?, 'running')`).run(
      input.planId, input.step.id, JSON.stringify(input.skills.map((skill) => skill.id)), JSON.stringify(input.step.successCriteria),
    );
    const repository = new PlanRepository(database);
    await repository.saveAssessment(result);
    const persisted = await repository.assessments(input.planId);
    assert.deepEqual(persisted[0]!.skills, result.skills);
  } finally {
    await database.close();
  }
});

test("unknown identities still repair using exact identity differences", async () => {
  const input = assessmentInput();
  let calls = 0;
  const model: ModelAdapter = { limits, async complete(invocation) {
    calls += 1;
    if (calls === 1) return response(input, ["unknown-analysis", "unknown-provider"]);
    const context = invocation.runtimeContext!.content;
    const directive = JSON.parse(context.split("<runtime_directive>\n")[1]!.split("\n</runtime_directive>")[0]!);
    assert.deepEqual(directive.assessmentRepair.validationDetails, {
      identityKind: "Skill", expectedIds: ["discovered:table-analysis", "private-97bc"],
      receivedIds: ["unknown-analysis", "unknown-provider"], unknownIds: ["unknown-analysis", "unknown-provider"],
      missingIds: ["discovered:table-analysis", "private-97bc"], duplicateIds: [],
    });
    return response(input);
  } };
  const result = await new ModelStepAssessor(model).assess(input);
  assert.equal(calls, 2);
  assert.equal(result.approved, true);
});

for (const mismatch of ["unknown", "duplicate", "missing", "criterion", "alias_duplicate", "ambiguous", "out_of_scope"] as const) {
  test(`assessment keeps ${mismatch} identities invalid after bounded repair attempts`, async () => {
    const fixture = assessmentInput();
    const input = mismatch === "ambiguous"
      ? { ...fixture, skills: fixture.skills.map((skill) => ({ ...skill, name: "shared-name" })) }
      : fixture;
    let calls = 0;
    const events: RuntimeEvent[] = [];
    const model: ModelAdapter = { limits, async complete() {
      calls += 1;
      if (mismatch === "criterion") return response(input, undefined, ["another-criterion"]);
      if (mismatch === "duplicate") return response(input, [input.skills[0]!.id, input.skills[0]!.id]);
      if (mismatch === "alias_duplicate") return response(input, [input.skills[0]!.id, input.skills[0]!.name]);
      if (mismatch === "ambiguous") return response(input, ["shared-name", input.skills[1]!.id]);
      // This is a valid ID from a different step, absent from input.skills.
      if (mismatch === "out_of_scope") return response(input, ["discovered:report-qc", input.skills[1]!.id]);
      if (mismatch === "missing") return response(input, [input.skills[0]!.id]);
      return response(input, ["table-analysis-v2", input.skills[1]!.id]);
    } };
    await assert.rejects(new ModelStepAssessor(model).assess(input, undefined, async (event) => { events.push(event); }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "ASSESSMENT_ERROR");
      assert.equal(error.details?.identityKind, mismatch === "criterion" ? "criterion" : "Skill");
      if (mismatch === "duplicate" || mismatch === "alias_duplicate") assert.deepEqual(error.details?.duplicateIds, [input.skills[0]!.id]);
      return true;
    });
    assert.equal(calls, 3);
    assert.equal(events.filter((event) => event.type === "assessment.validation.rejected").length, 3);
  });
}
