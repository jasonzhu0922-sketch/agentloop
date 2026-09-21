import type { SqlConnection } from "../storage/connection.ts";
import { parseRuntimeResult, parseRuntimeResultJson, type RuntimeResultRecord } from "./runtime-result.ts";

interface ActionResultRow {
  readonly metadata_json: string;
}

interface StepResultRow {
  readonly step_id: string;
  readonly evidence_json: string | null;
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
    if (input.actorUserId === undefined || input.conversationId === undefined) return undefined;
    const plan = await this.database.prepare("SELECT input_bindings_json FROM plans WHERE id = ? AND run_id = ?")
      .get(input.planId, input.runId) as { input_bindings_json: string } | undefined;
    if (!hasBoundResult(plan?.input_bindings_json, input.resultId)) return undefined;
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
    return result?.kind === "run" ? result : undefined;
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

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
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
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return false;
    const result = (binding as Record<string, unknown>).result;
    return result !== null
      && typeof result === "object"
      && !Array.isArray(result)
      && (result as Record<string, unknown>).resultId === resultId;
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
