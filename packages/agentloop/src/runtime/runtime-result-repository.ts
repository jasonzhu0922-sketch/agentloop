import type { SqlConnection } from "../storage/connection.ts";
import { parseRuntimeResult, parseRuntimeResultBinding, parseRuntimeResultJson, type RuntimeResultRecord } from "./runtime-result.ts";
import type { RuntimeDeliveryReceipt } from "./contracts.ts";

interface ActionResultRow {
  readonly metadata_json: string;
}

interface StepResultRow {
  readonly step_id: string;
  readonly evidence_json: string | null;
}

interface BoundStepResultRow extends StepResultRow {
  readonly plan_id: string;
  readonly run_id: string;
}

/**
 * Reads Runtime-owned results from their canonical producer records.
 *
 * Tool results live on the successful Runtime Action that committed them;
 * Step results live on the completed Plan step that published them. This keeps
 * one result protocol without creating a second result database beside the
 * existing Action/Plan authorities.
 */
export class RuntimeResultRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  /** Read a completed Run's delivery receipt through its canonical Result refs. */
  async readDeliveryReceiptForRun(runId: string): Promise<RuntimeDeliveryReceipt | undefined> {
    const outcome = await this.database.prepare(`
      SELECT result_json
      FROM run_outcomes
      WHERE run_id = ? AND status = 'completed'
    `).get(runId) as { result_json: string | null } | undefined;
    const runResult = outcome?.result_json === null || outcome?.result_json === undefined
      ? undefined
      : parseRuntimeResultJson(outcome.result_json);
    if (
      runResult?.kind !== "run"
      || runResult.publication.status !== "published"
      || runResult.producer.runId !== runId
    ) return undefined;

    const inputResultIds = new Set(runResult.inputs.map((input) => input.resultId));
    const steps = await this.database.prepare(`
      SELECT steps.evidence_json
      FROM plan_steps AS steps
      JOIN plans ON plans.id = steps.plan_id
      WHERE plans.run_id = ? AND steps.status = 'completed'
      ORDER BY steps.position ASC
    `).all(runId) as unknown as StepResultRow[];
    let receipt: RuntimeDeliveryReceipt | undefined;
    for (const step of steps) {
      const evidence = parseRecord(step.evidence_json);
      const publishedResult = parseRuntimeResult(evidence?.publishedResult);
      if (
        publishedResult?.kind !== "step"
        || !inputResultIds.has(publishedResult.ref.resultId)
        || publishedResult.producer.runId !== runId
      ) continue;
      const candidate = parseRecord(evidence?.deliveryCandidate);
      const parsedReceipt = parseDeliveryReceipt(candidate?.deliveryReceipt);
      if (parsedReceipt !== undefined) receipt = parsedReceipt;
    }
    return receipt;
  }

  async readAuthorized(input: {
    readonly resultId: string;
    readonly runId: string;
    readonly planId: string;
    readonly stepId: string;
    readonly actorUserId?: string;
    readonly conversationId?: string;
  }): Promise<RuntimeResultRecord | undefined> {
    const action = await this.database.prepare(`
      SELECT metadata_json
      FROM runtime_actions
      WHERE result_ref = ?
        AND run_id = ?
        AND plan_id = ?
        AND step_id = ?
        AND state = 'succeeded'
    `).get(input.resultId, input.runId, input.planId, input.stepId) as ActionResultRow | undefined;
    const actionResult = resultFromMetadata(action?.metadata_json);
    if (actionResult?.ref.resultId === input.resultId && actionResult.kind === "tool") return actionResult;

    const currentStep = await this.database.prepare(`
      SELECT steps.dependencies_json
      FROM plan_steps AS steps
      JOIN plans ON plans.id = steps.plan_id
      WHERE steps.plan_id = ? AND steps.step_id = ? AND plans.run_id = ?
    `).get(input.planId, input.stepId, input.runId) as { dependencies_json: string } | undefined;
    if (currentStep === undefined) return undefined;
    const dependencies = parseStringArray(currentStep.dependencies_json);
    if (dependencies.length > 0) {
      const candidates = await this.database.prepare(`
        SELECT step_id, evidence_json
        FROM plan_steps
        WHERE plan_id = ? AND status = 'completed'
      `).all(input.planId) as unknown as StepResultRow[];
      for (const candidate of candidates) {
        if (!dependencies.includes(candidate.step_id)) continue;
        const result = resultFromEvidence(candidate.evidence_json);
        if (
          result?.ref.resultId === input.resultId
          && result.kind === "step"
          && result.producer.runId === input.runId
          && result.producer.planId === input.planId
          && result.producer.stepId === candidate.step_id
        ) return result;
      }
    }
    const plan = await this.database.prepare("SELECT input_bindings_json FROM plans WHERE id = ? AND run_id = ?")
      .get(input.planId, input.runId) as { input_bindings_json: string } | undefined;
    if (!hasBoundResult(plan?.input_bindings_json, input.resultId)) return undefined;
    const archived = await this.database.prepare(`SELECT steps.step_id, steps.evidence_json FROM plan_steps AS steps
      JOIN plan_step_retirements AS retired ON retired.plan_id = steps.plan_id AND retired.step_id = steps.step_id
      JOIN runtime_actions AS decision ON decision.id = retired.action_id
      JOIN runs ON runs.id = decision.run_id
      WHERE steps.plan_id = ? AND steps.status = 'completed' AND decision.run_id = ?
        ${input.actorUserId === undefined ? "" : "AND runs.owner_user_id = ?"}`)
      .all<StepResultRow>(...(input.actorUserId === undefined ? [input.planId, input.runId] : [input.planId, input.runId, input.actorUserId]));
    for (const step of archived) {
      const result = resultFromEvidence(step.evidence_json);
      if (result?.kind === "step" && result.publication.status === "published" && result.publication.assessmentRef !== undefined
        && result.ref.resultId === input.resultId && result.producer.runId === input.runId
        && result.producer.planId === input.planId && result.producer.stepId === step.step_id) return result;
    }
    // A Round can consume an explicitly bound, assessed result from an earlier
    // Round of this very Run, even when the Run is not attached to a conversation.
    // The Round Result is the durable publication boundary, not merely the
    // presence of a completed step in an unrelated or unfinished Plan.
    const previousRounds = await this.database.prepare(`
      SELECT previous.plan_id, result.result_json, steps.step_id, steps.evidence_json
      FROM run_rounds AS current_round
      JOIN run_rounds AS previous ON previous.run_id = current_round.run_id
        AND previous.round_number < current_round.round_number AND previous.status = 'completed'
      JOIN run_round_results AS result ON result.run_id = previous.run_id
        AND result.round_number = previous.round_number AND result.plan_id = previous.plan_id
      JOIN plan_steps AS steps ON steps.plan_id = previous.plan_id AND steps.status = 'completed'
      JOIN runs ON runs.id = current_round.run_id
      WHERE current_round.run_id = ? AND current_round.plan_id = ?
        ${input.actorUserId === undefined ? "" : "AND runs.owner_user_id = ?"}
    `).all(...(input.actorUserId === undefined
      ? [input.runId, input.planId] : [input.runId, input.planId, input.actorUserId])) as unknown as Array<{
      plan_id: string; result_json: string; step_id: string; evidence_json: string | null;
    }>;
    for (const candidate of previousRounds) {
      const round = parseRecord(candidate.result_json);
      const result = resultFromEvidence(candidate.evidence_json);
      if (
        round?.schema !== "agentloop.roundResult/v1" || round.runId !== input.runId || round.planId !== candidate.plan_id
        || !Array.isArray(round.steps)
        || !round.steps.some((entry: unknown) => {
          const item = parseRecord(entry);
          const ref = parseRecord(item?.result);
          return item?.stepId === candidate.step_id && ref?.resultId === input.resultId
            && typeof item.assessmentId === "string" && item.assessmentId === result?.publication.assessmentRef;
        })
        || result?.ref.resultId !== input.resultId || result.kind !== "step"
        || result.publication.status !== "published"
        || result.producer.runId !== input.runId || result.producer.planId !== candidate.plan_id
        || result.producer.stepId !== candidate.step_id
      ) continue;
      return result;
    }
    if (input.actorUserId === undefined || input.conversationId === undefined) return undefined;
    const outcome = await this.database.prepare(`
      SELECT outcomes.result_json
      FROM run_outcomes AS outcomes
      JOIN runs ON runs.id = outcomes.run_id
      WHERE outcomes.result_ref = ?
        AND outcomes.status = 'completed'
        AND runs.owner_user_id = ?
        AND runs.conversation_id = ?
    `).get(input.resultId, input.actorUserId, input.conversationId) as { result_json: string | null } | undefined;
    const result = outcome?.result_json === null || outcome?.result_json === undefined
      ? undefined
      : parseRuntimeResultJson(outcome.result_json);
    if (result?.kind === "run") return result;

    const stepCandidates = await this.database.prepare(`
      SELECT steps.step_id, steps.evidence_json, plans.id AS plan_id, plans.run_id
      FROM plan_steps AS steps
      JOIN plans ON plans.id = steps.plan_id
      JOIN runs ON runs.id = plans.run_id
      WHERE steps.status = 'completed'
        AND runs.owner_user_id = ?
        AND runs.conversation_id = ?
        AND runs.id <> ?
    `).all(input.actorUserId, input.conversationId, input.runId) as unknown as BoundStepResultRow[];
    for (const candidate of stepCandidates) {
      const stepResult = resultFromEvidence(candidate.evidence_json);
      if (
        stepResult?.kind === "step"
        && stepResult.ref.resultId === input.resultId
        && stepResult.producer.runId === candidate.run_id
        && stepResult.producer.planId === candidate.plan_id
        && stepResult.producer.stepId === candidate.step_id
      ) return stepResult;
    }
    return undefined;
  }
}

function resultFromMetadata(value: string | undefined): RuntimeResultRecord | undefined {
  if (value === undefined) return undefined;
  const metadata = parseRecord(value);
  return parseRuntimeResult(metadata?.runtimeResult);
}

function resultFromEvidence(value: string | null): RuntimeResultRecord | undefined {
  if (value === null) return undefined;
  const evidence = parseRecord(value);
  return parseRuntimeResult(evidence?.publishedResult);
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function parseDeliveryReceipt(value: unknown): RuntimeDeliveryReceipt | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const artifact = record.artifact;
  if (
    record.schema !== "agentloop.runtimeDeliveryReceipt/v1"
    || (record.verdict !== "accepted" && record.verdict !== "caveated")
    || !Array.isArray(record.caveats)
    || !record.caveats.every((item) => typeof item === "string")
    || typeof record.sourceToolCallId !== "string"
    || artifact === null
    || typeof artifact !== "object"
    || Array.isArray(artifact)
  ) return undefined;
  const artifactRecord = artifact as Record<string, unknown>;
  if (
    typeof artifactRecord.path !== "string"
    || artifactRecord.path.trim().length === 0
    || (artifactRecord.bytes !== undefined && !(typeof artifactRecord.bytes === "number" && Number.isFinite(artifactRecord.bytes)))
    || (artifactRecord.sha256 !== undefined && typeof artifactRecord.sha256 !== "string")
    || (artifactRecord.kind !== undefined && typeof artifactRecord.kind !== "string")
  ) return undefined;
  return record as unknown as RuntimeDeliveryReceipt;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function hasBoundResult(value: string | undefined, resultId: string): boolean {
  if (value === undefined) return false;
  const parsed = parseJson(value);
  return Array.isArray(parsed) && parsed.some((binding) => {
    const parsedBinding = parseRuntimeResultBinding(binding);
    return parsedBinding !== undefined
      && parsedBinding.relation !== "dependency"
      && parsedBinding.result.resultId === resultId;
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
