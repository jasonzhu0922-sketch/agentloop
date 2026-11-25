import assert from "node:assert/strict";
import test from "node:test";
import { buildRecoveryRevision } from "../src/planning/recovery-revision.ts";
import { admitPlan } from "../src/planning/admission.ts";
import { goalCriterionBasis } from "../src/planning/criterion-basis.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { ModelRecoveryPlanner, parseRecoveryDecision, recoveryContinuationStepIds, recoveryRevisionCorrection } from "../src/runtime/recovery-planning.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { createRuntimeResult, runtimeResultBindingsForStep, type RuntimeResultBinding } from "../src/runtime/runtime-result.ts";
import { RuntimeResultRepository } from "../src/runtime/runtime-result-repository.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppError } from "../src/shared/errors.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

function fixture() {
  const userInput = "Read the two recorded totals once and explain their difference.";
  const state = createCanonicalRunState({ runId: "retained-run", userInput,
    understanding: understandTask({ objective: userInput, resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1", operation: "analysis", requiresExecution: true,
      deliverables: [{ targetId: "answer", purpose: userInput, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
    } }) });
  const basis = goalCriterionBasis(state, ["answer"], "necessary_condition", "Both totals are needed for the requested comparison.");
  const plan = admitPlan({ runId: state.runId, canonicalState: state, availableSkills: [], availableToolNames: new Set(), proposal: {
    goal: userInput, selectedSkillIds: [], steps: [
      { id: "facts", role: "fact_acquisition", objective: "Record both supplied totals.", dependencies: [], skillIds: [], requiredCapabilities: [], targetIds: [],
        requiredFacts: [{ id: "both-totals", description: "The two totals, with exact source provenance.", evidenceKinds: ["source_summary"], basis }],
        successCriteria: [{ id: "facts-result", description: "Preserve the two totals and explicit caveats.", source: "planner", basis }] },
      { id: "answer", objective: "Explain the difference.", dependencies: ["facts"], skillIds: [], requiredCapabilities: ["conversation_delivery"], targetIds: ["answer"],
        successCriteria: [{ id: "comparison", description: "State the difference.", source: "task" }] },
    ],
  } });
  return { state, plan: { ...plan, steps: plan.steps.map(step => ({ ...step, status: step.id === "facts" ? "completed" as const : "failed" as const })) } };
}

function revision(goal: string) {
  return { goal, shape: "recovery_patch" as const, selectedSkillIds: [], retainedStepIds: ["facts"], steps: [{
    id: "answer.repair.2", objective: "Explain the difference using the accepted facts.", dependencies: ["facts"],
    skillIds: [], requiredCapabilities: ["conversation_delivery"], targetIds: ["answer"],
    successCriteria: [{ id: "comparison", description: "State the difference.", source: "task" as const }],
  }] };
}

test("recovery correction identifies the exact invalid revision field", () => {
  const { plan } = fixture();
  for (const [message, invalidField] of [
    ["Step repair has unknown parent retired", "planRevision.steps[].parentId"],
    ["retainedStepIds must not contain duplicates", "planRevision.retainedStepIds"],
    ["Step replacement failed must be unique", "planRevision.stepReplacements"],
    ["Existing Step failed must be referenced, not rewritten", "planRevision.steps[].id"],
    ["Plan dependency graph has a cycle", "planRevision.steps[].dependencies"],
  ]) assert.equal(recoveryRevisionCorrection(plan, undefined, message)?.invalidField, invalidField);
});

function call(planRevision: unknown) {
  return { id: "decision", name: "submit_recovery_decision", arguments: { actionId: "review", expectedActionRevision: 1,
    decision: "revise_plan", rationale: "Preserve facts and repair only the answer.", evidenceRefs: [], planRevision } };
}

test("a delivery Gap excludes independent and downstream replacement leaves from its repair scope", () => {
  const { plan } = fixture();
  const answer = plan.steps.find(step => step.id === "answer")!;
  const scoped = { ...answer, id: "answer-repair", dependencies: ["new-facts"] };
  const prerequisite = { ...answer, id: "new-facts", executionBinding: { ...answer.executionBinding, targetIds: [] }, dependencies: [] };
  const unrelated = { ...answer, id: "other-target", executionBinding: { ...answer.executionBinding, targetIds: ["other"] }, dependencies: [] };
  const downstream = { ...unrelated, id: "downstream", dependencies: [scoped.id] };
  const revised = { ...plan, steps: [prerequisite, scoped, unrelated, downstream] };
  assert.deepEqual(recoveryContinuationStepIds(plan, revised, { stepId: answer.id }), [prerequisite.id, scoped.id]);
});

test("recovery preserves authorized prior-round Result reads through two persisted revisions", async () => {
  const { state, plan } = fixture();
  const database = new AppDatabase(":memory:");
  try {
    await database.prepare("INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at) VALUES (?, 'owner', 0, 0, 'running', ?, 1)")
      .run(state.runId, state.intent.userInput);
    const repository = new PlanRepository(database);
    const previous = { ...plan, id: "prior-round", steps: [plan.steps[0]!] };
    await repository.create(previous);
    const result = createRuntimeResult({ kind: "step", producer: { runId: state.runId, planId: previous.id, stepId: "facts" },
      value: { totals: [80, 60] }, inputs: [], publication: { status: "published", assessmentRef: "prior-assessment", decision: "approved" } });
    await database.prepare("UPDATE plan_steps SET evidence_json = ? WHERE plan_id = ? AND step_id = 'facts'")
      .run(JSON.stringify({ publishedResult: result }), previous.id);
    const binding: RuntimeResultBinding = { schema: "agentloop.resultBinding/v1", result: result.ref, relation: "continue_prior" };
    await repository.create({ ...plan, resultBindings: [binding] });
    for (const [number, planId, status] of [[1, previous.id, "completed"], [2, plan.id, "executing"]] as const) {
      await database.prepare("INSERT INTO run_rounds(run_id, round_number, status, plan_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1)")
        .run(state.runId, number, status, planId);
    }
    await database.prepare("INSERT INTO run_round_results(run_id, round_number, plan_id, canonical_revision, result_json, created_at) VALUES (?, 1, ?, 1, ?, 1)")
      .run(state.runId, previous.id, JSON.stringify({ schema: "agentloop.roundResult/v1", runId: state.runId, planId: previous.id,
        steps: [{ stepId: "facts", result: result.ref, assessmentId: "prior-assessment" }] }));
    const results = new RuntimeResultRepository(database);
    let replacedId = "answer";
    for (const version of [2, 3]) {
      const current = await repository.get(plan.id);
      const proposal = revision(plan.goal);
      proposal.steps[0]!.id = `answer.repair.${version}`;
      const decision = parseRecoveryDecision(call(proposal), state, current);
      const admitted = admitPlan({ runId: state.runId, canonicalState: state, currentPlan: current, proposal: decision.planRevision!,
        availableSkills: [], availableToolNames: new Set(), resultBindings: [binding] });
      assert.deepEqual(admitted.resultBindings, [binding], "Inherited and explicitly supplied server bindings are deduplicated");
      // The real Recovery path supplies no new binding. It must inherit the
      // persisted input without asking the model to grant it again.
      const recovery = admitPlan({ runId: state.runId, canonicalState: state, currentPlan: current, proposal: decision.planRevision!,
        availableSkills: [], availableToolNames: new Set() });
      const action = await new RuntimeActionRepository(database).dispatch({ runId: state.runId, planId: plan.id, stepId: replacedId,
        kind: "planning", replayPolicy: "safe", deadlineMs: 1000 });
      const revised = await repository.revise({ planId: plan.id, proposal: recovery, retiredStepIds: [replacedId], reason: "repair", actionId: action.id });
      assert.deepEqual(revised.resultBindings, [binding]);
      assert.deepEqual(await results.readAuthorized({ resultId: result.ref.resultId, runId: state.runId, planId: plan.id,
        stepId: proposal.steps[0]!.id, actorUserId: "owner" }), result);
      assert.equal(await results.readAuthorized({ resultId: result.ref.resultId, runId: state.runId, planId: plan.id,
        stepId: proposal.steps[0]!.id, actorUserId: "foreign-owner" }), undefined);
      replacedId = proposal.steps[0]!.id;
    }
  } finally { database.close(); }
});

test("Recovery cannot inherit a different Run's Plan or accept model-authored Result bindings", () => {
  const { state, plan } = fixture();
  const binding: RuntimeResultBinding = { schema: "agentloop.resultBinding/v1", relation: "continue_prior",
    result: { schema: "agentloop.resultRef/v1", resultId: "rr_00000000-0000-0000-0000-000000000001" } };
  const proposal = { ...revision(plan.goal), resultBindings: [binding] };
  assert.equal(admitPlan({ runId: state.runId, canonicalState: state, currentPlan: plan, proposal,
    availableSkills: [], availableToolNames: new Set() }).resultBindings, undefined);
  assert.throws(() => admitPlan({ runId: state.runId, canonicalState: state, currentPlan: { ...plan, runId: "foreign-run", resultBindings: [binding] },
    proposal, availableSkills: [], availableToolNames: new Set() }), /Current Plan belongs to another Run/);
});

test("repair selects a committed tool Result without granting sibling leaves or another owner access", async () => {
  const { state, plan } = fixture();
  const database = new AppDatabase(":memory:");
  try {
    await database.prepare("INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at) VALUES (?, 'owner', 0, 0, 'running', ?, 1)")
      .run(state.runId, state.intent.userInput);
    const repository = new PlanRepository(database);
    await repository.create(plan);
    const actions = new RuntimeActionRepository(database);
    let result = createRuntimeResult({ kind: "tool", producer: { runId: state.runId }, value: {}, publication: { status: "committed" } });
    await actions.execute({ runId: state.runId, planId: plan.id, stepId: "answer", kind: "tool_call", replayPolicy: "safe", deadlineMs: 1000,
      metadata: { toolCallId: "query", toolName: "query_totals" }, prepareResult: async (value, action) => {
        result = createRuntimeResult({ kind: "tool", producer: { runId: state.runId, planId: plan.id, stepId: "answer",
          actionId: action.id, toolCallId: "query", toolName: "query_totals" }, value, publication: { status: "committed" } });
        return result;
      } }, async () => ({ totals: [80, 60] }));
    const results = new RuntimeResultRepository(database);
    assert.deepEqual(await results.listPlanResults({ runId: state.runId, planId: plan.id, actorUserId: "foreign" }), []);
    const available = await results.listPlanResults({ runId: state.runId, planId: plan.id, actorUserId: "owner" });
    assert.deepEqual(available.map(item => item.ref), [result.ref]);
    const proposal = revision(plan.goal);
    const selected = { ...proposal, steps: [{ ...proposal.steps[0], inputResultRefs: [result.ref] }] };
    assert.throws(() => admitPlan({ runId: state.runId, canonicalState: state, currentPlan: plan, proposal: selected,
      availableSkills: [], availableToolNames: new Set() }), /unavailable Runtime Result/);
    const decision = parseRecoveryDecision(call(selected), state, plan);
    const admitted = admitPlan({ runId: state.runId, canonicalState: state, currentPlan: plan, proposal: decision.planRevision!,
      availableResultRefs: available.map(item => item.ref), availableSkills: [], availableToolNames: new Set() });
    const action = await actions.dispatch({ runId: state.runId, planId: plan.id, stepId: "answer", kind: "planning", replayPolicy: "safe", deadlineMs: 1000 });
    await repository.revise({ planId: plan.id, proposal: admitted, retiredStepIds: ["answer"], reason: "Reuse query", actionId: action.id });
    // A fresh reader and hydrated Plan exercise restart, rather than in-memory authority.
    const reloaded = await repository.get(plan.id);
    const repair = reloaded.steps.find(step => step.id === "answer.repair.2")!;
    assert.deepEqual(repair.executionBinding.inputResultRefs, [result.ref]);
    assert.ok(runtimeResultBindingsForStep(reloaded, repair).some(binding => binding.result.resultId === result.ref.resultId && binding.relation === "dependency"));
    const reader = new RuntimeResultRepository(database);
    assert.deepEqual(await reader.readAuthorized({ resultId: result.ref.resultId, runId: state.runId, planId: plan.id,
      stepId: repair.id, actorUserId: "owner" }), result);
    for (const [stepId, actorUserId] of [["facts", "owner"], [repair.id, "foreign"]]) {
      assert.equal(await reader.readAuthorized({ resultId: result.ref.resultId, runId: state.runId, planId: plan.id, stepId, actorUserId }), undefined);
    }
    const nextProposal = { ...proposal, steps: [{ ...proposal.steps[0], id: "answer.repair.3", inputResultRefs: repair.inputResultRefs }] };
    const next = admitPlan({ runId: state.runId, canonicalState: state, currentPlan: reloaded, proposal: nextProposal,
      availableSkills: [], availableToolNames: new Set() });
    assert.deepEqual(next.steps.find(step => step.id === "answer.repair.3")!.executionBinding.inputResultRefs, [result.ref]);
  } finally { database.close(); }
});

for (const recoveryMode of ["direct", "planned"] as const) {
  test(`${recoveryMode} recovery reads the original query Result and delivers without querying again`, async () => {
    const database = new AppDatabase(":memory:");
    let queries = 0;
    let resultId = "";
    let reads = 0;
    try {
      const runs = new RunService({ database, skills: new SkillService(database), maxSteps: 5, plannerFactory: singleStepTestPlanner,
        tools: [{ name: "observe_total", description: "Observe a total", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
          parse: value => value, execute: async () => ({ total: 42, queries: ++queries }) }],
        assessorFactory: () => ({ assess: async input => {
          const base = await approvingTestAssessor().assess(input);
          if (input.step.id !== "test-step") return base;
          return { ...base, approved: false, criteria: base.criteria.map(item => ({ ...item, satisfied: false })), feedback: "Reuse the observed total and correct the answer.",
            failedBoundary: { stepId: input.step.id, missingEvidenceKinds: [], violatedSkillRequirements: [],
              reusableEvidenceRefs: ["original-query"], suggestedRepairShape: recoveryMode === "direct" ? "repair_leaf" as const : "revise_plan" as const } };
        } }),
        planRevisionAssessorFactory: () => ({ assess: async input => {
          const repair = input.proposal.steps.find(step => step.id !== "test-step")!;
          assert.deepEqual(repair.inputResultRefs, [{ schema: "agentloop.resultRef/v1", resultId }]);
          return { approved: true, feedback: "", evidenceRefs: [resultId] };
        } }),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          if (request.tools[0]?.name === "submit_recovery_decision") {
            const context = JSON.parse(request.runtimeContext!.content);
            const result = context.availableResults.find((result: any) => result.producer.toolCallId === "original-query");
            assert.equal(result.result.resultId, resultId);
            const failed = context.currentPlan.steps.find((step: any) => step.id === "test-step");
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "plan-repair", name: "submit_recovery_decision", arguments: {
              actionId: context.recoveryAction.id, expectedActionRevision: context.recoveryAction.revision, decision: "revise_plan", rationale: "Correct the answer using the existing observation.", evidenceRefs: [resultId],
              planRevision: { goal: context.currentPlan.goal, selectedSkillIds: [], retainedStepIds: [], steps: [{ id: "answer-repair", objective: failed.objective,
                dependencies: [], inputResultRefs: [result.result], requiredCapabilities: ["conversation_delivery"], skillIds: [], targetIds: failed.executionBinding.targetIds,
                successCriteria: [{ id: "answer", description: "State the observed total.", source: "task" }] }] },
            } }] };
          }
          const context = request.runtimeContext!.content;
          const frame = JSON.parse(context.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]);
          const stepId = frame.currentDecisionView.identity.stepId;
          if (queries === 0) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "original-query", name: "observe_total", arguments: {} }] };
          resultId ||= context.match(/"resultId":"(rr_[0-9a-f-]{36})"/)?.[1]
            ?? JSON.parse(request.messages.find(message => message.role === "tool" && message.name === "observe_total")!.content as string).resultRef.resultId;
          if (stepId === "test-step") return { content: "The total is incorrect.", finishReason: "stop", toolCalls: [] };
          if (reads === 0) {
            assert.equal(frame.currentDecisionView.nextAction, "read_bound_results");
            reads += 1;
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "consume-original", name: "read_result", arguments: { resultId } }] };
          }
          assert.ok(request.messages.some(message => message.role === "tool" && message.name === "read_result" && String(message.content).includes('42')));
          return { content: "The observed total is 42.", finishReason: "stop", toolCalls: [] };
        } }),
      });
      const run = await runs.execute("owner", "Read the total once and report it.");
      const events = await runs.events("owner", run.id);
      assert.equal(run.status, "completed", JSON.stringify(events.filter(event => /failed|rejected/.test(event.type))));
      assert.equal(queries, 1);
      assert.equal(reads, 1);
      const applied = events.find(event => event.type === "recovery.plan_revision_applied")!;
      assert.deepEqual((applied.data.inputResultBindings as any[])[0].resultRefs, [{ schema: "agentloop.resultRef/v1", resultId }]);
      const plan = await new PlanRepository(database).getByRun(run.id);
      const published = plan.steps.find(step => step.retiredAt === undefined)!.evidence!.publishedResult!;
      assert.ok(published.inputs.some(ref => ref.resultId === resultId));
      assert.equal(events.filter(event => event.type === "run.completed").length, 1);
    } finally { database.close(); }
  });
}

test("recovery retains the exact persisted definition, criteria, provenance and completed evidence", async () => {
  const { state, plan } = fixture();
  const database = new AppDatabase(":memory:");
  try {
    await database.prepare("INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at) VALUES (?, 'owner', 0, 0, 'running', ?, 1)").run(state.runId, state.intent.userInput);
    const repository = new PlanRepository(database);
    await repository.create(plan);
    await database.prepare("UPDATE plan_steps SET output = ?, evidence_json = ?, started_at = 2, finished_at = 3 WHERE plan_id = ? AND step_id = 'facts'")
      .run("totals=80,60", JSON.stringify({ candidateOutput: "totals=80,60", toolCalls: [], modelSteps: 1 }), plan.id);
    const current = await repository.get(plan.id);
    const before = await database.prepare("SELECT * FROM plan_steps WHERE plan_id = ? AND step_id = 'facts'").get(plan.id);
    const decision = parseRecoveryDecision(call(revision(plan.goal)), state, current);
    const admitted = admitPlan({ runId: state.runId, canonicalState: state, proposal: decision.planRevision!, currentPlan: current,
      availableSkills: [], availableToolNames: new Set() });
    assert.deepEqual(admitted.steps[0], current.steps[0]);
    const action = await new RuntimeActionRepository(database).dispatch({ runId: state.runId, planId: plan.id, stepId: "answer",
      kind: "planning", replayPolicy: "safe", deadlineMs: 1000 });
    await repository.revise({ planId: plan.id, proposal: admitted, retiredStepIds: ["answer"], reason: decision.rationale, actionId: action.id });
    assert.deepEqual(await database.prepare("SELECT * FROM plan_steps WHERE plan_id = ? AND step_id = 'facts'").get(plan.id), before);
    const revised = await repository.get(plan.id);
    assert.ok(revised.steps.find(step => step.id === "answer")!.retiredAt);
    assert.equal(revised.steps.find(step => step.id === "answer.repair.2")!.status, "pending");
  } finally { database.close(); }
});

test("a preservation claim cannot rewrite or omit completed Steps, reference foreign Steps, or bypass Admission", () => {
  const { state, plan } = fixture();
  const valid = revision(plan.goal);
  for (const proposed of [
    { ...valid, retainedStepIds: [], steps: [{ ...valid.steps[0], id: "facts", objective: "Changed facts." }] },
    { ...valid, retainedStepIds: [] },
    { ...valid, retainedStepIds: ["foreign"] },
    { ...valid, retainedStepIds: ["facts", "facts"] },
  ]) assert.throws(() => parseRecoveryDecision(call(proposed), state, plan), /Existing Step|Completed Step|unknown or retired|unique|duplicates/);
  assert.throws(() => admitPlan({ runId: state.runId, canonicalState: state, currentPlan: plan,
    proposal: { ...valid, steps: [{ ...plan.steps[0], objective: "Changed facts." }, ...valid.steps] },
    availableSkills: [], availableToolNames: new Set() }), /Existing Step facts must be retained by reference/);
  assert.throws(() => admitPlan({ runId: state.runId, canonicalState: state, proposal: valid,
    availableSkills: [], availableToolNames: new Set() }), /persisted current Plan/);
});

test("the model exposes the rejected preservation proposal to the Runtime coordinator without hidden retries", async () => {
  const { state, plan } = fixture();
  let attempts = 0;
  const planner = new ModelRecoveryPlanner({ limits: TEST_MODEL_LIMITS, complete: async () => {
    attempts++;
    const proposed = revision(plan.goal);
    proposed.steps.unshift({ ...proposed.steps[0], id: "facts", objective: "Rewritten prerequisite.", dependencies: [] });
    return { content: "", finishReason: "tool_calls", toolCalls: [call(proposed)] };
  } });
  await assert.rejects(planner.decide({ runId: state.runId, userInput: state.intent.userInput, canonicalState: state, plan, events: [], userResponses: [],
    action: { id: "review", runId: state.runId, kind: "recovery_review", state: "recovery_required", replayPolicy: "safe", effectState: "not_started",
      attempt: 1, maxAttempts: 3, revision: 1, fence: 1, metadata: {}, createdAt: 1, updatedAt: 1 } }),
    (error: unknown) => error instanceof AppError && /Existing Step facts must be referenced/.test(error.message)
      && error.details?.recoveryStage === "parse" && error.details?.rejectedProposal !== undefined);
  assert.equal(attempts, 1);
});

test("revised production recovers to completion without rerunning its accepted prerequisite", async () => {
  const database = new AppDatabase(":memory:");
  let reads = 0;
  let recoveries = 0;
  let candidateTurns = 0;
  let storedFacts: unknown;
  let dependencyResultId = "";
  try {
    const runs = new RunService({ database, skills: new SkillService(database), maxSteps: 6,
      plannerFactory: () => ({ plan: async task => ({ goal: task.canonicalState.intent.userInput, selectedSkillIds: [], steps: [
        { id: "facts", objective: "Acquire the two totals once and publish them.", role: "fact_acquisition", dependencies: [], targetIds: [],
          skillIds: [], requiredCapabilities: ["totals.observe"], evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "none" },
          successCriteria: [{ id: "observed", description: "Publish the two observed totals.", source: "planner" }] },
        { id: "answer", objective: "Explain the difference from the accepted source Result.", dependencies: ["facts"],
          skillIds: [], requiredCapabilities: ["conversation_delivery"],
          targetIds: Object.keys(task.canonicalState.targets), successCriteria: [{ id: "comparison", description: "State the difference.", source: "task" }] },
      ] }) }),
      tools: [{ name: "observe_totals", description: "Read totals", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
        source: { id: "totals", transport: "api", capabilities: [{ id: "totals.observe", category: "source_acquisition", sourceKinds: ["api"], producesEvidenceKinds: ["source_summary"] }] },
        parse: value => value, execute: async () => ({ values: [80, 60], queryNumber: ++reads,
          evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } } }) }],
      assessorFactory: () => ({ assess: async input => {
        const base = await approvingTestAssessor().assess(input);
        if (input.step.id !== "answer") return base;
        return { ...base, approved: false, criteria: base.criteria.map(criterion => ({ ...criterion, satisfied: false })),
          feedback: "The answer is missing; reuse the completed source Result.", failedBoundary: { stepId: "answer", missingEvidenceKinds: [],
            violatedSkillRequirements: [], reusableEvidenceRefs: [dependencyResultId], suggestedRepairShape: "revise_plan" as const } };
      } }),
      recoveryPlannerFactory: model => ({ decide: async input => {
        storedFacts = await database.prepare("SELECT * FROM plan_steps WHERE plan_id = ? AND step_id = 'facts'").get(input.plan!.id);
        return new ModelRecoveryPlanner(model).decide(input);
      } }),
      planRevisionAssessorFactory: () => ({ assess: async input => {
        assert.deepEqual(input.proposal.steps.map(step => step.id), ["facts", "answer.repair.2"]);
        const facts = input.proposal.steps[0];
        assert.deepEqual(facts, input.currentPlan.steps.find(step => step.id === "facts"));
        return { approved: true, feedback: "", evidenceRefs: [] };
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.tools[0]?.name === "submit_recovery_decision") {
          recoveries += 1;
          const context = JSON.parse(request.runtimeContext!.content);
          const failed = context.currentPlan.steps.find((step: { id: string }) => step.id === "answer");
          const proposed = { ...revision(context.currentPlan.goal), steps: [{ ...revision(context.currentPlan.goal).steps[0], targetIds: failed.executionBinding.targetIds }] };
          if (recoveries === 1) proposed.steps.unshift({ ...proposed.steps[0], id: "facts", objective: "Rewrite the completed definition.", dependencies: [] });
          return { content: "", finishReason: "tool_calls", toolCalls: [{ ...call(proposed), arguments: {
            ...call(proposed).arguments, actionId: context.recoveryAction.id, expectedActionRevision: context.recoveryAction.revision,
            evidenceRefs: [dependencyResultId],
          } }] };
        }
        const context = request.runtimeContext?.content ?? "";
        const frame = JSON.parse(context.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]);
        const stepId = frame.currentDecisionView.identity.stepId;
        if (stepId === "facts") {
          if (reads === 0) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "observe", name: "observe_totals", arguments: {} }] };
          return { content: "Observed totals: 80 and 60.", finishReason: "stop", toolCalls: [] };
        }
        dependencyResultId ||= context.match(/"resultId":"(rr_[0-9a-f-]{36})"/)![1];
        if (!request.messages.some(message => message.role === "tool" && message.name === "read_result")) {
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `consume-${stepId}`, name: "read_result", arguments: { resultId: dependencyResultId } }] };
        }
        if (stepId === "answer") {
          candidateTurns += 1;
          return { content: candidateTurns === 1 ? '<runtime_evidence_record source="server">internal receipt</runtime_evidence_record>' : "Result missing.", finishReason: "stop", toolCalls: [] };
        }
        return { content: "The difference is 20 (80 minus 60).", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.execute("owner", "Read the two totals once and explain their difference.");
    const events = await runs.events("owner", run.id);
    assert.equal(run.status, "completed", JSON.stringify(events.filter(event => /failed|rejected/.test(event.type))));
    assert.equal(reads, 1);
    assert.equal(recoveries, 2);
    const plan = await new PlanRepository(database).getByRun(run.id);
    assert.deepEqual(await database.prepare("SELECT * FROM plan_steps WHERE plan_id = ? AND step_id = 'facts'").get(plan.id), storedFacts);
    assert.equal(events.filter(event => event.type === "plan.step.started" && event.data.stepId === "facts").length, 1);
    assert.equal(events.filter(event => event.type === "recovery.decision_admitted").length, 1);
    const applied = events.find(event => event.type === "recovery.plan_revision_applied")!;
    assert.deepEqual(applied.data.retainedStepIds, ["facts"]);
    assert.deepEqual(applied.data.createdStepIds, ["answer.repair.2"]);
    assert.deepEqual(applied.data.retiredStepIds, ["answer"]);
    assert.equal(events.some(event => event.type === "run.failed"), false);
  } finally { database.close(); }
});

test("explicit replacements rewire unfinished dependents while preserving contracts and immutable completed facts", () => {
  const { state, plan } = fixture();
  const old = { ...plan, steps: plan.steps.map(step => ({ ...step,
    status: step.id === "facts" ? "failed" as const : "pending" as const })) };
  const facts = old.steps[0]!;
  const proposal = {
    goal: plan.goal, shape: "recovery_patch" as const, selectedSkillIds: [], retainedStepIds: ["answer"],
    stepReplacements: [{ stepId: "facts", replacementStepId: "facts-fixed" }],
    steps: [{ id: "facts-fixed", objective: facts.objective, dependencies: [], skillIds: [], requiredCapabilities: [],
      targetIds: [], successCriteria: [{ id: "facts", description: "Publish the supplied totals.", source: "task" as const }] }],
  };
  const expanded = buildRecoveryRevision(proposal, old);
  assert.deepEqual(expanded.retainedStepIds, []);
  const dependent = expanded.steps.find(step => step.id === "answer.revision.2")!;
  assert.deepEqual(dependent.dependencies, ["facts-fixed"]);
  assert.equal(dependent.objective, plan.steps[1]!.objective);
  assert.deepEqual(dependent.targetIds, plan.steps[1]!.executionBinding.targetIds);
  assert.deepEqual(dependent.successCriteria.map(c => c.id), ["comparison"]);
  const admitted = admitPlan({ runId: state.runId, canonicalState: state, currentPlan: old,
    proposal: expanded, availableSkills: [], availableToolNames: new Set() });
  assert.ok(admitted.steps.some(step => step.id === dependent.id));
  assert.throws(() => buildRecoveryRevision(proposal, plan), /Cannot replace completed/);
  assert.throws(() => buildRecoveryRevision({ ...proposal, stepReplacements: [proposal.stepReplacements[0]!, proposal.stepReplacements[0]!] }, old), /must be unique/);
  assert.throws(() => buildRecoveryRevision({ ...proposal, retainedStepIds: ["answer", "answer"] }, old), /must be unique/);
  // Without an explicit replacement declaration, Runtime never silently renames or rewrites a retained Step.
  assert.deepEqual(buildRecoveryRevision({ ...proposal, stepReplacements: [] }, old).retainedStepIds, ["answer"]);
});

test("repair provenance never becomes parentId while an active milestone ancestor remains legal", () => {
  const { state, plan } = fixture();
  const milestone = { ...plan.steps[1]!, id: "delivery-stage", kind: "milestone" as const, parentId: undefined,
    dependencies: [], status: "pending" as const, refinementState: "ready_to_refine" as const,
    requiredCapabilities: [], executionBinding: { ...plan.steps[1]!.executionBinding, requiredCapabilities: [], targetIds: [] } };
  const failed = { ...plan.steps[1]!, id: "delivery-leaf", parentId: milestone.id, dependencies: ["facts"], status: "failed" as const };
  const current = { ...plan, steps: [plan.steps[0]!, milestone, failed, { ...plan.steps[1]!, id: "retired-origin", retiredAt: 2, status: "failed" as const }] };
  const base = { goal: plan.goal, shape: "recovery_patch" as const, selectedSkillIds: [], retainedStepIds: ["facts", milestone.id],
    stepReplacements: [{ stepId: failed.id, replacementStepId: "delivery-leaf.repair.2" }],
    steps: [{ id: "delivery-leaf.repair.2", kind: "leaf" as const, parentId: milestone.id, objective: failed.objective,
      dependencies: ["facts"], skillIds: [], requiredCapabilities: ["conversation_delivery"], targetIds: ["answer"],
      successCriteria: [{ id: "comparison", description: "State the difference.", source: "task" as const }] }] };
  const admitted = admitPlan({ runId: state.runId, canonicalState: state, currentPlan: current,
    proposal: buildRecoveryRevision(base, current), availableSkills: [], availableToolNames: new Set() });
  assert.equal(admitted.steps.find(step => step.id === "delivery-leaf.repair.2")!.parentId, milestone.id);
  for (const invalid of [
    { ...base, steps: [{ ...base.steps[0]!, parentId: "retired-origin" }] },
    { ...base, steps: [{ ...base.steps[0]!, parentId: "facts" }] },
  ]) assert.throws(() => admitPlan({ runId: state.runId, canonicalState: state, currentPlan: current,
    proposal: buildRecoveryRevision(invalid, current), availableSkills: [], availableToolNames: new Set() }), /unknown parent|must be a milestone/);
});
