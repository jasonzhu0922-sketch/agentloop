import { runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
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
  private readonly connection: RuntimePersistence;

  constructor(connection: RuntimePersistenceInput) {
    this.connection = runtimePersistence(connection);
  }

  async create(state: CanonicalRunState): Promise<CanonicalRunState> {
    await this.connection.transaction(async () => {
      await this.connection.records.insert("canonical_run_states", {
        run_id: state.runId, state_id: state.stateId, intent_id: state.intent.id,
        revision: state.revision, state_json: JSON.stringify(state), created_at: state.createdAt, updated_at: state.updatedAt,
      });
      await this.insertRevision(state, "intent_initialized");
    });
    return state;
  }

  async get(runId: string): Promise<CanonicalRunState> {
    const row = (await this.connection.records.find("canonical_run_states", { run_id: runId }))[0];
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
      const changes = await this.connection.records.update("canonical_run_states", {
        run_id: input.state.runId, state_id: input.state.stateId, intent_id: input.state.intent.id, revision: input.expectedRevision,
      }, () => ({ revision: input.state.revision, state_json: JSON.stringify(input.state), updated_at: input.state.updatedAt }));
      if (changes !== 1) {
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
    await this.connection.records.insert("canonical_run_state_revisions", {
      run_id: state.runId, revision: state.revision, state_json: JSON.stringify(state), reason, created_at: state.updatedAt,
    });
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
