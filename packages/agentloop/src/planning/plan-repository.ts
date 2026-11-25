import { RunInputRepository } from "../runtime/run-input-repository.ts";
import { ascending, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import { AppError, notFound } from "../shared/errors.ts";
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
import { parseRuntimeResult, parseRuntimeResultBinding, parseRuntimeResultRef } from "../runtime/runtime-result.ts";
import type { RuntimeResultBinding } from "../runtime/runtime-result.ts";
import type { CanonicalRunStateRef } from "../runtime/canonical-run-state.ts";
import { parseRoundScope } from "./round-scope.ts";

interface PlanRow {
  id: string;
  run_id: string;
  version: number;
  goal: string;
  selected_skill_ids_json: string;
  canonical_state_ref_json?: string | null;
  input_bindings_json?: string;
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
  required_capabilities_json?: string;
  recommended_tool_names_json?: string;
  execution_binding_json?: string | null;
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
  /** Explicit input decision may supersede a completed contract; its evidence stays archived. */
  readonly steerMessageId?: string;
}

export class PlanRepository {
  private readonly database: RuntimePersistence;

  constructor(database: RuntimePersistenceInput) {
    this.database = runtimePersistence(database);
  }

  async create(plan: ExecutionPlan): Promise<ExecutionPlan> {
    return await this.database.transaction(async () => {
      await this.database.records.insert("plans", { id: plan.id, run_id: plan.runId, version: plan.version, goal: plan.goal,
        selected_skill_ids_json: JSON.stringify(plan.selectedSkillIds), canonical_state_ref_json: JSON.stringify(plan.canonicalStateRef),
        input_bindings_json: JSON.stringify(plan.resultBindings ?? []), status: storedPlanStatus(plan.status), created_at: plan.createdAt, updated_at: plan.updatedAt });
      for (const step of plan.steps) await this.insertStep(plan.id, step);
      await this.saveSnapshot(plan, "initial_admission", undefined, plan.createdAt);
      await this.saveRoundScope(plan);
      return await this.get(plan.id);
    });
  }

  private async insertStep(planId: string, step: PlanStep): Promise<void> {
    await this.database.records.insert("plan_steps", { plan_id: planId, step_id: step.id, kind: step.kind, parent_step_id: step.parentId ?? null,
      position: step.position, objective: step.objective, dependencies_json: JSON.stringify(step.dependencies), role: step.role ?? null,
      refinement_state: step.refinementState, required_facts_json: JSON.stringify(step.requiredFacts), skill_ids_json: JSON.stringify(step.skillIds),
      required_capabilities_json: JSON.stringify(step.requiredCapabilities), recommended_tool_names_json: "[]", execution_binding_json: JSON.stringify(step.executionBinding),
      evidence_contract_json: step.evidenceContract === undefined ? null : JSON.stringify(step.evidenceContract),
      success_criteria_json: JSON.stringify(step.successCriteria), status: step.status });
  }

  async getByRun(runId: string): Promise<ExecutionPlan> {
    return await this.database.transaction(async () => {
      const rounds = await this.database.records.find("run_rounds", { run_id: runId });
      const bound = new Set(rounds.map(row => row.plan_id));
      const rows = await this.database.records.find("plans", { run_id: runId });
      rows.sort((a, b) => Number(bound.has(b.id)) - Number(bound.has(a.id)) || b.created_at - a.created_at || b.id.localeCompare(a.id));
      if (!rows[0]) throw notFound("Plan");
      return await this.hydrate(rows[0]);
    });
  }

  async listByRun(runId: string): Promise<ExecutionPlan[]> {
    return await this.database.transaction(async () => {
      const rows = (await this.database.records.find("plans", { run_id: runId })).sort(ascending("created_at", "id"));
      if (!rows.length) throw notFound("Plan");
      return await Promise.all(rows.map(row => this.hydrate(row)));
    });
  }

  async get(planId: string): Promise<ExecutionPlan> {
    return await this.database.transaction(async () => {
      const row = (await this.database.records.find("plans", { id: planId }))[0];
      if (!row) throw notFound("Plan");
      return await this.hydrate(row);
    });
  }

  async markPlan(planId: string, status: PlanStatus): Promise<ExecutionPlan> {
    return await this.database.transaction(async () => {
      await this.database.records.update("plans", { id: planId }, () => ({ status: storedPlanStatus(status), updated_at: Date.now() }));
      return await this.get(planId);
    });
  }

  async startStep(planId: string, stepId: string): Promise<ExecutionPlan> {
    return await this.database.transaction(async () => {
      const now = Date.now();
      await this.database.records.update("plans", { id: planId }, () => ({ status: "running" as const, updated_at: now }));
      await this.database.records.update("plan_steps", { plan_id: planId, step_id: stepId, status: "pending" }, () => ({ status: "running" as const, started_at: now }));
      return await this.get(planId);
    });
  }

  async completeStep(planId: string, stepId: string, output: string, evidence: StepEvidence): Promise<ExecutionPlan> {
    return await this.database.transaction(async () => {
      const now = Date.now(), plan = await this.get(planId);
      await new RunInputRepository(this.database).assertDrained(plan.runId);
      const run = (await this.database.records.find("runs", { id: plan.runId }))[0];
      if (run?.status === "running") await this.database.records.update("plan_steps", { plan_id: planId, step_id: stepId, status: "running" as const },
        () => ({ status: "completed" as const, output, evidence_json: JSON.stringify(evidence), finished_at: now }));
      await this.database.records.update("plans", { id: planId }, () => ({ updated_at: now }));
      return await this.get(planId);
    });
  }

  async failStep(planId: string, stepId: string, error: string): Promise<ExecutionPlan> {
    return await this.database.transaction(async () => {
      const now = Date.now();
      await this.database.records.update("plan_steps", { plan_id: planId, step_id: stepId }, () => ({ status: "failed" as const, error, finished_at: now }));
      await this.database.records.update("plans", { id: planId }, () => ({ status: "failed" as const, updated_at: now }));
      return await this.get(planId);
    });
  }

  async saveAssessment(assessment: SkillComplianceAssessment): Promise<void> {
    await this.database.records.insert("skill_compliance_assessments", { id: assessment.id, plan_id: assessment.planId, step_id: assessment.stepId,
      attempt: assessment.attempt, assessment_profile: assessment.assessmentProfile ?? "result_judged", assessment_method: assessment.assessmentMethod ?? "model",
      approved: assessment.approved ? 1 : 0, criteria_json: JSON.stringify(assessment.criteria), skills_json: JSON.stringify(assessment.skills),
      evidence_digest: assessment.evidenceDigest, feedback: assessment.feedback,
      failed_boundary_json: assessment.failedBoundary === undefined ? null : JSON.stringify(assessment.failedBoundary),
      decision_bindings_json: JSON.stringify(assessment.decisionBindings ?? []), created_at: assessment.createdAt });
  }

  async assessments(planId: string): Promise<SkillComplianceAssessment[]> {
    const rows = (await this.database.records.find("skill_compliance_assessments", { plan_id: planId })).sort(ascending("step_id", "attempt"));
    return rows.map((row) => ({
      id: row.id,
      planId: row.plan_id,
      stepId: row.step_id,
      attempt: row.attempt,
      assessmentProfile: parseAssessmentProfile(row.assessment_profile),
      assessmentMethod: parseAssessmentMethod(row.assessment_method),
      approved: row.approved === 1,
      criteria: JSON.parse(row.criteria_json),
      decisionBindings: JSON.parse(row.decision_bindings_json ?? "[]"),
      skills: JSON.parse(row.skills_json),
      evidenceDigest: row.evidence_digest,
      feedback: row.feedback,
      ...(row.failed_boundary_json === null ? {} : { failedBoundary: JSON.parse(row.failed_boundary_json) }),
      createdAt: row.created_at,
    }));
  }

  async validateRevision(input: PlanRevisionInput): Promise<ExecutionPlan> {
    const current = await this.get(input.planId);
    const next = input.proposal;
    if (next.runId !== current.runId) throw invalidRevision("Plan revision must remain in the same Run");
    if (input.steerMessageId !== undefined) {
      const message = (await this.database.records.find("run_input_messages", { id: input.steerMessageId, run_id: current.runId, status: "processing" }))[0];
      if (message === undefined) throw invalidRevision("Steer revision requires the current durable input decision");
    }
    const currentById = new Map(current.steps.map((step) => [step.id, step]));
    const proposedById = new Map(next.steps.map((step) => [step.id, step]));
    for (const step of current.steps.filter((item) => item.retiredAt === undefined)) {
      const proposed = proposedById.get(step.id);
      if (
        proposed !== undefined
        && !samePlanStepDefinition(step, proposed)
        && !isSafeRecoveryDependencyRewire(step, proposed, currentById, input.retiredStepIds)
      ) {
        throw invalidRevision(`Plan revision cannot alter existing step ${step.id}`);
      }
      if (step.status === "completed" && proposed === undefined && input.steerMessageId === undefined) {
        throw invalidRevision(`Plan revision cannot remove completed step ${step.id}`);
      }
    }
    for (const step of current.steps) {
      if (proposedById.has(step.id) || step.retiredAt !== undefined) continue;
      if (!input.retiredStepIds.includes(step.id)) {
        throw invalidRevision(`Plan revision must explicitly retire omitted step ${step.id}`);
      }
      if (step.status === "completed" && input.steerMessageId === undefined) throw invalidRevision(`Plan revision cannot retire completed step ${step.id}`);
    }
    for (const stepId of input.retiredStepIds) {
      const step = currentById.get(stepId);
      if (step === undefined || (step.status === "completed" && input.steerMessageId === undefined) || step.retiredAt !== undefined) {
        throw invalidRevision(`Plan revision cannot retire step ${stepId}`);
      }
      if (proposedById.has(stepId)) throw invalidRevision(`Retired step ${stepId} is still in the revised Plan`);
    }
    return current;
  }

  async revise(input: PlanRevisionInput): Promise<ExecutionPlan> {
    return await this.database.transaction(async () => {
      const current = await this.validateRevision(input), next = input.proposal, now = Date.now();
      const currentById = new Map(current.steps.map(step => [step.id, step]));
      await this.saveSnapshot(current, "before_revision", input.actionId, now);
      await this.database.records.update("plans", { id: current.id }, () => ({ version: current.version + 1, goal: next.goal,
        selected_skill_ids_json: JSON.stringify(next.selectedSkillIds), input_bindings_json: JSON.stringify(next.resultBindings ?? []),
        canonical_state_ref_json: JSON.stringify(next.canonicalStateRef), status: "running" as const, updated_at: now }));
      let nextPosition = Math.max(-1, ...current.steps.map(step => step.position)) + 1;
      for (const step of next.steps) {
        const existing = currentById.get(step.id);
        if (existing) {
          if (JSON.stringify(existing.dependencies) !== JSON.stringify(step.dependencies)) {
            await this.database.records.update("plan_steps", { plan_id: current.id, step_id: step.id }, row =>
              row.status === "pending" || row.status === "failed" ? { dependencies_json: JSON.stringify(step.dependencies) } : undefined);
          }
        } else await this.insertStep(current.id, { ...step, position: nextPosition++, status: "pending" });
      }
      for (const stepId of input.retiredStepIds) await this.database.records.insert("plan_step_retirements", {
        plan_id: current.id, step_id: stepId, action_id: input.actionId, reason: input.reason, retired_at: now });
      await this.saveRoundScope({ ...next, ...(next.roundScope === undefined && current.roundScope !== undefined ? { roundScope: current.roundScope } : {}), id: current.id, version: current.version + 1 });
      const revised = await this.get(current.id);
      await this.saveSnapshot(revised, "recovery_revision", input.actionId, now);
      return revised;
    });
  }

  private async hydrate(row: PlanRow): Promise<ExecutionPlan> {
    const scopeRow = (await this.database.records.find("plan_round_scopes", { plan_id: row.id, plan_version: row.version }))[0];
    const roundScope = scopeRow === undefined ? undefined : parseRoundScope(JSON.parse(scopeRow.scope_json));
    const retirements = await this.database.records.find("plan_step_retirements", { plan_id: row.id });
    const steps: StepRow[] = (await this.database.records.find("plan_steps", { plan_id: row.id })).sort(ascending("position")).map(step => {
      const retired = retirements.find(item => item.step_id === step.step_id);
      return { ...step, role: step.role as StepRow["role"], retired_at: retired?.retired_at ?? null, retirement_reason: retired?.reason ?? null };
    });
    return {
      id: row.id,
      runId: row.run_id,
      version: row.version,
      goal: row.goal,
      selectedSkillIds: JSON.parse(row.selected_skill_ids_json),
      canonicalStateRef: parseCanonicalStateRef(row.canonical_state_ref_json, row.run_id),
      resultBindings: parseResultBindings(row.input_bindings_json),
      ...(roundScope === undefined ? {} : { roundScope }),
      status: row.status,
      steps: steps.map(toStep),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async saveSnapshot(plan: ExecutionPlan, reason: string, actionId: string | undefined, createdAt: number): Promise<void> {
    const proposal = {
      goal: plan.goal,
      selectedSkillIds: plan.selectedSkillIds,
      canonicalStateRef: plan.canonicalStateRef,
      resultBindings: plan.resultBindings ?? [],
      ...(plan.roundScope === undefined ? {} : { roundScope: plan.roundScope }),
      steps: plan.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        ...(step.parentId === undefined ? {} : { parentId: step.parentId }),
        objective: step.objective,
        dependencies: step.dependencies,
        refinementState: step.refinementState,
        requiredFacts: step.requiredFacts,
        skillIds: step.skillIds,
        requiredCapabilities: step.requiredCapabilities,
        executionBinding: step.executionBinding,
        ...(step.evidenceContract === undefined ? {} : { evidenceContract: step.evidenceContract }),
        successCriteria: step.successCriteria,
        status: step.status,
        ...(step.retiredAt === undefined ? {} : { retiredAt: step.retiredAt }),
      })),
    };
    await this.database.records.insert("plan_revision_snapshots", { plan_id: plan.id, version: plan.version,
      proposal_json: JSON.stringify(proposal), reason, action_id: actionId ?? null, created_at: createdAt }, "ignore");
  }

  private async saveRoundScope(plan: ExecutionPlan): Promise<void> {
    if (plan.roundScope === undefined) return;
    await this.database.records.insert("plan_round_scopes", { plan_id: plan.id, plan_version: plan.version, scope_json: JSON.stringify(plan.roundScope) });
  }
}

function parseCanonicalStateRef(value: string | null | undefined, runId: string): CanonicalRunStateRef {
  if (value === undefined || value === null) {
    throw new Error(`Plan for Run ${runId} has no canonical state reference; replan required`);
  }
  const parsed = JSON.parse(value) as Partial<CanonicalRunStateRef>;
  if (
    typeof parsed.stateId !== "string"
    || parsed.runId !== runId
    || typeof parsed.intentId !== "string"
    || typeof parsed.revision !== "number"
  ) {
    throw new Error(`Plan for Run ${runId} has an invalid canonical state reference; replan required`);
  }
  return parsed as CanonicalRunStateRef;
}

function parseAssessmentProfile(value: string | undefined): AssessmentProfileId {
  if (
    value === "deterministic"
    || value === "evidence_gate"
    || value === "lookup_lite"
    || value === "source_grounded"
    || value === "result_judged"
    || value === "risk_sensitive"
  ) {
    return value;
  }
  return "source_grounded";
}

function parseAssessmentMethod(value: string | undefined): AssessmentMethod {
  return value === "rule" || value === "model" ? value : "model";
}

function parseResultBindings(value: string | undefined): readonly RuntimeResultBinding[] {
  if (value === undefined) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Plan has invalid input bindings; replan required");
  return parsed.map((binding) => {
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
      throw new Error("Plan has invalid input binding; replan required");
    }
    const parsedBinding = parseRuntimeResultBinding(binding);
    if (parsedBinding === undefined || parsedBinding.relation === "dependency") {
      throw new Error("Plan has invalid input binding; replan required");
    }
    return parsedBinding;
  });
}

function toStep(row: StepRow): PlanStep {
  const evidenceContract = row.evidence_contract_json === null ? undefined : JSON.parse(row.evidence_contract_json);
  if (row.execution_binding_json === undefined || row.execution_binding_json === null) {
    throw new Error(`Plan step ${row.step_id} lacks execution binding; replan required`);
  }
  const executionBinding = JSON.parse(row.execution_binding_json);
  if (
    executionBinding.schema !== "agentloop.stepExecutionBinding/v1"
    || !Array.isArray(executionBinding.requiredCapabilities)
    || !Array.isArray(executionBinding.targetIds)
    || !Array.isArray(executionBinding.evidenceProducers)
    || !executionBinding.evidenceProducers.every(isValidEvidenceProducerBinding)
    || (executionBinding.inputResultRefs !== undefined && (!Array.isArray(executionBinding.inputResultRefs)
      || !executionBinding.inputResultRefs.every((ref: unknown) => parseRuntimeResultRef(ref) !== undefined)))
  ) {
    throw new Error(`Plan step ${row.step_id} has invalid execution binding; replan required`);
  }
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
    requiredCapabilities: executionBinding.requiredCapabilities,
    executionBinding,
    ...(executionBinding.inputResultRefs === undefined ? {} : { inputResultRefs: executionBinding.inputResultRefs }),
    ...(evidenceContract === undefined ? {} : { evidenceContract }),
    successCriteria: JSON.parse(row.success_criteria_json),
    status: row.status,
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.evidence_json === null ? {} : { evidence: parseStepEvidence(row.evidence_json, row.plan_id, row.step_id) }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    ...(row.retirement_reason === null ? {} : { retirementReason: row.retirement_reason }),
  };
}

function isValidEvidenceProducerBinding(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const producer = value as Record<string, unknown>;
  return typeof producer.evidenceKind === "string"
    && producer.evidenceKind.trim().length > 0
    && typeof producer.capabilityId === "string"
    && producer.capabilityId.trim().length > 0
    && Array.isArray(producer.resolvedToolNames)
    && producer.resolvedToolNames.every((toolName) => typeof toolName === "string" && toolName.trim().length > 0);
}

function parseStepEvidence(value: string, planId: string, stepId: string): StepEvidence {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Plan step ${stepId} has invalid evidence; recovery required`);
  }
  const evidence = parsed as Record<string, unknown>;
  if (evidence.publishedResult === undefined) return parsed as StepEvidence;
  const publishedResult = parseRuntimeResult(evidence.publishedResult);
  if (
    publishedResult === undefined
    || publishedResult.kind !== "step"
    || publishedResult.producer.planId !== planId
    || publishedResult.producer.stepId !== stepId
  ) {
    throw new Error(`Plan step ${stepId} has an invalid published Runtime result; recovery required`);
  }
  return { ...evidence, publishedResult } as unknown as StepEvidence;
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
    && JSON.stringify(left.requiredCapabilities) === JSON.stringify(right.requiredCapabilities)
    && JSON.stringify(left.executionBinding) === JSON.stringify(right.executionBinding)
    && JSON.stringify(left.evidenceContract ?? null) === JSON.stringify(right.evidenceContract ?? null)
    && JSON.stringify(left.successCriteria) === JSON.stringify(right.successCriteria);
}

function isSafeRecoveryDependencyRewire(
  current: PlanStep,
  proposed: PlanStep,
  currentById: ReadonlyMap<string, PlanStep>,
  retiredStepIds: readonly string[],
): boolean {
  if (current.status !== "pending" && current.status !== "failed") return false;
  if (!samePlanStepDefinition({ ...current, dependencies: proposed.dependencies }, proposed)) return false;
  const removed = current.dependencies.filter((dependency) => !proposed.dependencies.includes(dependency));
  const added = proposed.dependencies.filter((dependency) => !current.dependencies.includes(dependency));
  return removed.length > 0
    && removed.length === added.length
    && removed.every((dependency) => retiredStepIds.includes(dependency))
    && added.every((dependency) => !currentById.has(dependency));
}

function invalidRevision(message: string): AppError {
  return new AppError("PLAN_NOT_ADMITTED", message, 422, { recoveryStage: "definition" });
}

function storedPlanStatus(status: PlanStatus): Exclude<PlanStatus, "pending"> {
  if (status === "pending") throw new AppError("CONFLICT", "A pending Plan must be admitted before persistence", 409);
  return status;
}
