import { randomUUID } from "node:crypto";
import type { SqlConnection } from "../storage/connection.ts";
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
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  state(runId: string): RunRecoveryState | undefined {
    const row = this.database.prepare("SELECT * FROM run_recovery_states WHERE run_id = ?")
      .get(runId) as RecoveryStateRow | undefined;
    return row === undefined ? undefined : toRecoveryState(row);
  }

  list(runId: string): RecoveryDecisionRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM recovery_decisions WHERE run_id = ? ORDER BY created_at, id
    `).all(runId) as unknown as DecisionRow[];
    return rows.map(toDecisionRecord);
  }

  submit(runId: string, proposal: RecoveryDecisionProposal): RecoveryDecisionRecord {
    const now = Date.now();
    const id = randomUUID();
    this.database.transaction(() => {
      const action = this.database.prepare(`
        SELECT run_id, state, revision FROM runtime_actions WHERE id = ?
      `).get(proposal.actionId) as { run_id: string; state: string; revision: number } | undefined;
      if (action === undefined || action.run_id !== runId) throw new AppError("NOT_FOUND", "Recovery Action not found", 404);
      if (action.state !== "recovery_required") {
        throw new AppError("CONFLICT", "Recovery decision requires a recovery_required Action", 409);
      }
      if (action.revision !== proposal.expectedActionRevision) {
        throw new AppError("CONFLICT", "Recovery Action revision changed before decision submission", 409);
      }
      const unresolved = this.database.prepare(`
        SELECT id FROM recovery_decisions WHERE action_id = ? AND state = 'submitted' LIMIT 1
      `).get(proposal.actionId) as { id: string } | undefined;
      if (unresolved !== undefined) throw new AppError("CONFLICT", "Recovery Action already has a current decision", 409);
      this.database.prepare(`
        INSERT INTO recovery_decisions(
          id, run_id, action_id, expected_action_revision, decision, rationale,
          evidence_refs_json, plan_revision_json, question, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)
      `).run(
        id,
        runId,
        proposal.actionId,
        proposal.expectedActionRevision,
        proposal.decision,
        proposal.rationale,
        JSON.stringify(proposal.evidenceRefs),
        proposal.planRevision === undefined ? null : JSON.stringify(proposal.planRevision),
        proposal.question ?? null,
        now,
      );
      this.appendEvent(runId, "recovery.decision_submitted", {
        decisionId: id,
        actionId: proposal.actionId,
        expectedActionRevision: proposal.expectedActionRevision,
        decision: proposal.decision,
        evidenceRefs: proposal.evidenceRefs,
      }, now);
    });
    return this.require(id);
  }

  admit(decisionId: string, state?: { kind: RunRecoveryStateKind; question?: string }): RecoveryDecisionRecord {
    const now = Date.now();
    this.database.transaction(() => {
      const decision = this.requireRow(decisionId);
      const action = this.database.prepare(`SELECT state, revision FROM runtime_actions WHERE id = ?`)
        .get(decision.action_id) as { state: string; revision: number } | undefined;
      if (
        decision.state !== "submitted"
        || action?.state !== "recovery_required"
        || action.revision !== decision.expected_action_revision
      ) {
        throw new AppError("CONFLICT", "Recovery facts changed before decision admission", 409);
      }
      this.database.prepare(`
        UPDATE recovery_decisions SET state = 'admitted', resolved_at = ? WHERE id = ? AND state = 'submitted'
      `).run(now, decisionId);
      if (state === undefined) {
        this.database.prepare("DELETE FROM run_recovery_states WHERE run_id = ? AND action_id = ?")
          .run(decision.run_id, decision.action_id);
      } else {
        this.database.prepare(`
          INSERT INTO run_recovery_states(run_id, state, action_id, question, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            state = excluded.state, action_id = excluded.action_id,
            question = excluded.question, updated_at = excluded.updated_at
        `).run(decision.run_id, state.kind, decision.action_id, state.question ?? null, now);
      }
      this.appendEvent(decision.run_id, "recovery.decision_admitted", {
        decisionId,
        actionId: decision.action_id,
        decision: decision.decision,
      }, now);
    });
    return this.require(decisionId);
  }

  reject(decisionId: string, code: string, message: string): RecoveryDecisionRecord {
    const now = Date.now();
    this.database.transaction(() => {
      const decision = this.requireRow(decisionId);
      const result = this.database.prepare(`
        UPDATE recovery_decisions
        SET state = 'rejected', rejection_code = ?, resolved_at = ?
        WHERE id = ? AND state = 'submitted'
      `).run(code, now, decisionId) as { changes: number };
      if (result.changes !== 1) throw new AppError("CONFLICT", "Recovery decision is no longer pending", 409);
      this.appendEvent(decision.run_id, "recovery.decision_rejected", {
        decisionId,
        actionId: decision.action_id,
        decision: decision.decision,
        code,
        message,
      }, now);
    });
    return this.require(decisionId);
  }

  submitUserResponse(runId: string, response: string): RecoveryUserResponse {
    const id = randomUUID();
    const now = Date.now();
    let actionId = "";
    this.database.transaction(() => {
      const state = this.database.prepare(`
        SELECT state, action_id FROM run_recovery_states WHERE run_id = ?
      `).get(runId) as { state: RunRecoveryStateKind; action_id: string } | undefined;
      if (state?.state !== "waiting_user") {
        throw new AppError("CONFLICT", "Run is not waiting for a user recovery response", 409);
      }
      const action = this.database.prepare(`
        SELECT state FROM runtime_actions WHERE id = ? AND run_id = ?
      `).get(state.action_id, runId) as { state: string } | undefined;
      if (action?.state !== "recovery_required") {
        throw new AppError("CONFLICT", "Recovery Action is no longer available", 409);
      }
      actionId = state.action_id;
      this.database.prepare(`
        INSERT INTO recovery_user_responses(id, run_id, action_id, response, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, runId, actionId, response, now);
      this.database.prepare(`
        UPDATE run_recovery_states
        SET state = 'waiting_recovery', question = NULL, updated_at = ?
        WHERE run_id = ? AND state = 'waiting_user' AND action_id = ?
      `).run(now, runId, actionId);
      this.appendEvent(runId, "recovery.user_responded", { actionId, response }, now);
    });
    return { id, runId, actionId, response, createdAt: now };
  }

  beginResume(runId: string, actionId: string): void {
    const now = Date.now();
    this.database.transaction(() => {
      const state = this.database.prepare(`
        SELECT state, action_id FROM run_recovery_states WHERE run_id = ?
      `).get(runId) as { state: RunRecoveryStateKind; action_id: string } | undefined;
      const action = this.database.prepare(`
        SELECT state FROM runtime_actions WHERE id = ? AND run_id = ?
      `).get(actionId, runId) as { state: string } | undefined;
      if (state?.state !== "ready_to_resume" || state.action_id !== actionId || action?.state !== "recovery_required") {
        throw new AppError("CONFLICT", "Run is not ready to resume this Recovery Action", 409);
      }
      this.database.prepare("DELETE FROM run_recovery_states WHERE run_id = ? AND action_id = ?")
        .run(runId, actionId);
      this.appendEvent(runId, "recovery.resume_started", { actionId }, now);
    });
  }

  restoreRecovery(runId: string, actionId: string, reason: string): void {
    const now = Date.now();
    this.database.transaction(() => {
      const action = this.database.prepare(`
        SELECT state FROM runtime_actions WHERE id = ? AND run_id = ?
      `).get(actionId, runId) as { state: string } | undefined;
      if (action?.state !== "recovery_required") {
        throw new AppError("CONFLICT", "Recovery Action is no longer available", 409);
      }
      this.database.prepare(`
        INSERT INTO run_recovery_states(run_id, state, action_id, question, updated_at)
        VALUES (?, 'waiting_recovery', ?, NULL, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          state = excluded.state, action_id = excluded.action_id,
          question = NULL, updated_at = excluded.updated_at
      `).run(runId, actionId, now);
      this.appendEvent(runId, "recovery.resume_interrupted", { actionId, reason }, now);
    });
  }

  userResponses(runId: string): RecoveryUserResponse[] {
    const rows = this.database.prepare(`
      SELECT id, run_id, action_id, response, created_at
      FROM recovery_user_responses WHERE run_id = ? ORDER BY created_at, id
    `).all(runId) as unknown as Array<{
      id: string; run_id: string; action_id: string; response: string; created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      actionId: row.action_id,
      response: row.response,
      createdAt: row.created_at,
    }));
  }

  savePlanRevisionAssessment(input: {
    decisionId: string;
    planId: string;
    assessment: PlanRevisionAssessment;
  }): PlanRevisionAssessmentRecord {
    const now = Date.now();
    const id = randomUUID();
    this.database.transaction(() => {
      const decision = this.requireRow(input.decisionId);
      if (decision.state !== "submitted" || decision.decision !== "revise_plan") {
        throw new AppError("CONFLICT", "Plan revision assessment requires a submitted revise_plan decision", 409);
      }
      this.database.prepare(`
        INSERT INTO plan_revision_assessments(
          id, recovery_decision_id, plan_id, approved, feedback, evidence_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.decisionId,
        input.planId,
        input.assessment.approved ? 1 : 0,
        input.assessment.feedback,
        JSON.stringify(input.assessment.evidenceRefs),
        now,
      );
      this.appendEvent(decision.run_id, "plan.revision_assessed", {
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

  planRevisionAssessments(runId: string): PlanRevisionAssessmentRecord[] {
    const rows = this.database.prepare(`
      SELECT assessments.id, assessments.recovery_decision_id, assessments.plan_id,
             assessments.approved, assessments.feedback, assessments.evidence_refs_json,
             assessments.created_at
      FROM plan_revision_assessments AS assessments
      JOIN recovery_decisions AS decisions ON decisions.id = assessments.recovery_decision_id
      WHERE decisions.run_id = ?
      ORDER BY assessments.created_at, assessments.id
    `).all(runId) as unknown as Array<{
      id: string; recovery_decision_id: string; plan_id: string; approved: number;
      feedback: string; evidence_refs_json: string; created_at: number;
    }>;
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

  private require(id: string): RecoveryDecisionRecord {
    return toDecisionRecord(this.requireRow(id));
  }

  private requireRow(id: string): DecisionRow {
    const row = this.database.prepare("SELECT * FROM recovery_decisions WHERE id = ?")
      .get(id) as DecisionRow | undefined;
    if (row === undefined) throw new AppError("NOT_FOUND", "Recovery decision not found", 404);
    return row;
  }

  private appendEvent(runId: string, type: string, data: Readonly<Record<string, unknown>>, createdAt: number): void {
    const sequence = this.database.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
    ).get(runId) as { seq: number };
    this.database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sequence.seq, type, JSON.stringify(data), createdAt);
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
