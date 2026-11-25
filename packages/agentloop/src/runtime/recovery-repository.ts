import { readRunEvents } from "../storage/run-event-store.ts";
import { randomUUID } from "node:crypto";
import { ascending, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import { appendRunEvent } from "../storage/repositories/run-event-sequencer.ts";
import { AppError } from "../shared/errors.ts";
import type { PlanProposal, PlanRevisionAssessment } from "../planning/contracts.ts";
import type { RecoveryDecisionKind, RecoveryDecisionProposal } from "./recovery-planning.ts";

export type RecoveryDecisionState = "submitted" | "admitted" | "rejected";
export type RunRecoveryStateKind = "waiting_recovery" | "waiting_user" | "ready_to_resume";

export interface RecoveryDecisionRecord extends RecoveryDecisionProposal {
  readonly id: string;
  readonly runId: string;
  readonly state: RecoveryDecisionState;
  readonly rejectionCode?: string;
  readonly createdAt: number;
  readonly resolvedAt?: number;
}

export interface RunRecoveryState {
  readonly runId: string;
  readonly state: RunRecoveryStateKind;
  readonly actionId: string;
  readonly question?: string;
  readonly updatedAt: number;
}

export interface PlanRevisionAssessmentRecord extends PlanRevisionAssessment {
  readonly id: string;
  readonly recoveryDecisionId: string;
  readonly planId: string;
  readonly createdAt: number;
}

export interface RecoveryUserResponse {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly response: string;
  readonly createdAt: number;
}

export type RecoveryEventLogSink = (event: {
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}) => void;

interface DecisionRow {
  id: string;
  run_id: string;
  action_id: string;
  expected_action_revision: number;
  decision: RecoveryDecisionKind;
  rationale: string;
  evidence_refs_json: string;
  plan_revision_json: string | null;
  question: string | null;
  state: RecoveryDecisionState;
  rejection_code: string | null;
  created_at: number;
  resolved_at: number | null;
}

interface RecoveryStateRow {
  run_id: string;
  state: RunRecoveryStateKind;
  action_id: string;
  question: string | null;
  updated_at: number;
}

export class RecoveryRepository {
  private readonly database: RuntimePersistence;
  private readonly eventLogSink?: RecoveryEventLogSink;

  constructor(database: RuntimePersistenceInput, eventLogSink?: RecoveryEventLogSink) {
    this.database = runtimePersistence(database);
    this.eventLogSink = eventLogSink;
  }

  async state(runId: string): Promise<RunRecoveryState | undefined> {
    const row = (await this.database.records.find("run_recovery_states", { run_id: runId }))[0];
    return row === undefined ? undefined : toRecoveryState(row);
  }

  async list(runId: string): Promise<RecoveryDecisionRecord[]> {
    const rows = (await this.database.records.find("recovery_decisions", { run_id: runId })).sort(ascending("created_at", "id"));
    return rows.map(toDecisionRecord);
  }

  /** Serialize durable candidate reservations on the owning Action across Runtime workers. */
  async beginProposalAttempt(runId: string, actionId: string, revision: number, limit: number): Promise<number> {
    return this.database.transaction(async () => {
      const action = (await this.database.records.find("runtime_actions", { id: actionId, run_id: runId }))[0];
      if (action?.state !== "recovery_required" || action.revision !== revision) {
        throw new AppError("CONFLICT", "Recovery Action changed before proposal reservation", 409);
      }
      const rows = await readRunEvents(this.database, runId, "recovery.proposal_attempt_started");
      const attempt = rows.map(row => JSON.parse(row.payload_json) as { actionId: string; expectedActionRevision: number })
        .filter(data => data.actionId === actionId && data.expectedActionRevision === revision).length + 1;
      if (attempt > limit) throw new AppError("PLANNING_ERROR", "Recovery proposal budget exhausted for this Action revision", 422,
        { recoveryProposalBudgetExhausted: true });
      await this.appendEvent(runId, "recovery.proposal_attempt_started", {
        actionId, expectedActionRevision: revision, attempt, limit,
      }, Date.now());
      return attempt;
    });
  }

  async submit(runId: string, proposal: RecoveryDecisionProposal): Promise<RecoveryDecisionRecord> {
    const now = Date.now();
    const id = randomUUID();
    await this.database.transaction(async () => {
      const action = (await this.database.records.find("runtime_actions", { id: proposal.actionId }))[0];
      if (action === undefined || action.run_id !== runId) throw new AppError("NOT_FOUND", "Recovery Action not found", 404);
      if (action.state !== "recovery_required") {
        throw new AppError("CONFLICT", "Recovery decision requires a recovery_required Action", 409);
      }
      if (action.revision !== proposal.expectedActionRevision) {
        throw new AppError("CONFLICT", "Recovery Action revision changed before decision submission", 409);
      }
      const unresolved = (await this.database.records.find("recovery_decisions", { action_id: proposal.actionId, state: "submitted" }))[0];
      if (unresolved !== undefined) throw new AppError("CONFLICT", "Recovery Action already has a current decision", 409);
      await this.database.records.insert("recovery_decisions", { id, run_id: runId, action_id: proposal.actionId,
        expected_action_revision: proposal.expectedActionRevision, decision: proposal.decision, rationale: proposal.rationale,
        evidence_refs_json: JSON.stringify(proposal.evidenceRefs), plan_revision_json: proposal.planRevision === undefined ? null : JSON.stringify(proposal.planRevision),
        question: proposal.question ?? null, state: "submitted", created_at: now });
      await this.appendEvent(runId, "recovery.decision_submitted", {
        decisionId: id,
        actionId: proposal.actionId,
        expectedActionRevision: proposal.expectedActionRevision,
        decision: proposal.decision,
        evidenceRefs: proposal.evidenceRefs,
        ...(proposal.planRevision === undefined ? {} : {
          retainedStepIds: proposal.planRevision.retainedStepIds ?? [],
          proposedNewStepIds: proposal.planRevision.steps.map(step => step.id),
        }),
      }, now);
    });
    return await this.require(id);
  }

  async admit(decisionId: string, state?: { kind: RunRecoveryStateKind; question?: string }): Promise<RecoveryDecisionRecord> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const decision = await this.requireRow(decisionId);
      const action = (await this.database.records.find("runtime_actions", { id: decision.action_id }))[0];
      if (
        decision.state !== "submitted"
        || action?.state !== "recovery_required"
        || action.revision !== decision.expected_action_revision
      ) {
        throw new AppError("CONFLICT", "Recovery facts changed before decision admission", 409);
      }
      await this.database.records.update("recovery_decisions", { id: decisionId, state: "submitted" }, () => ({ state: "admitted" as const, resolved_at: now }));
      if (state === undefined) {
        await this.database.records.remove("run_recovery_states", { run_id: decision.run_id, action_id: decision.action_id });
      } else {
        await this.database.records.insert("run_recovery_states", { run_id: decision.run_id, state: state.kind,
          action_id: decision.action_id, question: state.question ?? null, updated_at: now }, "replace");
      }
      await this.appendEvent(decision.run_id, "recovery.decision_admitted", {
        decisionId,
        actionId: decision.action_id,
        decision: decision.decision,
      }, now);
    });
    return await this.require(decisionId);
  }

  async reject(decisionId: string, code: string, message: string): Promise<RecoveryDecisionRecord> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const decision = await this.requireRow(decisionId);
      const changed = await this.database.records.update("recovery_decisions", { id: decisionId, state: "submitted" },
        () => ({ state: "rejected" as const, rejection_code: code, resolved_at: now }));
      if (changed !== 1) throw new AppError("CONFLICT", "Recovery decision is no longer pending", 409);
      await this.appendEvent(decision.run_id, "recovery.decision_rejected", {
        decisionId,
        actionId: decision.action_id,
        decision: decision.decision,
        code,
        message,
      }, now);
    });
    return await this.require(decisionId);
  }

  async submitUserResponse(runId: string, response: string): Promise<RecoveryUserResponse> {
    const id = randomUUID();
    const now = Date.now();
    let actionId = "";
    await this.database.transaction(async () => {
      const state = (await this.database.records.find("run_recovery_states", { run_id: runId }))[0];
      if (state?.state !== "waiting_user") {
        throw new AppError("CONFLICT", "Run is not waiting for a user recovery response", 409);
      }
      const action = (await this.database.records.find("runtime_actions", { id: state.action_id, run_id: runId }))[0];
      if (action?.state !== "recovery_required") {
        throw new AppError("CONFLICT", "Recovery Action is no longer available", 409);
      }
      actionId = state.action_id;
      await this.database.records.insert("recovery_user_responses", { id, run_id: runId, action_id: actionId, response, created_at: now });
      await this.database.records.update("run_recovery_states", { run_id: runId, state: "waiting_user", action_id: actionId },
        () => ({ state: "waiting_recovery" as const, question: null, updated_at: now }));
      await this.appendEvent(runId, "recovery.user_responded", { actionId, response }, now);
    });
    return { id, runId, actionId, response, createdAt: now };
  }

  async beginResume(runId: string, actionId: string): Promise<void> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const state = (await this.database.records.find("run_recovery_states", { run_id: runId }))[0];
      const action = (await this.database.records.find("runtime_actions", { id: actionId, run_id: runId }))[0];
      if (state?.state !== "ready_to_resume" || state.action_id !== actionId || action?.state !== "recovery_required") {
        throw new AppError("CONFLICT", "Run is not ready to resume this Recovery Action", 409);
      }
      await this.database.records.remove("run_recovery_states", { run_id: runId, action_id: actionId });
      await this.appendEvent(runId, "recovery.resume_started", { actionId }, now);
    });
  }

  async restoreRecovery(runId: string, actionId: string, reason: string): Promise<void> {
    const now = Date.now();
    await this.database.transaction(async () => {
      const action = (await this.database.records.find("runtime_actions", { id: actionId, run_id: runId }))[0];
      if (action?.state !== "recovery_required") {
        throw new AppError("CONFLICT", "Recovery Action is no longer available", 409);
      }
      await this.database.records.insert("run_recovery_states", { run_id: runId, state: "waiting_recovery", action_id: actionId, question: null, updated_at: now }, "replace");
      await this.appendEvent(runId, "recovery.resume_interrupted", { actionId, reason }, now);
    });
  }

  async userResponses(runId: string): Promise<RecoveryUserResponse[]> {
    const rows = (await this.database.records.find("recovery_user_responses", { run_id: runId })).sort(ascending("created_at", "id"));
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      actionId: row.action_id,
      response: row.response,
      createdAt: row.created_at,
    }));
  }

  async savePlanRevisionAssessment(input: {
    decisionId: string;
    planId: string;
    assessment: PlanRevisionAssessment;
  }): Promise<PlanRevisionAssessmentRecord> {
    const now = Date.now();
    const id = randomUUID();
    await this.database.transaction(async () => {
      const decision = await this.requireRow(input.decisionId);
      if (decision.state !== "submitted" || decision.decision !== "revise_plan") {
        throw new AppError("CONFLICT", "Plan revision assessment requires a submitted revise_plan decision", 409);
      }
      await this.database.records.insert("plan_revision_assessments", { id, recovery_decision_id: input.decisionId, plan_id: input.planId,
        approved: input.assessment.approved ? 1 : 0, feedback: input.assessment.feedback,
        evidence_refs_json: JSON.stringify(input.assessment.evidenceRefs), created_at: now });
      await this.appendEvent(decision.run_id, "plan.revision_assessed", {
        decisionId: input.decisionId,
        planId: input.planId,
        approved: input.assessment.approved,
        evidenceRefs: input.assessment.evidenceRefs,
      }, now);
    });
    return {
      id,
      recoveryDecisionId: input.decisionId,
      planId: input.planId,
      approved: input.assessment.approved,
      feedback: input.assessment.feedback,
      evidenceRefs: input.assessment.evidenceRefs,
      createdAt: now,
    };
  }

  async planRevisionAssessments(runId: string): Promise<PlanRevisionAssessmentRecord[]> {
    const decisions = await this.database.records.find("recovery_decisions", { run_id: runId });
    const rows = (await Promise.all(decisions.map(row => this.database.records.find("plan_revision_assessments", { recovery_decision_id: row.id })))).flat().sort(ascending("created_at", "id"));
    return rows.map((row) => ({
      id: row.id,
      recoveryDecisionId: row.recovery_decision_id,
      planId: row.plan_id,
      approved: row.approved === 1,
      feedback: row.feedback,
      evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
      createdAt: row.created_at,
    }));
  }

  private async require(id: string): Promise<RecoveryDecisionRecord> {
    return toDecisionRecord(await this.requireRow(id));
  }

  private async requireRow(id: string): Promise<DecisionRow> {
    const row = (await this.database.records.find("recovery_decisions", { id }))[0];
    if (row === undefined) throw new AppError("NOT_FOUND", "Recovery decision not found", 404);
    return row;
  }

  private async appendEvent(runId: string, type: string, data: Readonly<Record<string, unknown>>, createdAt: number): Promise<void> {
    const seq = await appendRunEvent(this.database, runId, { type, data, createdAt });
    this.eventLogSink?.({ runId, seq, type, data, createdAt });
  }
}

function toDecisionRecord(row: DecisionRow): RecoveryDecisionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    actionId: row.action_id,
    expectedActionRevision: row.expected_action_revision,
    decision: row.decision,
    rationale: row.rationale,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    ...(row.plan_revision_json === null ? {} : { planRevision: JSON.parse(row.plan_revision_json) as PlanProposal }),
    ...(row.question === null ? {} : { question: row.question }),
    state: row.state,
    ...(row.rejection_code === null ? {} : { rejectionCode: row.rejection_code }),
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  };
}

function toRecoveryState(row: RecoveryStateRow): RunRecoveryState {
  return {
    runId: row.run_id,
    state: row.state,
    actionId: row.action_id,
    ...(row.question === null ? {} : { question: row.question }),
    updatedAt: row.updated_at,
  };
}
