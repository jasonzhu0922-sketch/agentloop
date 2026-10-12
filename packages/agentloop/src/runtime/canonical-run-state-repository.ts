import type { SqlConnection } from "../storage/connection.ts";
import { AppError, notFound } from "../shared/errors.ts";
import type { CanonicalRunState } from "./canonical-run-state.ts";

interface CanonicalRunStateRow {
  run_id: string;
  state_id: string;
  intent_id: string;
  revision: number;
  state_json: string;
  created_at: number;
  updated_at: number;
}

export class CanonicalRunStateRepository {
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    this.connection = connection;
  }

  async create(state: CanonicalRunState): Promise<CanonicalRunState> {
    await this.connection.transaction(async () => {
      await this.connection.prepare(`
        INSERT INTO canonical_run_states(run_id, state_id, intent_id, revision, state_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(state.runId, state.stateId, state.intent.id, state.revision, JSON.stringify(state), state.createdAt, state.updatedAt);
      await this.insertRevision(state, "intent_initialized");
    });
    return state;
  }

  async get(runId: string): Promise<CanonicalRunState> {
    const row = await this.connection.prepare(`
      SELECT run_id, state_id, intent_id, revision, state_json, created_at, updated_at
      FROM canonical_run_states WHERE run_id = ?
    `).get(runId) as CanonicalRunStateRow | undefined;
    if (row === undefined) throw notFound("Canonical Run State");
    return parseState(row);
  }

  async getOptional(runId: string): Promise<CanonicalRunState | undefined> {
    try {
      return await this.get(runId);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }

  async commit(input: {
    readonly expectedRevision: number;
    readonly state: CanonicalRunState;
    readonly reason: string;
  }): Promise<CanonicalRunState> {
    if (input.state.revision !== input.expectedRevision + 1) {
      throw new TypeError("Canonical Run State writer must advance exactly one revision");
    }
    await this.connection.transaction(async () => {
      const result = await this.connection.prepare(`
        UPDATE canonical_run_states
        SET revision = ?, state_json = ?, updated_at = ?
        WHERE run_id = ? AND state_id = ? AND intent_id = ? AND revision = ?
      `).run(
        input.state.revision,
        JSON.stringify(input.state),
        input.state.updatedAt,
        input.state.runId,
        input.state.stateId,
        input.state.intent.id,
        input.expectedRevision,
      );
      if (result.changes !== 1) {
        throw new AppError("CONFLICT", "Canonical Run State revision is stale", 409, {
          runId: input.state.runId,
          expectedRevision: input.expectedRevision,
        });
      }
      await this.insertRevision(input.state, input.reason);
    });
    return input.state;
  }

  private async insertRevision(state: CanonicalRunState, reason: string): Promise<void> {
    await this.connection.prepare(`
      INSERT INTO canonical_run_state_revisions(run_id, revision, state_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(state.runId, state.revision, JSON.stringify(state), reason, state.updatedAt);
  }
}

function parseState(row: CanonicalRunStateRow): CanonicalRunState {
  const parsed = JSON.parse(row.state_json) as Partial<CanonicalRunState>;
  if (
    parsed.schema !== "agentloop.canonicalRunState/v1"
    || parsed.runId !== row.run_id
    || parsed.stateId !== row.state_id
    || parsed.intent?.id !== row.intent_id
    || parsed.revision !== row.revision
  ) {
    throw new Error(`Canonical Run State ${row.run_id} failed identity validation`);
  }
  return parsed as CanonicalRunState;
}
