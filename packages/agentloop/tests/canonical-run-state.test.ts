import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { RunRepository } from "../src/storage/repositories/run-repository.ts";
import { RunOutcomeRepository } from "../src/storage/repositories/outcome-repository.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import {
  bindCanonicalPlan,
  commitCanonicalTerminal,
  createCanonicalRunState,
  markCanonicalReadyForTerminal,
  recordCanonicalAssessment,
  recordCanonicalStepResult,
  reviseCanonicalPlan,
  startCanonicalStep,
} from "../src/runtime/canonical-run-state.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import { StepResultCommitter } from "../src/runtime/step-result-committer.ts";
import { TerminalCommitter } from "../src/runtime/terminal-committer.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import type { ExecutionPlan, SkillComplianceAssessment, StepEvidence } from "../src/planning/contracts.ts";

function understanding() {
  return understandTask({
    objective: "基于上传资料生成中文 PPTX，并保留无法核验的信息",
    userConstraints: ["中文", "不得编造"],
    toolNames: ["computer_write_file", "verify_artifact_acceptance"],
    evidenceDemand: "strict_user_source",
  });
}

function planFor(state: ReturnType<typeof createCanonicalRunState>): ExecutionPlan {
  return {
    id: "plan-1",
    runId: state.runId,
    version: 1,
    goal: "生成 PPTX",
    selectedSkillIds: [],
    canonicalStateRef: {
      stateId: state.stateId,
      runId: state.runId,
      intentId: state.intent.id,
      revision: state.revision,
    },
    resultBindings: [],
    status: "admitted",
    steps: [{
      id: "produce",
      kind: "leaf",
      position: 0,
      objective: "生成并验收产物",
      dependencies: [],
      role: "produce",
      refinementState: "not_refinable",
      requiredFacts: [],
      skillIds: [],
      requiredCapabilities: ["artifact_build"],
      executionBinding: {
        schema: "agentloop.stepExecutionBinding/v1",
        requiredCapabilities: ["artifact_build"],
        resolvedToolNames: ["computer_write_file", "verify_artifact_acceptance"],
        evidenceProducers: [],
        sourceKinds: ["generated_artifact"],
        sideEffect: "workspace_write",
        evidenceKinds: ["artifact_path", "artifact_acceptance"],
        targetIds: [],
      },
      evidenceContract: { requiredKinds: ["artifact_path", "artifact_acceptance"], caveatPolicy: "mark_unverified_facts" },
      successCriteria: [{ id: "artifact_acceptance", description: "产物通过验收", source: "task" }],
      status: "pending",
    }],
    createdAt: 1,
    updatedAt: 1,
  };
}

function evidence(): StepEvidence {
  return {
    candidateOutput: "已生成",
    toolCalls: [{
      toolCallId: "tool-1",
      toolName: "computer_write_file",
      isError: false,
      result: "ok",
      resultRef: { schema: "agentloop.resultRef/v1", resultId: "rr_00000000-0000-4000-8000-000000000001" },
    }],
    modelSteps: 2,
  };
}

function analysisUnderstanding() {
  return understandTask({
    objective: "查询表结构并分析数据分布",
    evidenceDemand: "source_grounded",
    resolvedTaskIntent: {
      schema: "agentloop.conversationTaskIntent/v1",
      operation: "analysis",
      requiresExecution: true,
      deliverables: [
        { targetId: "table-structure", purpose: "展示表结构", expectedArtifactCount: 1, action: "create", kind: "none", format: "text", surface: "conversation" },
        { targetId: "data-distribution-analysis", purpose: "展示数据分布分析", expectedArtifactCount: 1, action: "create", kind: "none", format: "text", surface: "conversation" },
      ],
    },
  });
}

function analysisEvidence(claimedTargetIds: readonly string[]): StepEvidence {
  return {
    candidateOutput: "已返回表结构和总行数；字段分布尚未完成。",
    deliveryCandidate: {
      schema: "agentloop.runtimeDeliveryCandidate/v1",
      output: "已返回表结构和总行数；字段分布尚未完成。",
      caveats: ["字段分布尚未完成"],
      evidenceKinds: { satisfied: ["source_summary"], caveated: ["explicit_caveats"], failed: [] },
      sourceToolCallIds: ["query-schema", "query-count"],
      deliveryClaims: claimedTargetIds.map((targetId) => ({ targetId, evidenceRefs: ["query-schema", "query-count"] })),
    },
    toolCalls: [],
    modelSteps: 2,
  };
}

function assessment(approved: boolean): SkillComplianceAssessment {
  return {
    id: approved ? "assessment-ok" : "assessment-gap",
    planId: "plan-1",
    stepId: "produce",
    attempt: approved ? 2 : 1,
    approved,
    criteria: [],
    skills: [],
    evidenceDigest: "digest",
    feedback: approved ? "ok" : "missing acceptance",
    ...(!approved ? {
      failedBoundary: {
        stepId: "produce",
        missingEvidenceKinds: ["artifact_acceptance"],
        violatedSkillRequirements: [],
        reusableEvidenceRefs: ["tool-1"],
        suggestedRepairShape: "repair_leaf" as const,
      },
    } : {}),
    createdAt: approved ? 5 : 4,
  };
}

test("canonical Run state preserves intent identity while evidence, gap, and terminal progress advance", () => {
  const initial = createCanonicalRunState({ runId: "run-1", userInput: "生成中文 PPTX", understanding: understanding(), now: 1 });
  const planned = bindCanonicalPlan(initial, planFor(initial), 2);
  const running = startCanonicalStep(planned, "produce", 3);
  const rejected = recordCanonicalAssessment(running, assessment(false), evidence(), 4);

  assert.equal(rejected.intent.id, initial.intent.id);
  assert.equal(rejected.intent.understanding, initial.intent.understanding);
  assert.equal(rejected.steps.produce?.status, "repairable");
  assert.deepEqual(rejected.gaps[0]?.missingEvidenceKinds, ["artifact_acceptance"]);
  assert.deepEqual([...(rejected.gaps[0]?.evidenceRefs ?? [])].sort(), ["rr_00000000-0000-4000-8000-000000000001", "tool-1"]);

  const approved = recordCanonicalAssessment(rejected, assessment(true), evidence(), 5);
  const published = recordCanonicalStepResult(approved, "produce", evidence(), 6);
  const ready = markCanonicalReadyForTerminal(published, 7);
  const completed = commitCanonicalTerminal(ready, { status: "completed", reasonCode: "plan_assessed_and_completed" }, 8);

  assert.equal(completed.phase, "completed");
  assert.equal(completed.intent.id, initial.intent.id);
  assert.equal(completed.intent.userInput, "生成中文 PPTX");
  assert.equal(completed.gaps[0]?.status, "resolved");
  assert.equal(completed.revision, 8);
});

test("canonical Run state repository rejects a stale writer", async () => {
  const database = new AppDatabase(":memory:");
  await database.ready();
  const runs = new RunRepository(database);
  await runs.insertRun({ id: "run-cas", ownerUserId: "user-1", allowDangerousTools: false, input: "test", createdAt: 1 });
  const states = new CanonicalRunStateRepository(database);
  const initial = await states.create(createCanonicalRunState({ runId: "run-cas", userInput: "生成中文 PPTX", understanding: understanding(), now: 1 }));
  const next = bindCanonicalPlan(initial, planFor({ ...initial, runId: "run-cas" }), 2);
  await states.commit({ expectedRevision: initial.revision, state: next, reason: "plan_admitted" });

  await assert.rejects(
    states.commit({ expectedRevision: initial.revision, state: next, reason: "stale" }),
    /revision is stale/,
  );
  await database.close();
});

test("canonical delivery targets remain open until their own claims are accepted", () => {
  const initial = createCanonicalRunState({
    runId: "run-targets",
    userInput: "查询表结构并分析数据分布",
    understanding: analysisUnderstanding(),
    now: 1,
  });
  const base = planFor(initial);
  const plan: ExecutionPlan = {
    ...base,
    steps: [{
      ...base.steps[0]!,
      executionBinding: {
        ...base.steps[0]!.executionBinding,
        targetIds: ["table-structure", "data-distribution-analysis"],
      },
      successCriteria: [
        { id: "delivery_target:table-structure", targetId: "table-structure", description: "展示表结构", source: "task", verification: "model_judged", blocking: true },
        { id: "delivery_target:data-distribution-analysis", targetId: "data-distribution-analysis", description: "展示数据分布分析", source: "task", verification: "model_judged", blocking: true },
      ],
    }],
  };
  const planned = bindCanonicalPlan(initial, plan, 2);
  const running = startCanonicalStep(planned, "produce", 3);
  const partial = recordCanonicalAssessment(running, {
    ...assessment(false),
    criteria: [
      { criterionId: "delivery_target:table-structure", targetId: "table-structure", satisfied: true, blocking: true, rationale: "结构已交付", evidenceRefs: ["query-schema"] },
      { criterionId: "delivery_target:data-distribution-analysis", targetId: "data-distribution-analysis", satisfied: false, blocking: true, rationale: "只有总行数，没有字段分布", evidenceRefs: ["query-count"] },
    ],
    failedBoundary: {
      stepId: "produce",
      missingEvidenceKinds: ["delivery_target:data-distribution-analysis"],
      violatedSkillRequirements: [],
      reusableEvidenceRefs: ["query-schema", "query-count"],
      suggestedRepairShape: "repair_leaf",
    },
  }, analysisEvidence(["table-structure"]), 4);

  assert.equal(partial.targets["table-structure"]?.status, "accepted");
  assert.equal(partial.targets["data-distribution-analysis"]?.status, "open");
  assert.equal(partial.gaps.find((gap) => gap.targetId === "table-structure")?.status, "resolved");
  assert.equal(partial.gaps.find((gap) => gap.targetId === "data-distribution-analysis")?.status, "open");
  assert.throws(() => markCanonicalReadyForTerminal(partial, 5), /before every Step is satisfied|open GoalGaps/);
});

test("canonical Plan revision retires the failed Step without discarding its evidence or bypassing the repair Step", () => {
  const initial = createCanonicalRunState({ runId: "run-repair", userInput: "生成中文 PPTX", understanding: understanding(), now: 1 });
  const original = planFor({ ...initial, runId: "run-repair" });
  const planned = bindCanonicalPlan(initial, original, 2);
  const running = startCanonicalStep(planned, "produce", 3);
  const rejected = recordCanonicalAssessment(running, assessment(false), evidence(), 4);
  const revisedPlan: ExecutionPlan = {
    ...original,
    version: 2,
    steps: [
      { ...original.steps[0]!, retiredAt: 5 },
      {
        ...original.steps[0]!,
        id: "produce.repair.1",
        position: 1,
        role: "repair",
        status: "pending",
      },
    ],
  };

  const revised = reviseCanonicalPlan(rejected, revisedPlan, 5);
  assert.equal(revised.steps.produce?.status, "retired");
  assert.deepEqual(revised.steps.produce?.evidenceRefs, rejected.steps.produce?.evidenceRefs);
  assert.equal(revised.gaps[0]?.status, "resolved");
  assert.equal(revised.steps["produce.repair.1"]?.status, "pending");
  assert.throws(() => markCanonicalReadyForTerminal(revised, 6), /before every Step is satisfied/);

  const repairRunning = startCanonicalStep(revised, "produce.repair.1", 6);
  const repairAssessment = { ...assessment(true), id: "repair-assessment", stepId: "produce.repair.1" };
  const repairApproved = recordCanonicalAssessment(repairRunning, repairAssessment, evidence(), 7);
  const repairPublished = recordCanonicalStepResult(repairApproved, "produce.repair.1", evidence(), 8);
  assert.equal(markCanonicalReadyForTerminal(repairPublished, 9).phase, "ready_for_terminal");
});

test("terminal Outcome failure rolls back the canonical terminal mutation", async () => {
  const database = new AppDatabase(":memory:");
  await database.ready();
  const runs = new RunRepository(database);
  await runs.insertRun({ id: "run-terminal-atomic", ownerUserId: "user-1", allowDangerousTools: false, input: "test", createdAt: 1 });
  const states = new CanonicalRunStateRepository(database);
  const plans = new PlanRepository(database);
  let state = await states.create(createCanonicalRunState({ runId: "run-terminal-atomic", userInput: "生成中文 PPTX", understanding: understanding(), now: 1 }));
  let plan = await plans.create(planFor(state));
  state = await states.commit({
    expectedRevision: state.revision,
    state: bindCanonicalPlan(state, plan, 2),
    reason: "plan_admitted",
  });
  plan = await plans.startStep(plan.id, "produce");
  state = await states.commit({
    expectedRevision: state.revision,
    state: startCanonicalStep(state, "produce", 3),
    reason: "step_started",
  });
  const approved = assessment(true);
  await plans.saveAssessment(approved);
  state = await states.commit({
    expectedRevision: state.revision,
    state: recordCanonicalAssessment(state, approved, evidence(), 4),
    reason: "step_assessment_approved",
  });
  const publication = await new StepResultCommitter(plans).commit({
    runId: state.runId,
    plan,
    step: plan.steps[0]!,
    evidence: evidence(),
  });
  state = await states.commit({
    expectedRevision: state.revision,
    state: recordCanonicalStepResult(state, "produce", {
      ...evidence(),
      publishedResult: publication.result,
    }, 5),
    reason: "step_result_published",
  });
  await database.prepare(`
    INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
    VALUES (?, ?, 'failed', NULL, 'seeded_conflict', ?)
  `).run(state.runId, plan.id, 6);

  const terminal = new TerminalCommitter(
    plans,
    new RunOutcomeRepository(database),
    undefined,
    states,
    database,
  );
  await assert.rejects(
    () => terminal.commitCompleted(state.runId, plan.id, "done"),
    /constraint|duplicate|unique/iu,
  );

  const persistedState = await states.get(state.runId);
  const persistedPlan = await plans.get(plan.id);
  const persistedRun = await runs.get(state.runId);
  assert.equal(persistedState.revision, state.revision);
  assert.equal(persistedState.terminal, undefined);
  assert.equal(persistedPlan.status, "running");
  assert.equal(persistedRun?.status, "running");
  await database.close();
});
