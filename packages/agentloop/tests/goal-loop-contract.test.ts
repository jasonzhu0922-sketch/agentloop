import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { admitPlan } from "../src/planning/admission.ts";
import { ModelStepAssessor } from "../src/planning/assessor.ts";
import { goalCriterionBasis } from "../src/planning/criterion-basis.ts";
import { bindCanonicalPlan, createCanonicalRunState, recordCanonicalAssessment, startCanonicalStep } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { parseRecoveryDecision } from "../src/runtime/recovery-planning.ts";
import { RunService, recoveryProposalSuccessCriteria } from "../src/runtime/run-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { installAssessmentProfileSchema } from "../src/storage/assessment-profile-schema.ts";
import type { SqlConnection, SqlDialect } from "../src/storage/connection.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { singleStepTestPlanner, approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import { HUMAN_LOOP_TOOL_NAME } from "../src/tools/human-loop-tool.ts";

for (const humanPause of [false, true]) {
  test(`canonical assessment gaps survive local exhaustion and drive one shared recovery path (humanPause=${humanPause})`, async () => {
    const database = new AppDatabase(":memory:");
    let asked = false;
    let sourceReads = 0;
    let candidates = 0;
    let recoveryCalls = 0;
    let gapId = "";
    let sawRepairView = false;
    const base = singleStepTestPlanner();
    try {
      const runs = new RunService({ database, skills: new SkillService(database),
        plannerFactory: () => ({ plan: async (task) => {
          const proposal = await base.plan(task);
          return { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
            requiredCapabilities: ["records.lookup", "conversation_delivery"],
            evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "none" as const },
            successCriteria: [{ id: "second-total", description: "Establish both totals and state their difference.", source: "task" as const }],
          })) };
        } }),
        tools: [{ name: "read_records", description: "Read the requested records", inputSchema: { type: "object" },
          source: { id: "records", transport: "api", capabilities: [{ id: "records.lookup", category: "source_acquisition",
            sourceKinds: ["api"], producesEvidenceKinds: ["source_summary"] }] },
          executionMode: "parallel", replaySafe: true, parse: (value) => value,
          execute: async () => ({ value: ++sourceReads === 1 ? { a: 80 } : { a: 80, b: 60 },
            evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", sourceType: "api",
              evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } } }) }],
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
          if (humanPause && !asked) {
            asked = true;
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "confirm-records", name: HUMAN_LOOP_TOOL_NAME,
              arguments: { kind: "confirmation", title: "Confirm input", prompt: "Use the selected records?", rationale: "Confirm the record scope",
                evidenceRefs: [], responseSchema: { type: "confirm", acceptLabel: "Continue", rejectLabel: "Stop" },
                resume: { mode: "continue_step" } } }] };
          }
          const frame = JSON.parse(request.runtimeContext!.content.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]!);
          const view = frame.currentDecisionView;
          const stored = await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id = ?")
            .get<{ state_json: string }>(request.runId);
          const state = JSON.parse(stored!.state_json);
          if (gapId === "") gapId = state.gaps.find((gap: { stepId?: string }) => gap.stepId !== undefined)?.id ?? "";
          assert.equal(view.identity.canonicalState.revision, state.revision,
            "every model turn must consume the latest committed Run revision");
          const gaps = view.currentGap.assessmentGaps;
          if (gaps.length > 0) {
            assert.equal(view.nextAction, "resolve_evidence_gap");
            assert.equal(gaps[0].id, gapId);
            assert.equal(gaps[0].unmetCriteria[0].criterionId, "second-total");
            assert.deepEqual(view.currentGap.receipts.missingToolEvidenceKinds, [], "a source receipt exists but the second total is still unverified");
            assert.ok(request.tools.some((tool) => tool.name === "read_records"));
            assert.doesNotMatch(request.runtimeContext!.content, /Return a complete standalone replacement now/);
          }
          const repairing = view.identity.stepId === "complete-records";
          if (repairing) sawRepairView = true;
          if (sourceReads === 0 || (repairing && sourceReads === 1)) {
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `read-${sourceReads}`, name: "read_records", arguments: {} }] };
          }
          return { content: sourceReads > 1 ? "The difference is 20." : `Only the first total is known. Draft ${++candidates}.`,
            finishReason: "stop", toolCalls: [] };
        } }),
        assessorFactory: () => ({ assess: async (input) => {
          const approved = await approvingTestAssessor().assess(input);
          if (sourceReads > 1) return approved;
          return { ...approved, approved: false, assessmentMethod: "model" as const,
            criteria: approved.criteria.map((criterion) => ({ ...criterion, satisfied: false, rationale: "The second total is unverified." })),
            feedback: "Read the second total before computing the difference.",
            failedBoundary: { stepId: input.step.id, suggestedRepairShape: "repair_leaf" as const, missingEvidenceKinds: ["source_summary"],
              violatedSkillRequirements: [], reusableEvidenceRefs: input.evidence.toolCalls.map((call) => call.toolCallId),
              unmetCriteria: [{ criterionId: "second-total", status: "unverified" as const, rationale: "The source only contains the first total.", evidenceRefs: [] }] } };
        } }),
        recoveryPlannerFactory: () => ({ decide: async (input) => {
          recoveryCalls += 1;
          assert.equal(input.action.metadata.localRepairExhausted, true);
          assert.equal(input.canonicalGap!.id, gapId);
          assert.equal(input.canonicalGap!.repairAttempts, 0);
          const failed = input.plan!.steps.find((step) => step.id === input.failedBoundary!.stepId)!;
          return parseRecoveryDecision({ id: "repair-plan", name: "submit_recovery_decision", arguments: {
            actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan",
            rationale: "Read the missing second total, preserving existing observations.", evidenceRefs: input.canonicalGap!.evidenceRefs,
            planRevision: { goal: input.plan!.goal, shape: "recovery_patch" as const, selectedSkillIds: [],
              steps: [{ id: "complete-records", objective: failed.objective, role: "repair" as const, dependencies: [], skillIds: [],
                targetIds: failed.executionBinding.targetIds, requiredCapabilities: failed.requiredCapabilities, sourceConstraint: null,
                evidenceContract: failed.evidenceContract, successCriteria: recoveryModelCriteria(failed.successCriteria) }] } },
          }, input.canonicalState!);
        } }),
        planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
      });
      const run = await runs.execute("owner", "Compare the two recorded totals and state their difference.");
      if (humanPause) {
        const request = await runs.currentHumanLoop("owner", run.id);
        assert.ok(request);
        await runs.respondHumanLoop("owner", run.id, request.id, true, request.revision);
        for (let attempt = 0; attempt < 100 && (await runs.get("owner", run.id)).status === "running"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
      const final = await runs.get("owner", run.id);
      assert.equal(final.status, "completed", final.output);
      assert.equal(final.output, "The difference is 20.");
      assert.equal(sourceReads, 2);
      assert.equal(recoveryCalls, 1);
      assert.equal(sawRepairView, true);
      const canonical = JSON.parse((await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id = ?")
        .get<{ state_json: string }>(run.id))!.state_json);
      const gap = canonical.gaps.find((item: { id: string }) => item.id === gapId);
      assert.equal(gap.status, "resolved");
      assert.equal(gap.repairAttempts, 1);
      assert.equal((await runs.events("owner", run.id)).some((event) => event.type === "terminal.delivery_committed"), true);
      assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM runtime_actions WHERE run_id = ? AND kind = 'recovery_review' AND state = 'recovery_required'")
        .get<{ count: number }>(run.id))!.count, 0);
    } finally { await database.close(); }
  });
}

function fixture() {
  const userInput = "Compare the two recorded totals and state their difference.";
  const state = createCanonicalRunState({ runId: "goal-contract", userInput,
    understanding: understandTask({ objective: userInput }), now: 1 });
  const basis = goalCriterionBasis(state, [], "user_requirement", "The requested comparison must state the difference.");
  const proposal = { goal: userInput, selectedSkillIds: [], steps: [{ id: "answer", objective: userInput,
    dependencies: [], skillIds: [], requiredCapabilities: [], targetIds: [],
    successCriteria: [{ id: "difference", description: "State the difference between recorded totals.", source: "task" as const,
      verification: "model_judged" as const, blocking: true, basis }] }] };
  return { state, proposal, basis };
}

function recoveryModelCriteria(criteria: readonly import("../src/planning/contracts.ts").SuccessCriterion[]) {
  return recoveryProposalSuccessCriteria(criteria).map((criterion) => {
    if (criterion.basis === undefined) return criterion;
    const { requirement: _requirement, ...basis } = criterion.basis;
    return { ...criterion, basis };
  });
}

test("a canonical synthesis gap allows a corrected answer from unchanged observations", async () => {
  const database = new AppDatabase(":memory:");
  let turns = 0;
  try {
    const runs = new RunService({ database, skills: new SkillService(database), tools: [],
      plannerFactory: singleStepTestPlanner,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        turns += 1;
        if (turns === 2) {
          const frame = JSON.parse(request.runtimeContext!.content.match(/<loop_step_frame source="server">\n([^\n]+)\n/)![1]!);
          assert.equal(frame.currentDecisionView.nextAction, "revise_completion_candidate");
          assert.deepEqual(frame.currentDecisionView.currentGap.assessmentGaps[0].missingEvidenceKinds, []);
        }
        return { content: turns === 1 ? "The totals are 80 and 60." : "The difference is 20.", finishReason: "stop", toolCalls: [] };
      } }),
      assessorFactory: () => ({ assess: async (input) => {
        const assessment = await approvingTestAssessor().assess(input);
        return turns > 1 ? assessment : { ...assessment, approved: false,
          criteria: assessment.criteria.map((criterion) => ({ ...criterion, satisfied: false, rationale: "State the difference using the supplied totals." })),
          feedback: "The observations are sufficient; correct the answer.",
          failedBoundary: { stepId: input.step.id, suggestedRepairShape: "repair_leaf" as const,
            missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [] } };
      } }),
      recoveryPlannerFactory: () => ({ decide: async () => { throw new Error("A synthesis revision must not require new acquisition or a revised Plan"); } }),
    });
    const run = await runs.execute("owner", "The totals are 80 and 60. State their difference.");
    assert.equal(run.status, "completed");
    assert.equal(run.output, "The difference is 20.");
    assert.equal(turns, 2);
    assert.equal((await runs.events("owner", run.id)).some((event) => event.type === "tool.completed"), false);
  } finally { await database.close(); }
});

test("criterion provenance rejects foreign intents, invented quotes and unowned targets without weakening the criterion", () => {
  const { state, proposal, basis } = fixture();
  for (const invalid of [{ ...basis, intentId: "foreign" }, { ...basis, requirement: "invented request" },
    { ...basis, requirement: "two recorded totals" },
    { ...basis, targetIds: ["foreign-target"] }, { ...basis, kind: "execution_method" as const }]) {
    const changed = { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
      successCriteria: step.successCriteria.map((criterion) => ({ ...criterion, basis: invalid })) })) };
    assert.throws(() => admitPlan({ runId: state.runId, canonicalState: state, proposal: changed,
      availableSkills: [], availableToolNames: new Set() }), /basis|Execution method/);
  }
  assert.equal(proposal.steps[0]!.successCriteria[0]!.blocking, true);
});

test("an unjustified derived result obligation remains rejected and reaches the same canonical Gap as a contract issue", async () => {
  const { state, proposal, basis } = fixture();
  const plan = admitPlan({ runId: state.runId, canonicalState: state, availableSkills: [], availableToolNames: new Set(),
    proposal: { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
      successCriteria: step.successCriteria.map((criterion) => ({ ...criterion,
        basis: { ...basis, kind: "necessary_condition", rationale: "Publish an additional written proof of the calculation method." } })) })) } });
  const step = plan.steps[0]!;
  const running = startCanonicalStep(bindCanonicalPlan(state, plan, 2), step.id, 3);
  const evidence = { candidateOutput: "The recorded totals are 80 and 60; the difference is 20.", toolCalls: [], modelSteps: 1 };
  const assessment = await new ModelStepAssessor({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
    assert.match(request.runtimeContext!.content, /canonicalIntent/);
    assert.match(request.systemPrompt, /does not require web research or written citations/);
    return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "assess", name: "submit_assessment", arguments: {
      criteria: [{ criterionId: "difference", satisfied: true, rationale: "The result is correct but this proposed additional proof is not requested.",
        contractCheck: { status: "invalid", rationale: "A separate proof document is an execution method, not a necessary result condition." },
        evidenceRefs: ["candidateOutput"] }],
      skills: [], feedback: "Revise the unjustified derived condition, preserving the requested comparison.", failedBoundary: null,
    } }] };
  } }).assess({ runId: state.runId, planId: plan.id, step, canonicalState: running, skills: [], attempt: 1,
    assessmentProfile: "result_judged", evidence });
  assert.equal(assessment.approved, false);
  assert.equal(assessment.failedBoundary?.suggestedRepairShape, "revise_plan");
  assert.deepEqual(assessment.failedBoundary?.missingEvidenceKinds, []);
  const assessed = recordCanonicalAssessment(running, assessment, evidence, 4);
  const gap = assessed.gaps.find((gap) => gap.stepId === step.id)!;
  assert.deepEqual(gap.unmetCriteria, assessment.failedBoundary?.unmetCriteria);
  assert.equal(gap.unmetCriteria?.[0]?.status, "conflict");
  assert.match(gap.unmetCriteria?.[0]?.contractIssue ?? "", /execution method/);
});

for (const duplicate of [false, true]) {
  test(`unchanged observations allow a corrected candidate while exact duplicates reuse rejection (duplicate=${duplicate})`, async () => {
    let turns = 0;
    let assessments = 0;
    const grant = createCapabilityGrant({ runId: `candidate-${duplicate}`, actorUserId: "owner", depth: 0,
      allowedToolNames: [], allowedSkillIds: [] });
    const execute = () => runAgentLoop({ runId: grant.runId, input: "State the difference", systemPrompt: "Use committed totals",
      grant, tools: new ToolRegistry([]), maxSteps: 4, deferFailureReport: true,
      initialToolEvidence: [{ toolCallId: "totals", toolName: "read_totals", result: '{"a":80,"b":60}', isError: false }],
      model: { limits: TEST_MODEL_LIMITS, complete: async () => ({ content: ++turns === 1 || duplicate ? "The totals are 80 and 60." : "The difference is 20.", finishReason: "stop", toolCalls: [] }) },
      evaluateCandidate: async (candidate) => {
        assessments += 1;
        assert.equal(candidate.toolEvidence.length, 1);
        return { approved: candidate.output.includes("20"), requiresEvidenceProgress: true,
          feedback: "The totals already support the calculation; state the difference." };
      } });
    if (duplicate) {
      await assert.rejects(execute(), (error: any) => error.code === "STEP_NOT_COMPLETED" && error.details?.repairExhausted === true);
      assert.equal(assessments, 1);
    } else {
      assert.equal((await execute()).output, "The difference is 20.");
      assert.equal(assessments, 2);
    }
  });
}

test("Recovery parsing preserves result criteria, original source identities and user provenance", () => {
  const { state, proposal, basis } = fixture();
  const { requirement: _requirement, ...basisMetadata } = basis;
  const sourceConstraint = { requiredToolSourceIds: ["records"], requiredUploadedSourceIds: [], requiredVisibleDirectoryIds: [] };
  const step = { ...proposal.steps[0], role: "repair", targetIds: [], sourceConstraint,
    requiredFacts: [{ id: "totals", description: "The two recorded totals", evidenceKinds: ["source_summary"], basis }] };
  const decision = parseRecoveryDecision({ id: "recovery", name: "submit_recovery_decision", arguments: {
    actionId: "action", expectedActionRevision: 1, decision: "revise_plan", rationale: "Repair the comparison", evidenceRefs: [],
    planRevision: { ...proposal, shape: "recovery_patch", steps: [{ ...step,
      successCriteria: recoveryModelCriteria(step.successCriteria),
      requiredFacts: step.requiredFacts.map((fact) => ({ ...fact, basis: basisMetadata })),
    }] },
  } }, state);
  const parsed = decision.planRevision!.steps[0]!;
  assert.deepEqual(parsed.successCriteria, step.successCriteria);
  assert.deepEqual(parsed.requiredFacts, step.requiredFacts);
  assert.deepEqual(parsed.targetIds, []);
  assert.deepEqual(parsed.sourceConstraint, sourceConstraint);
});

test("Recovery parsing treats a null sourceConstraint as absent while rejecting malformed constraints", () => {
  const { state, proposal } = fixture();
  const step = { ...proposal.steps[0], role: "repair", targetIds: [], sourceConstraint: null,
    successCriteria: recoveryModelCriteria(proposal.steps[0]!.successCriteria) };
  const decision = parseRecoveryDecision({ id: "recovery-null-source", name: "submit_recovery_decision", arguments: {
    actionId: "action", expectedActionRevision: 1, decision: "revise_plan", rationale: "Repair the comparison", evidenceRefs: [],
    planRevision: { ...proposal, shape: "recovery_patch", steps: [step] },
  }}, state);
  assert.equal(decision.planRevision!.steps[0]!.sourceConstraint, undefined);
  for (const malformed of ["records", [], false, 0, { requiredToolSourceIds: null }, { requiredUploadedSourceIds: [12] }]) {
    assert.throws(() => parseRecoveryDecision({ id: "recovery-bad-source", name: "submit_recovery_decision", arguments: {
      actionId: "action", expectedActionRevision: 1, decision: "revise_plan", rationale: "Repair the comparison", evidenceRefs: [],
      planRevision: { ...proposal, shape: "recovery_patch", steps: [{ ...step, sourceConstraint: malformed }] },
    }}, state), (error: any) => error.code === "PLANNING_ERROR");
  }
});

test("an invalid Recovery response commits a stopped Outcome and retains the open Gap", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunService({ database, skills: new SkillService(database), plannerFactory: singleStepTestPlanner, tools: [],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "unverified candidate", finishReason: "stop", toolCalls: [] }) }),
      recoveryPlannerFactory: () => ({ decide: async () => { throw new Error("invalid structured recovery response"); } }),
      assessorFactory: () => ({ assess: async (input) => ({ ...await approvingTestAssessor().assess(input), approved: false,
        criteria: input.step.successCriteria.map((criterion) => ({ criterionId: criterion.id, satisfied: false, rationale: "Result is incomplete", evidenceRefs: [] })),
        failedBoundary: { stepId: input.step.id, suggestedRepairShape: "repair_leaf", missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: [] } }) }),
    });
    const run = await runs.execute("owner", "Return a complete comparison");
    assert.equal(run.status, "failed");
    const row = await database.prepare("SELECT status, delivery_receipt_json FROM run_outcomes WHERE run_id = ?").get(run.id) as any;
    assert.equal(row.status, "failed");
    assert.equal(row.delivery_receipt_json, null);
    assert.equal((await runs.events("owner", run.id)).some((event) => event.type === "terminal.delivery_committed"), false);
    assert.match(run.output ?? "", /未完成/);
  } finally { await database.close(); }
});

test("assessment profile schema upgrade preserves complete historical observations and indexes", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunService({ database, skills: new SkillService(database), tools: [], plannerFactory: singleStepTestPlanner,
      assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "Complete comparison", finishReason: "stop", toolCalls: [] }) }),
    });
    assert.equal((await runs.execute("owner", "Compare the recorded values")).status, "completed");
    await database.prepare(`UPDATE skill_compliance_assessments SET assessment_profile = 'source_grounded',
      binding_json = ?, inspection_json = ?, decision_bindings_json = ?`).run('{"binding":"retained"}', '{"inspection":"retained"}', '[{"decision":"retained"}]');
    const before = await database.prepare("SELECT * FROM skill_compliance_assessments ORDER BY id").all();
    const table = await database.prepare("SELECT sql FROM sqlite_master WHERE name = 'skill_compliance_assessments'").get<{ sql: string }>();
    await database.transaction(async () => {
      await database.exec(table!.sql.replace(/skill_compliance_assessments/, "assessment_old_schema").replace(", 'result_judged'", ""));
      await database.exec("INSERT INTO assessment_old_schema SELECT * FROM skill_compliance_assessments");
      await database.exec("DROP TABLE skill_compliance_assessments");
      await database.exec("ALTER TABLE assessment_old_schema RENAME TO skill_compliance_assessments");
      await database.exec("CREATE INDEX assessment_observation_idx ON skill_compliance_assessments(plan_id, step_id)");
      await database.exec("CREATE TABLE assessment_audit (assessment_id TEXT)");
      await database.exec("CREATE TRIGGER assessment_update_audit AFTER UPDATE ON skill_compliance_assessments BEGIN INSERT INTO assessment_audit VALUES (NEW.id); END");
    });
    await database.installAssessmentProfileSchema();
    assert.deepEqual(await database.prepare("SELECT * FROM skill_compliance_assessments ORDER BY id").all(), before);
    assert.ok(await database.prepare("SELECT name FROM sqlite_master WHERE name = 'assessment_observation_idx'").get());
    await database.prepare("UPDATE skill_compliance_assessments SET assessment_profile = 'result_judged'").run();
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM assessment_audit").get<{ total: number }>())!.total, before.length);
    await database.installAssessmentProfileSchema();
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM skill_compliance_assessments").get<{ total: number }>())!.total, before.length);
  } finally { await database.close(); }
});

for (const dialect of ["postgres", "tidb"] as const) {
  test(`${dialect} profile migration replaces only the profile constraint and is idempotent`, async () => {
    const statements: string[] = [];
    const profileName = dialect === "postgres" ? 'profile"check' : 'profile`check';
    let constraints = [{ name: "approved_check", clause: "approved IN (0, 1)" },
      { name: profileName, clause: "assessment_profile IN ('source_grounded', 'evidence_gate')" }];
    const connection: SqlConnection = {
      dialect: dialect as SqlDialect,
      exec: async (sql) => {
        statements.push(sql);
        if (sql.includes("ADD CONSTRAINT")) constraints = [constraints[0]!, { name: "skill_assessment_profile_check", clause: sql }];
      },
      prepare: (sql) => {
        assert.match(sql, dialect === "postgres" ? /pg_constraint/ : /information_schema.CHECK_CONSTRAINTS/);
        return { all: async <T>() => constraints as T[],
          get: async () => { throw new Error("unexpected row read"); },
          run: async () => { throw new Error("migration must not rewrite assessment rows"); } };
      },
      transaction: async (operation) => operation(), close: async () => {},
    };
    await installAssessmentProfileSchema(connection);
    assert.equal(statements.length, 2);
    assert.equal(statements[0], dialect === "postgres"
      ? 'ALTER TABLE skill_compliance_assessments DROP CONSTRAINT "profile""check"'
      : 'ALTER TABLE skill_compliance_assessments DROP CHECK `profile``check`');
    assert.match(statements[1]!, /'result_judged'/);
    assert.equal(statements.some((sql) => sql.includes("approved_check")), false);
    await installAssessmentProfileSchema(connection);
    assert.equal(statements.length, 2);
  });
}

test("an accepted file receipt cannot route a requested content property through rule-only assessment", async () => {
  const database = new AppDatabase(":memory:");
  const workspaceRoot = await mkdtemp(join(tmpdir(), "goal-content-assessment-"));
  let targetId = "";
  let assessments = 0;
  let writes = 0;
  const base = singleStepTestPlanner();
  try {
    const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot,
      plannerFactory: () => ({ plan: async (task) => {
        assert.equal(task.canonicalState.intent.understanding.evidence.need, "none", "comparing supplied numbers must not create an external-source obligation");
        const proposal = await base.plan(task);
        targetId = task.canonicalState.intent.understanding.artifactTargets![0]!.id;
        return { ...proposal, steps: proposal.steps.map((step) => ({ ...step, role: "produce" as const,
          requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
          evidenceContract: { requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"] as const, caveatPolicy: "none" as const },
          successCriteria: [{ id: "correct-difference", source: "task" as const, description: "The HTML must state the correct difference.", verification: "model_judged" as const }],
        })) };
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.tools[0]?.name === "resolve_conversation_turn") return { content: "", finishReason: "tool_calls", toolCalls: [{
          id: "resolve-report", name: "resolve_conversation_turn", arguments: {
            mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: "比较 80 与 60，生成一个 HTML 文件，内容写出差值。",
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "create_artifact", requiresExecution: true,
              deliverables: [{ targetId: "report", purpose: "The report must state the difference", expectedArtifactCount: 1,
                action: "create", kind: "html", format: "html", surface: "workspace_artifact" }] },
            evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [], requiredCapabilityReferences: [],
          },
        }] };
        if (request.phase === "assessment") {
          assessments += 1;
          const match = request.runtimeContext!.content.match(/<assessment_context source="server">\n([^\n]+)\n/)!;
          const context = JSON.parse(match[1]);
          assert.match(request.runtimeContext!.content, /result_judged/);
          assert.match(JSON.stringify(context.evidence), /artifactAcceptance/);
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "content-assessment", name: "submit_assessment", arguments: {
            criteria: context.step.successCriteria.map((criterion: { id: string }) => ({ criterionId: criterion.id,
              satisfied: criterion.id !== "correct-difference", rationale: "The file decodes; the requested difference is not verified.", evidenceRefs: ["write-report"],
              contractCheck: { status: "valid", rationale: "The condition follows from the requested report." } })),
            skills: [], feedback: "Preserve the stage file; the requested content remains unverified.",
            failedBoundary: { stepId: context.step.id, missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: ["write-report"], suggestedRepairShape: "fail" },
          } }] };
        }
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          return { content: "已生成文件，差值内容尚未核验。", finishReason: "stop", toolCalls: [] };
        }
        if (writes++ === 0) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "write-report", name: "computer_write_file",
          arguments: { path: "report.html", content: "<!doctype html><html><head><meta charset='utf-8'><title>Report</title></head><body><h1>Comparison</h1><p>The totals are 80 and 60.</p></body></html>", deliveryTargetId: targetId } }] };
        if (writes === 2) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "verify-report", name: "verify_artifact_acceptance", arguments: { artifactPath: "report.html" } }] };
        return { content: "已生成 report.html。", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.executeConversation("owner", "比较 80 与 60，生成一个 HTML 文件，内容写出差值。");
    assert.equal(run.status, "failed");
    assert.equal(assessments, 1);
    const artifact = (await runs.processArtifacts("owner", run.id)).find((artifact) => artifact.path === "report.html")!;
    assert.equal(artifact.verification?.file, "verified");
    assert.equal(artifact.verification?.result, "unverified");
    assert.equal(artifact.role, "process");
    assert.ok(artifact.verification?.limitations.some((text) => text.includes("difference")));
  } finally { await database.close(); await rm(workspaceRoot, { recursive: true, force: true }); }
});
