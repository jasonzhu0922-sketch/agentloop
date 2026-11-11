import assert from "node:assert/strict";
import test from "node:test";
import { admitPlan } from "../src/planning/admission.ts";
import { goalCriterionBasis } from "../src/planning/criterion-basis.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { ModelRecoveryPlanner, parseRecoveryDecision } from "../src/runtime/recovery-planning.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

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

function call(planRevision: unknown) {
  return { id: "decision", name: "submit_recovery_decision", arguments: { actionId: "review", expectedActionRevision: 1,
    decision: "revise_plan", rationale: "Preserve facts and repair only the answer.", evidenceRefs: [], planRevision } };
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

test("the model receives the exact preservation-contract rejection and corrects its structured decision", async () => {
  const { state, plan } = fixture();
  let attempts = 0;
  const decision = await new ModelRecoveryPlanner({ limits: TEST_MODEL_LIMITS, complete: async request => {
    attempts += 1;
    if (attempts === 2) assert.match(request.systemPrompt, /Existing Step facts must be referenced in retainedStepIds/);
    const proposed = revision(plan.goal);
    // Same failure as 46f2632a: rationale claims preservation, definition changes.
    if (attempts === 1) proposed.steps.unshift({ ...proposed.steps[0], id: "facts", objective: "Rewritten prerequisite.", dependencies: [] });
    return { content: "", finishReason: "tool_calls", toolCalls: [call(proposed)] };
  } }).decide({ runId: state.runId, userInput: state.intent.userInput, canonicalState: state, plan, events: [], userResponses: [],
    action: { id: "review", runId: state.runId, kind: "recovery_review", state: "recovery_required", replayPolicy: "safe", effectState: "not_started",
      attempt: 1, maxAttempts: 3, revision: 1, fence: 1, metadata: {}, createdAt: 1, updatedAt: 1 } });
  assert.equal(attempts, 2);
  assert.deepEqual(decision.planRevision!.retainedStepIds, ["facts"]);
  assert.deepEqual(decision.planRevision!.steps.map(step => step.id), ["answer.repair.2"]);
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
