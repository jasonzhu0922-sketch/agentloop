import assert from "node:assert/strict";
import test from "node:test";
import { enforceAdmittedAssessment, ModelStepAssessor } from "../src/planning/assessor.ts";
import { OpenAICompatibleModel, ResponsesModel } from "../src/runtime/models.ts";
import type { StepAssessmentInput } from "../src/planning/contracts.ts";
import type { ModelInvocation, RuntimeEvent } from "../src/runtime/contracts.ts";
import { amendCanonicalIntent, createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { ModelPlanRevisionAssessor } from "../src/runtime/recovery-planning.ts";
import type { PlanRevisionAssessmentInput } from "../src/planning/contracts.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { AppError } from "../src/shared/errors.ts";
import { createDecisionCommit } from "../src/runtime/decision-ledger.ts";
import { buildUserAuthorityContext } from "../src/runtime/user-authority.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

const userInput = "Reply with exactly: browser production smoke passed";
const output = "browser production smoke passed";

test("plan revision assessment uses the ordered amended intent without waiving unchanged constraints", async () => {
  const original = "List the APIs with details, using only the authorized catalog.";
  const steer = "Just the API list; I no longer need details.";
  const state = amendCanonicalIntent(createCanonicalRunState({ runId: "steer-assessment", userInput: original,
    understanding: understandTask({ objective: original }), now: 1 }), {
    messageId: "steer-1", seq: 1, text: steer, explanation: "The user no longer requires details.",
    understanding: understandTask({ objective: "List APIs using only the authorized catalog.", userConstraints: ["Use only the authorized catalog"] }),
  }, 2);
  const input = { runId: state.runId, userInput: state.intent.userInput, canonicalState: state,
    currentPlan: { id: "plan", version: 1 }, proposal: { goal: "List APIs", steps: [] }, retiredStepIds: [],
    recoveryAction: { id: "action", kind: "planning", replayPolicy: "safe", metadata: { reason: "steer" } },
  } as unknown as PlanRevisionAssessmentInput;
  let calls = 0;
  const result = await new ModelPlanRevisionAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
    calls++;
    assert.match(request.systemPrompt, /later amendment can replace or relax an earlier requirement/);
    assert.match(request.systemPrompt, /never infer a waiver from silence/);
    assert.equal(request.messages[0]!.content, state.intent.userInput);
    const context = JSON.parse(request.runtimeContext!.content);
    assert.equal(context.canonicalState.intent.originalUserInput, original);
    assert.equal(context.canonicalState.intent.amendments[0].text, steer);
    assert.ok(JSON.stringify(context.canonicalState.intent.understanding).includes("authorized catalog"));
    return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "assessment", name: "submit_plan_revision_assessment",
      arguments: { approved: true, feedback: "The current request and source constraint are covered.", evidenceRefs: [] } }] };
  } }).assess(input);
  assert.equal(calls, 1);
  assert.equal(result.approved, true);
});

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
  if (schema.anyOf) schema.anyOf.forEach(assertStrictObjects);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    for (const property of Object.values(schema.properties)) assertStrictObjects(property);
  }
  if (types.includes("array")) assertStrictObjects(schema.items);
}

for (const scope of ["fact_result", "user_delivery"] as const) {
  for (const hasFacts of [true, false]) {
    test(`${scope} assesses its owned result without substituting file existence; facts=${hasFacts}`, async () => {
      const base = assessmentInput();
      const question = "List the amounts for each month in the prepared series.";
      const input: StepAssessmentInput = { ...base,
        canonicalState: createCanonicalRunState({ runId: base.runId, userInput: question,
          understanding: understandTask({ objective: question }), now: 1 }),
        step: { ...base.step,
        role: scope === "fact_result" ? "fact_acquisition" : "deliver",
        objective: scope === "fact_result" ? "Publish reusable monthly facts for the delivery Step." : "Present monthly amounts to the user.",
        successCriteria: [{ ...base.step.successCriteria[0]!, description: "Contain the requested monthly amounts." }],
      }, evidence: { ...base.evidence, candidateOutput: hasFacts
        ? "2026-01: 2056259.64; 2026-02: 2533324.36. Source: committed query result."
        : "The query succeeded and the result is stored in facts.json." } };
      const assessed = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
        const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
        assert.equal(context.assessmentPolicy.scope, scope);
        assert.equal(context.step.role, input.step.role);
        assert.match(request.systemPrompt, /merely saying that a file exists or that a query succeeded is not a fact result/);
        assert.match(request.systemPrompt, /Do not demand the final conversational table/);
        const response = submission(input);
        response.toolCalls[0]!.arguments.criteria[0]!.satisfied = hasFacts;
        return response;
      } }).assess(input);
      assert.equal(assessed.approved, hasFacts);
    });
  }
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
    assert.deepEqual(schema.properties.failedBoundary.anyOf[1], { type: "null" });
    assert.equal(schema.properties.failedBoundary.anyOf[0].type, "object");
    assert.deepEqual(schema.properties.failedBoundary.anyOf[0].properties.stepId.enum, [input.step.id]);
    return submission(input);
  } }).assess(input);
});

for (const Model of [OpenAICompatibleModel, ResponsesModel]) {
  for (const streaming of [false, true]) {
    for (const approved of [false, true]) {
      test(`${Model.name} preserves strict assessment and ${approved ? "approval" : "rejection"} via ${streaming ? "streaming" : "complete"}`, async () => {
        const input = assessmentInput();
        const failedBoundary = approved ? null : { stepId: input.step.id, missingEvidenceKinds: [],
          violatedSkillRequirements: [], reusableEvidenceRefs: ["candidateOutput"], suggestedRepairShape: "repair_leaf", evidenceConcerns: [] };
        const response = submission(input, undefined, failedBoundary);
        response.toolCalls[0]!.arguments.criteria[0]!.satisfied = approved;
        const args = response.toolCalls[0]!.arguments;
        const originalFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          const wireStreaming = streaming || Model === ResponsesModel;
          assert.equal(body.stream === true, wireStreaming);
          const tool = Model === ResponsesModel ? body.tools[0] : body.tools[0].function;
          const schema = tool.parameters;
          assert.equal(tool.strict, true);
          assertStrictObjects(schema);
          assert.deepEqual(schema.required, ["criteria", "skills", "feedback", "failedBoundary", "concernResolutions"]);
          assert.deepEqual(schema.properties.failedBoundary.anyOf[0].properties.stepId.enum, [input.step.id]);
          // Reproduce the provider's rejection at the original boundary. The
          // nullable object must arrive as anyOf, with its constraints intact.
          if (JSON.stringify(schema).includes('"type":["object","null"]')) {
            return new Response('{"error":{"message":"type arrays only support primitive types"}}', { status: 400 });
          }
          const payload = Model === ResponsesModel
            ? { status: "completed", output: [{ type: "function_call", call_id: "assessment", name: "submit_assessment", arguments: JSON.stringify(args) }] }
            : { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
                { id: "assessment", type: "function", function: { name: "submit_assessment", arguments: JSON.stringify(args) } },
              ] } }] };
          const text = !wireStreaming ? JSON.stringify(payload)
            : Model === ResponsesModel ? `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`
              : `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: { tool_calls: [
                  { index: 0, id: "assessment", type: "function", function: { name: "submit_assessment", arguments: JSON.stringify(args) } },
                ] } }] })}\n\ndata: [DONE]\n\n`;
          return new Response(text, { headers: { "content-type": wireStreaming ? "text/event-stream" : "application/json" } });
        };
        try {
          const model = new Model({ baseUrl: "https://models.example.test/v1", apiKey: "test-secret", model: "test-model",
            ...TEST_MODEL_LIMITS, maxAttempts: 1 });
          const adapter = streaming ? model : { limits: model.limits, complete: model.complete.bind(model) };
          const result = await new ModelStepAssessor(adapter).assess(input, undefined, streaming ? async () => undefined : undefined);
          assert.equal(calls, 1);
          assert.equal(result.approved, approved);
          assert.equal(result.criteria[0]!.satisfied, approved);
          assert.equal(result.failedBoundary?.stepId, approved ? undefined : input.step.id);
          if (!approved) assert.deepEqual(result.failedBoundary?.reusableEvidenceRefs, ["candidateOutput"]);
        } finally { globalThis.fetch = originalFetch; }
      });
    }
  }
}

test("assessment records an observed conflict separately from a hypothesis and binds only supplied evidence", async () => {
  const base = assessmentInput();
  const input: StepAssessmentInput = { ...base, evidence: { ...base.evidence, toolCalls: [
    { toolCallId: "detail", toolName: "read", isError: false, result: "daytime row", resultRef: { schema: "agentloop.resultRef/v1", resultId: "rr_detail" } },
    { toolCallId: "ranking", toolName: "query", isError: false, result: "ranking", resultRef: { schema: "agentloop.resultRef/v1", resultId: "rr_ranking" } },
  ] } };
  const concern = { observation: "A daytime row conflicts with the stated time window.", evidenceRefs: ["rr_detail"],
    hypothesis: "The source channel may have ignored the filter.", affectedEvidenceRefs: ["rr_ranking"] };
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
    const response = submission(input, undefined, { stepId: "response", missingEvidenceKinds: [], violatedSkillRequirements: [],
      reusableEvidenceRefs: ["rr_ranking"], suggestedRepairShape: "repair_leaf", evidenceConcerns: [concern] });
    response.toolCalls[0]!.arguments.criteria[0]!.satisfied = false;
    return response;
  } }).assess(input);
  assert.equal(result.approved, false);
  assert.deepEqual(result.failedBoundary?.evidenceConcerns, [concern]);

  let attempts = 0;
  await assert.rejects(new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
    attempts++;
    const response = submission(input, undefined, { stepId: "response", missingEvidenceKinds: [], violatedSkillRequirements: [],
      reusableEvidenceRefs: [], suggestedRepairShape: "repair_leaf", evidenceConcerns: [{ ...concern, evidenceRefs: ["invented"] }] });
    response.toolCalls[0]!.arguments.criteria[0]!.satisfied = false;
    return response;
  } }).assess(input));
  assert.equal(attempts, 3);
});

test("evidence concern status stays observable without vetoing a reply that matches the request", async () => {
  const base = assessmentInput();
  const concern = { observation: "A daytime row contradicts the claimed window.", evidenceRefs: ["rr_detail"],
    hypothesis: "The channel may have ignored the filter.", affectedEvidenceRefs: ["rr_ranking"] };
  const input: StepAssessmentInput = { ...base, canonicalState: { ...base.canonicalState, gaps: [{ id: "gap-1", stepId: "response",
    status: "open", missingEvidenceKinds: [], violatedSkillRequirements: [], evidenceRefs: ["rr_detail", "rr_ranking"],
    evidenceConcerns: [concern], suggestedAction: "repair_leaf", openedAt: 1 }] } };
  for (const status of ["unresolved", "resolved"] as const) {
    const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
      const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
      assert.deepEqual(context.assessmentGaps[0].evidenceConcerns, [concern]);
      const response = submission(input) as any;
      response.toolCalls[0].arguments.concernResolutions = [{ gapId: "gap-1", concernIndex: 0, status,
        rationale: status === "resolved" ? "The actual query conditions were checked." : "The shared query premise remains unverified.",
        evidenceRefs: ["rr_detail"] }];
      return response;
    } }).assess(input);
    assert.equal(result.approved, true);
    assert.equal(enforceAdmittedAssessment(input, result).approved, true);
    assert.equal(result.concernResolutions?.[0]?.status, status);
  }
});

test("assessment preserves the authoritative HIL subject instead of reinterpreting the ambiguous original request", async () => {
  const base = assessmentInput();
  const choice = createDecisionCommit({ requestId: "choose-subject", requestRevision: 1,
    planId: base.planId, stepId: base.step.id,
    selectedOptions: [{ id: "branch", label: "Selected branch", identityRefs: ["branch-id"] }] });
  const input: StepAssessmentInput = { ...base, decisionLedger: [choice] };
  let received = false;
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
    const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
    assert.deepEqual(context.userAuthority.decisionLedger, [choice]);
    assert.equal(context.userAuthority.originalUserInput, userInput);
    assert.match(request.systemPrompt, /reject a candidate merely for following that choice/);
    assert.match(context.userAuthority.instruction, /inferred example or optional field/);
    received = true;
    return submission(input);
  } }).assess(input);
  assert.equal(received, true);
  assert.equal(result.approved, true);
});

test("a replacement repair can cite two accepted choices to resolve missing-user-confirmation concerns", async () => {
  const base = assessmentInput();
  const selectedOptions = [{ id: "branch", label: "Selected branch", identityRefs: ["branch-code"] }];
  const decisions = ["first-choice", "confirmed-choice"].map(requestId => createDecisionCommit({
    requestId, requestRevision: 1, planId: base.planId, stepId: base.step.id, selectedOptions,
  }));
  const authority = buildUserAuthorityContext({ userInput: base.canonicalState.intent.userInput,
    intent: base.canonicalState.intent, decisionLedger: decisions,
    humanLoopAnswers: decisions.map((decision, index) => ({ responseId: `answer-${index}`, requestId: decision.requestId,
      requestRevision: 1, createdAt: index + 1, eventSeq: index * 2 + 1, planId: base.planId, stepId: base.step.id,
      question: { kind: "selection", title: "Choose subject", prompt: "Which subject should be queried?", responseType: "select" },
      value: ["branch"], selectedOptions,
    })),
  });
  const concern = { observation: "The supplied evidence does not contain the user's subject confirmation.",
    evidenceRefs: ["rr_search"], hypothesis: "The answer may have substituted a branch for the first search result.",
    affectedEvidenceRefs: ["rr_branch"] };
  const input: StepAssessmentInput = { ...base, userAuthority: authority,
    step: { ...base.step, id: `${base.step.id}.repair.1` },
    canonicalState: { ...base.canonicalState, gaps: [{ id: "subject-gap", stepId: base.step.id,
      repairScopeStepIds: [`${base.step.id}.repair.1`], status: "open", missingEvidenceKinds: [], violatedSkillRequirements: [],
      evidenceRefs: ["rr_search", "rr_branch"], evidenceConcerns: [concern], suggestedAction: "repair_leaf", openedAt: 1 }] },
  };
  for (const ref of [authority.humanLoopAnswers[1]!.responseId, decisions[1]!.requestId, decisions[1]!.id, "invented-answer"]) {
    let calls = 0;
    const assessment = new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
      calls++;
      const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
      assert.deepEqual(context.userAuthority.humanLoopAnswers.map((answer: any) => answer.value), [["branch"], ["branch"]]);
      const response = submission(input) as any;
      response.toolCalls[0].arguments.concernResolutions = [{ gapId: "subject-gap", concernIndex: 0, status: "resolved",
        rationale: "The persisted user responses twice select this branch; search order does not override them.", evidenceRefs: [ref] }];
      return response;
    } });
    if (ref === "invented-answer") {
      await assert.rejects(assessment.assess(input), /must cite supplied evidence/);
      assert.equal(calls, 3);
    } else {
      assert.equal((await assessment.assess(input)).approved, true);
      assert.equal(calls, 1);
    }
  }
  const unresolvedSourceInput: StepAssessmentInput = { ...input, canonicalState: { ...input.canonicalState,
    gaps: [{ ...input.canonicalState.gaps[0]!, evidenceConcerns: [concern, {
      observation: "The personnel endpoint rejected the request; personnel facts remain unverified.",
      evidenceRefs: ["rr_branch"], hypothesis: "", affectedEvidenceRefs: ["rr_branch"],
    }] }],
  } };
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
    const response = submission(unresolvedSourceInput) as any;
    response.toolCalls[0].arguments.concernResolutions = [
      { gapId: "subject-gap", concernIndex: 0, status: "resolved", rationale: "The user confirmed the branch.", evidenceRefs: ["answer-1"] },
      { gapId: "subject-gap", concernIndex: 1, status: "unresolved", rationale: "The selection does not prove personnel facts.", evidenceRefs: ["rr_branch"] },
    ];
    return response;
  } }).assess(unresolvedSourceInput);
  assert.equal(result.approved, true);
  assert.equal(result.concernResolutions?.[1]?.status, "unresolved");
});

test("unmet criteria do not become evidence concerns and retries expose the exact empty resolution contract", async () => {
  const base = assessmentInput();
  const input: StepAssessmentInput = { ...base, canonicalState: { ...base.canonicalState, gaps: [{
    id: "gap-unmet", stepId: base.step.id, status: "open", missingEvidenceKinds: [], violatedSkillRequirements: [],
    evidenceRefs: [], suggestedAction: "repair_leaf", openedAt: 1,
    unmetCriteria: [{ criterionId: "answered", status: "unverified", rationale: "Revise the answer", evidenceRefs: [] }],
  }] } };
  const events: RuntimeEvent[] = [];
  let calls = 0;
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
    calls++;
    const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
    assert.deepEqual(context.openEvidenceConcerns, []);
    const schema = request.tools[0]!.inputSchema as any;
    assert.equal(schema.properties.concernResolutions.minItems, 0);
    assert.equal(schema.properties.concernResolutions.maxItems, 0);
    const response = submission(input) as any;
    if (calls === 1) {
      response.toolCalls[0].arguments.concernResolutions = [{ gapId: "gap-unmet", concernIndex: 0,
        status: "resolved", rationale: "Wrongly resolving a criterion", evidenceRefs: [] }];
    } else {
      const repair = JSON.parse(request.runtimeContext!.content.match(/<runtime_directive>\n([^\n]+)\n/)![1]!).assessmentRepair;
      assert.equal(repair.validationDetails.expectedCount, 0);
      assert.equal(repair.validationDetails.actualCount, 1);
      assert.deepEqual(repair.validationDetails.expectedConcerns, []);
      assert.match(repair.validationDetails.instruction, /Return concernResolutions: \[\]/);
      response.toolCalls[0].arguments.concernResolutions = [];
    }
    return response;
  } }).assess(input, undefined, async event => { events.push(event); });
  assert.equal(calls, 2);
  assert.equal(result.approved, true);
  const rejection = events.find(event => event.type === "assessment.validation.rejected")!;
  assert.equal((rejection.data.validationDetails as any).actualCount, 1);
});

test("temporal gaps reach the model as facts for contextual judgment, not automatic rejection", async () => {
  for (const satisfied of [true, false]) {
    const input = { ...assessmentInput(), temporalEvidenceGap: "Unverified intervals: 313 milliseconds." };
    const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
      const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
      assert.equal(context.temporalEvidenceGap, input.temporalEvidenceGap);
      assert.equal(context.assessmentPolicy.boundary, "user_request_match");
      assert.equal(context.assessmentPolicy.temporalCoverage, undefined);
      const response = submission(input);
      response.toolCalls[0]!.arguments.criteria[0]!.satisfied = satisfied;
      return response;
    } }).assess(input);
    assert.equal(result.approved, satisfied);
  }
});

test("a JSON-encoded assessment is rejected with shape diagnostics and repaired as a root object", async () => {
  const input = assessmentInput();
  let calls = 0;
  const events: RuntimeEvent[] = [];
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
    calls += 1;
    if (calls === 1) {
      const valid = submission(input).toolCalls[0]!;
      return { content: "", finishReason: "tool_calls", toolCalls: [{
        ...valid,
        arguments: JSON.stringify(valid.arguments),
      }] };
    }
    const directive = request.runtimeContext!.content;
    assert.match(directive, /root JSON object/);
    assert.match(directive, /argumentShape/);
    assert.match(directive, /characters/);
    return submission(input);
  } }).assess(input, undefined, async (event) => { events.push(event); });

  assert.equal(calls, 2);
  assert.equal(result.approved, true);
  const rejected = events.find((event) => event.type === "assessment.validation.rejected")!;
  assert.deepEqual(rejected.data.argumentShape, { topLevelType: "string", characters: JSON.stringify(submission(input).toolCalls[0]!.arguments).length });
});

test("streamed assessment is internally visible while retaining telemetry and the structured judgment", async () => {
  const input = assessmentInput();
  const events: RuntimeEvent[] = [];
  const result = await new ModelStepAssessor({
    limits: TEST_MODEL_LIMITS,
    async complete() { throw new Error("streaming path expected"); },
    async streamComplete(request, sink) {
      assert.match(request.systemPrompt, /internal structured adjudication/);
      assert.match(request.systemPrompt, /do not repeat or paraphrase the candidate/i);
      await sink({ type: "reasoning_delta", text: "The candidate says the requested reply." });
      await sink({ type: "text_delta", text: "browser production smoke passed" });
      await sink({
        type: "tool_call_delta",
        index: 0,
        id: "assessment",
        name: "submit_assessment",
        argumentsDelta: '{"criteria":[]}',
      });
      const response = submission(input);
      const call = response.toolCalls[0]!;
      await sink({ type: "tool_call_ready", index: 0, ...call });
      return response;
    },
  }).assess(input, undefined, async (event) => { events.push(event); });

  assert.equal(result.approved, true);
  assert.equal(events.some((event) => event.type === "assistant.streaming"), false);
  assert.equal(events.some((event) => event.type === "assessment.turn.completed"), true);
  for (const event of events.filter((event) => event.type === "model.request.started" || event.type === "model.request.completed")) {
    assert.equal(event.data.responseVisibility, "internal");
  }
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

test("an unsupported extra condition preserves its reason without rejecting a matching reply", async () => {
  const input = assessmentInput();
  const reason = "A separate proof document is an execution method, not a necessary result condition.";
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() {
    return submission(input, { status: "invalid", rationale: reason });
  } }).assess(input);
  assert.equal(result.approved, true);
  assert.equal(result.criteria[0]!.satisfied, true);
  assert.equal(result.criteria[0]!.status, "satisfied");
  assert.equal(result.criteria[0]!.blocking, false);
  assert.equal(result.criteria[0]!.contractIssue, reason);
  assert.equal(result.failedBoundary, undefined);
  assert.equal(enforceAdmittedAssessment(input, result).approved, true);
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

for (const matches of [true, false]) {
  test(`capability reply matching=${matches} is judged against the question without an extra catalog-proof obligation`, async () => {
    const base = assessmentInput();
    const question = "你有什么能力？";
    const input: StepAssessmentInput = { ...base,
      canonicalState: createCanonicalRunState({ runId: base.runId, userInput: question,
        understanding: understandTask({ objective: "列出当前 Runtime 已授权且经过验证的全部能力" }), now: 1 }),
      step: { ...base.step, objective: "List independently verified run_authorized capabilities.",
        successCriteria: [...base.step.successCriteria, { id: "catalog-proof", source: "planner",
          description: "Supply a schema_summary proving every available capability.", blocking: true, verification: "model_judged" }],
      },
      evidence: { ...base.evidence, candidateOutput: matches
        ? "我可以帮你处理文档、表格、检索资料和分析数据。"
        : "今天的天气很好。" },
    };
    const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
      const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
      assert.equal(context.userAuthority.originalUserInput, question);
      assert.equal(context.runtimeCapabilitySnapshot, undefined);
      assert.equal(context.assessmentPolicy.boundary, "user_request_match");
      const response = submission(input);
      response.toolCalls[0]!.arguments.criteria[0]!.satisfied = matches;
      response.toolCalls[0]!.arguments.criteria[1]!.satisfied = false;
      response.toolCalls[0]!.arguments.criteria[1]!.contractCheck = {
        status: "invalid", rationale: "The user asked for a capability introduction, not an independent catalog proof.",
      };
      return response;
    } }).assess(input);
    assert.equal(result.approved, matches);
    assert.equal(enforceAdmittedAssessment(input, result).approved, matches);
    assert.equal(result.criteria[1]!.satisfied, false);
    assert.equal(result.criteria[1]!.blocking, false);
    assert.ok(result.criteria[1]!.contractIssue);
    assert.deepEqual(result.failedBoundary?.unmetCriteria?.map(criterion => criterion.criterionId), matches ? undefined : ["answered"]);
    assert.deepEqual(result.failedBoundary?.missingEvidenceKinds, matches ? undefined : []);
  });
}

test("the assessor sees the full long reply including the requested answer at the end", async () => {
  const base = assessmentInput();
  const candidateOutput = "背景说明。".repeat(700) + "\n最终答案：差额为20。";
  const input = { ...base, evidence: { ...base.evidence, candidateOutput } };
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete(request) {
    const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
    assert.equal(context.evidence.candidateOutput, candidateOutput);
    assert.ok(context.evidence.candidateOutput.endsWith("最终答案：差额为20。"));
    return submission(input);
  } }).assess(input);
  assert.equal(result.approved, true);
});

test("an explicit request for source verification stays a matching requirement", async () => {
  const base = assessmentInput();
  const question = "请提供有官方来源引用的结论。";
  const input: StepAssessmentInput = { ...base,
    canonicalState: createCanonicalRunState({ runId: base.runId, userInput: question,
      understanding: understandTask({ objective: question }), now: 1 }),
    step: { ...base.step, successCriteria: [{ id: "official-source", description: question, source: "task",
      blocking: true, verification: "model_judged" }] },
    evidence: { ...base.evidence, candidateOutput: "我没有查询官方资料，但结论应该如此。" },
  };
  const response = submission(input);
  response.toolCalls[0]!.arguments.criteria[0]!.satisfied = false;
  const result = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, async complete() { return response; } }).assess(input);
  assert.equal(result.approved, false);
  assert.equal(enforceAdmittedAssessment(input, result).approved, false);
  assert.deepEqual(result.failedBoundary?.unmetCriteria?.map(criterion => criterion.criterionId), ["official-source"]);
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

test("a matching reply reaches terminal delivery while an extra Plan proof stays an unsatisfied advisory", async () => {
  const database = new AppDatabase(":memory:");
  let assessmentCalls = 0;
  try {
    const runs = new RunService({ database, skills: new SkillService(database), tools: [],
      plannerFactory: () => ({ async plan(task) {
        const proposal = await singleStepTestPlanner().plan(task);
        return { ...proposal, steps: proposal.steps.map(step => ({ ...step,
          successCriteria: [...step.successCriteria.map(criterion => ({ ...criterion, verification: "model_judged" as const })),
            { id: "extra-proof", description: "Provide an independent written proof document.", source: "planner" as const,
              verification: "model_judged" as const, blocking: true }],
        })) };
      } }),
      recoveryPlannerFactory: () => ({ async decide() { throw new Error("An extra Plan obligation must not trigger Recovery"); } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, async complete(request) {
        if (request.phase !== "assessment") return { content: output, finishReason: "stop", toolCalls: [] };
        assessmentCalls++;
        const context = JSON.parse(request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)![1]!);
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "assess", name: "submit_assessment", arguments: {
          criteria: context.step.successCriteria.map((criterion: { id: string }) => ({ criterionId: criterion.id,
            satisfied: criterion.id !== "extra-proof",
            rationale: criterion.id === "extra-proof" ? "No separate proof was produced." : "The reply matches the user's exact request.",
            evidenceRefs: ["candidateOutput"], contractCheck: criterion.id === "extra-proof"
              ? { status: "invalid", rationale: "The user did not request a proof document." }
              : { status: "valid", rationale: "The exact reply is requested." },
          })), skills: [], concernResolutions: [], feedback: "The proof document is an extra Plan condition.", failedBoundary: null,
        } }] };
      } }),
    });
    const run = await runs.execute("owner", userInput);
    assert.equal(run.status, "completed");
    assert.equal(run.output, output);
    assert.equal(assessmentCalls, 1);
    const assessments = await database.prepare("SELECT approved, criteria_json FROM skill_compliance_assessments WHERE plan_id IN (SELECT id FROM plans WHERE run_id = ?)")
      .all<{ approved: number; criteria_json: string }>(run.id);
    assert.equal(assessments[0]!.approved, 1);
    const proof = JSON.parse(assessments[0]!.criteria_json).find((criterion: { criterionId: string }) => criterion.criterionId === "extra-proof");
    assert.equal(proof.satisfied, false);
    assert.equal(proof.blocking, false);
    assert.ok(proof.contractIssue);
    const events = await runs.events("owner", run.id);
    assert.equal(events.some(event => event.type === "terminal.delivery_committed"), true);
    assert.equal(events.some(event => event.type === "run.repairing"), false);
  } finally { await database.close(); }
});
