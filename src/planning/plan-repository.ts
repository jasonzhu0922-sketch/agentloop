import type { SqlConnection } from "../storage/connection.ts";
import { notFound } from "../shared/errors.ts";
import type {
  AssessmentMethod,
  AssessmentProfileId,
  ExecutionPlan,
  PlanStatus,
  PlanStep,
  PlanStepStatus,
  SkillComplianceAssessment,
  StepEvidence,
} from "./contracts.ts";

interface PlanRow {
  id: string;
  run_id: string;
  version: number;
  goal: string;
  selected_skill_ids_json: string;
  status: PlanStatus;
  created_at: number;
  updated_at: number;
}

interface StepRow {
  plan_id: string;
  step_id: string;
  kind: "leaf" | "milestone";
  parent_step_id: string | null;
  position: number;
  objective: string;
  dependencies_json: string;
  role: "fact_acquisition" | "produce" | "deliver" | "repair" | null;
  refinement_state: "not_refinable" | "pending_facts" | "ready_to_refine" | "refining" | "refined";
  required_facts_json: string;
  skill_ids_json: string;
  recommended_tool_names_json: string;
  evidence_contract_json: string | null;
  success_criteria_json: string;
  status: PlanStepStatus;
  output: string | null;
  evidence_json: string | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
  retired_at: number | null;
  retirement_reason: string | null;
}

interface PlanRevisionInput {
  readonly planId: string;
  readonly proposal: ExecutionPlan;
  readonly retiredStepIds: readonly string[];
  readonly reason: string;
  readonly actionId: string;
}

export class PlanRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  create(plan: ExecutionPlan): ExecutionPlan {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.id,
        plan.runId,
        plan.version,
        plan.goal,
        JSON.stringify(plan.selectedSkillIds),
        plan.status,
        plan.createdAt,
        plan.updatedAt,
      );
      const insertStep = this.database.prepare(`
        INSERT INTO plan_steps(
          plan_id, step_id, kind, parent_step_id, position, objective, dependencies_json,
          role, refinement_state, required_facts_json, skill_ids_json,
          recommended_tool_names_json, evidence_contract_json, success_criteria_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const step of plan.steps) {
        insertStep.run(
          plan.id,
          step.id,
          step.kind,
          step.parentId ?? null,
          step.position,
          step.objective,
          JSON.stringify(step.dependencies),
          step.role ?? null,
          step.refinementState,
          JSON.stringify(step.requiredFacts),
          JSON.stringify(step.skillIds),
          JSON.stringify(step.recommendedToolNames),
          step.evidenceContract === undefined ? null : JSON.stringify(step.evidenceContract),
          JSON.stringify(step.successCriteria),
          step.status,
        );
      }
      this.saveSnapshot(plan, "initial_admission", undefined, plan.createdAt);
    });
    return this.get(plan.id);
  }

  getByRun(runId: string): ExecutionPlan {
    const row = this.database.prepare("SELECT * FROM plans WHERE run_id = ?").get(runId) as PlanRow | undefined;
    if (row === undefined) throw notFound("Plan");
    return this.hydrate(row);
  }

  get(planId: string): ExecutionPlan {
    const row = this.database.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as PlanRow | undefined;
    if (row === undefined) throw notFound("Plan");
    return this.hydrate(row);
  }

  markPlan(planId: string, status: PlanStatus): ExecutionPlan {
    this.database.prepare("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), planId);
    return this.get(planId);
  }

  startStep(planId: string, stepId: string): ExecutionPlan {
    const now = Date.now();
    this.database.transaction(() => {
      this.database.prepare("UPDATE plans SET status = 'running', updated_at = ? WHERE id = ?")
        .run(now, planId);
      this.database.prepare(`
        UPDATE plan_steps SET status = 'running', started_at = ?
        WHERE plan_id = ? AND step_id = ? AND status = 'pending'
      `).run(now, planId, stepId);
    });
    return this.get(planId);
  }

  completeStep(planId: string, stepId: string, output: string, evidence: StepEvidence): ExecutionPlan {
    const now = Date.now();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE plan_steps
        SET status = 'completed', output = ?, evidence_json = ?, finished_at = ?
        WHERE plan_id = ? AND step_id = ? AND status = 'running'
      `).run(output, JSON.stringify(evidence), now, planId, stepId);
      this.database.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(now, planId);
    });
    return this.get(planId);
  }

  failStep(planId: string, stepId: string, error: string): ExecutionPlan {
    const now = Date.now();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE plan_steps SET status = 'failed', error = ?, finished_at = ?
        WHERE plan_id = ? AND step_id = ?
      `).run(error, now, planId, stepId);
      this.database.prepare("UPDATE plans SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(now, planId);
    });
    return this.get(planId);
  }

  saveAssessment(assessment: SkillComplianceAssessment): void {
    this.database.prepare(`
      INSERT INTO skill_compliance_assessments(
        id, plan_id, step_id, attempt, assessment_profile, assessment_method,
        approved, criteria_json, skills_json,
        evidence_digest, feedback, failed_boundary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assessment.id,
      assessment.planId,
      assessment.stepId,
      assessment.attempt,
      assessment.assessmentProfile ?? "source_grounded",
      assessment.assessmentMethod ?? "model",
      assessment.approved ? 1 : 0,
      JSON.stringify(assessment.criteria),
      JSON.stringify(assessment.skills),
      assessment.evidenceDigest,
      assessment.feedback,
      assessment.failedBoundary === undefined ? null : JSON.stringify(assessment.failedBoundary),
      assessment.createdAt,
    );
  }

  assessments(planId: string): SkillComplianceAssessment[] {
    const rows = this.database.prepare(`
      SELECT id, plan_id, step_id, attempt, assessment_profile, assessment_method,
             approved, criteria_json, skills_json,
             evidence_digest, feedback, failed_boundary_json, created_at
      FROM skill_compliance_assessments WHERE plan_id = ? ORDER BY step_id, attempt
    `).all(planId) as unknown as Array<{
      id: string; plan_id: string; step_id: string; attempt: number;
      assessment_profile?: string; assessment_method?: string; approved: number;
      criteria_json: string; skills_json: string; evidence_digest: string; feedback: string;
      failed_boundary_json: string | null; created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      planId: row.plan_id,
      stepId: row.step_id,
      attempt: row.attempt,
      assessmentProfile: parseAssessmentProfile(row.assessment_profile),
      assessmentMethod: parseAssessmentMethod(row.assessment_method),
      approved: row.approved === 1,
      criteria: JSON.parse(row.criteria_json),
      skills: JSON.parse(row.skills_json),
      evidenceDigest: row.evidence_digest,
      feedback: row.feedback,
      ...(row.failed_boundary_json === null ? {} : { failedBoundary: JSON.parse(row.failed_boundary_json) }),
      createdAt: row.created_at,
    }));
  }

  validateRevision(input: PlanRevisionInput): ExecutionPlan {
    const current = this.get(input.planId);
    const next = input.proposal;
    if (next.runId !== current.runId) throw new Error("Plan revision must remain in the same Run");
    const currentById = new Map(current.steps.map((step) => [step.id, step]));
    const proposedById = new Map(next.steps.map((step) => [step.id, step]));
    for (const step of current.steps.filter((item) => item.retiredAt === undefined)) {
      const proposed = proposedById.get(step.id);
      if (proposed !== undefined && !samePlanStepDefinition(step, proposed)) {
        throw new Error(`Plan revision cannot alter existing step ${step.id}`);
      }
      if (step.status === "completed" && proposed === undefined) {
        throw new Error(`Plan revision cannot remove completed step ${step.id}`);
      }
    }
    for (const step of current.steps) {
      if (proposedById.has(step.id) || step.retiredAt !== undefined) continue;
      if (!input.retiredStepIds.includes(step.id)) {
        throw new Error(`Plan revision must explicitly retire omitted step ${step.id}`);
      }
      if (step.status === "completed") throw new Error(`Plan revision cannot retire completed step ${step.id}`);
    }
    for (const stepId of input.retiredStepIds) {
      const step = currentById.get(stepId);
      if (step === undefined || step.status === "completed" || step.retiredAt !== undefined) {
        throw new Error(`Plan revision cannot retire step ${stepId}`);
      }
      if (proposedById.has(stepId)) throw new Error(`Retired step ${stepId} is still in the revised Plan`);
    }
    return current;
  }

  revise(input: PlanRevisionInput): ExecutionPlan {
    const current = this.validateRevision(input);
    const next = input.proposal;
    const currentById = new Map(current.steps.map((step) => [step.id, step]));

    const now = Date.now();
    this.database.transaction(() => {
      this.saveSnapshot(current, "before_revision", input.actionId, now);
      this.database.prepare(`
        UPDATE plans
        SET version = ?, goal = ?, selected_skill_ids_json = ?, status = 'running', updated_at = ?
        WHERE id = ?
      `).run(current.version + 1, next.goal, JSON.stringify(next.selectedSkillIds), now, current.id);
      const insertStep = this.database.prepare(`
        INSERT INTO plan_steps(
          plan_id, step_id, kind, parent_step_id, position, objective, dependencies_json,
          role, refinement_state, required_facts_json, skill_ids_json,
          recommended_tool_names_json, evidence_contract_json, success_criteria_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `);
      let nextPosition = Math.max(-1, ...current.steps.map((step) => step.position)) + 1;
      for (const step of next.steps) {
        if (currentById.has(step.id)) continue;
        insertStep.run(
          current.id,
          step.id,
          step.kind,
          step.parentId ?? null,
          nextPosition,
          step.objective,
          JSON.stringify(step.dependencies),
          step.role ?? null,
          step.refinementState,
          JSON.stringify(step.requiredFacts),
          JSON.stringify(step.skillIds),
          JSON.stringify(step.recommendedToolNames),
          step.evidenceContract === undefined ? null : JSON.stringify(step.evidenceContract),
          JSON.stringify(step.successCriteria),
        );
        nextPosition += 1;
      }
      const retire = this.database.prepare(`
        INSERT INTO plan_step_retirements(plan_id, step_id, action_id, reason, retired_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const stepId of input.retiredStepIds) {
        retire.run(current.id, stepId, input.actionId, input.reason, now);
      }
      const revised = this.get(current.id);
      this.saveSnapshot(revised, "recovery_revision", input.actionId, now);
    });
    return this.get(current.id);
  }

  private hydrate(row: PlanRow): ExecutionPlan {
    const steps = this.database.prepare(`
      SELECT plan_steps.*, plan_step_retirements.retired_at, plan_step_retirements.reason AS retirement_reason
      FROM plan_steps
      LEFT JOIN plan_step_retirements
        ON plan_step_retirements.plan_id = plan_steps.plan_id
        AND plan_step_retirements.step_id = plan_steps.step_id
      WHERE plan_steps.plan_id = ? ORDER BY position
    `).all(row.id) as unknown as StepRow[];
    return {
      id: row.id,
      runId: row.run_id,
      version: row.version,
      goal: row.goal,
      selectedSkillIds: JSON.parse(row.selected_skill_ids_json),
      status: row.status,
      steps: steps.map(toStep),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private saveSnapshot(plan: ExecutionPlan, reason: string, actionId: string | undefined, createdAt: number): void {
    const proposal = {
      goal: plan.goal,
      selectedSkillIds: plan.selectedSkillIds,
      steps: plan.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        ...(step.parentId === undefined ? {} : { parentId: step.parentId }),
        objective: step.objective,
        dependencies: step.dependencies,
        refinementState: step.refinementState,
        requiredFacts: step.requiredFacts,
        skillIds: step.skillIds,
        recommendedToolNames: step.recommendedToolNames,
        ...(step.evidenceContract === undefined ? {} : { evidenceContract: step.evidenceContract }),
        successCriteria: step.successCriteria,
        status: step.status,
        ...(step.retiredAt === undefined ? {} : { retiredAt: step.retiredAt }),
      })),
    };
    this.database.prepare(`
      INSERT OR IGNORE INTO plan_revision_snapshots(plan_id, version, proposal_json, reason, action_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(plan.id, plan.version, JSON.stringify(proposal), reason, actionId ?? null, createdAt);
  }
}

function parseAssessmentProfile(value: string | undefined): AssessmentProfileId {
  if (
    value === "deterministic"
    || value === "evidence_gate"
    || value === "lookup_lite"
    || value === "source_grounded"
    || value === "risk_sensitive"
  ) {
    return value;
  }
  return "source_grounded";
}

function parseAssessmentMethod(value: string | undefined): AssessmentMethod {
  return value === "rule" || value === "model" ? value : "model";
}

function toStep(row: StepRow): PlanStep {
  return {
    id: row.step_id,
    kind: row.kind ?? "leaf",
    ...(row.parent_step_id === null ? {} : { parentId: row.parent_step_id }),
    position: row.position,
    objective: row.objective,
    dependencies: JSON.parse(row.dependencies_json),
    ...(row.role === null ? {} : { role: row.role }),
    refinementState: row.refinement_state ?? "not_refinable",
    requiredFacts: row.required_facts_json === undefined ? [] : JSON.parse(row.required_facts_json),
    skillIds: JSON.parse(row.skill_ids_json),
    recommendedToolNames: JSON.parse(row.recommended_tool_names_json),
    ...(row.evidence_contract_json === null ? {} : { evidenceContract: JSON.parse(row.evidence_contract_json) }),
    successCriteria: JSON.parse(row.success_criteria_json),
    status: row.status,
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.evidence_json === null ? {} : { evidence: JSON.parse(row.evidence_json) as StepEvidence }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    ...(row.retirement_reason === null ? {} : { retirementReason: row.retirement_reason }),
  };
}

function samePlanStepDefinition(left: PlanStep, right: PlanStep): boolean {
  return left.kind === right.kind
    && left.parentId === right.parentId
    && left.objective === right.objective
    && JSON.stringify(left.dependencies) === JSON.stringify(right.dependencies)
    && left.role === right.role
    && left.refinementState === right.refinementState
    && JSON.stringify(left.requiredFacts) === JSON.stringify(right.requiredFacts)
    && JSON.stringify(left.skillIds) === JSON.stringify(right.skillIds)
    && JSON.stringify(left.recommendedToolNames) === JSON.stringify(right.recommendedToolNames)
    && JSON.stringify(left.evidenceContract ?? null) === JSON.stringify(right.evidenceContract ?? null)
    && JSON.stringify(left.successCriteria) === JSON.stringify(right.successCriteria);
}
