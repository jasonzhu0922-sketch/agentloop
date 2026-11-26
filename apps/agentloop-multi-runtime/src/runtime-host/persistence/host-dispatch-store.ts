import { runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput, type SqlConnection } from "@zhujun/agentloop";
import { TIDB_HOST_DISPATCH_SCHEMA_SQL } from "./tidb-schema.ts";
import { migrateRuntimeState } from "./state-migrations.ts";

export type DispatchClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "accepted"; readonly remoteRunId: string; readonly ownerUserId: string }
  | { readonly kind: "in_flight" };

/** Durable dispatch idempotency and execution ownership ledger in the shared state store. */
export class HostDispatchStore {
  private readonly database: RuntimePersistence;
  private readonly legacySchema?: SqlConnection;
  private readonly runtimeId: string;

  constructor(database: RuntimePersistenceInput, runtimeId = "legacy-runtime") {
    this.database = runtimePersistence(database);
    this.legacySchema = "records" in database ? undefined : database;
    this.runtimeId = runtimeId;
  }

  async ready(): Promise<void> {
    // Kernel factory owns the execution schema. Legacy Host DDL remains available to the migration registry.
  }

  /** Invoked only by the versioned schema migration registry. */
  async installSchema(): Promise<void> {
    const canonicalSchema = `
      CREATE TABLE IF NOT EXISTS mr_host_dispatches (
        dispatch_key TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        remote_run_id TEXT,
        state TEXT NOT NULL,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Every supported relational backend permits multiple NULL values in a
      -- UNIQUE index. Avoid a SQLite/PostgreSQL partial index so this durable
      -- Host ledger has the same invariant on TiDB.
      CREATE UNIQUE INDEX IF NOT EXISTS mr_host_dispatches_run_idx ON mr_host_dispatches(remote_run_id);
      CREATE TABLE IF NOT EXISTS mr_run_executors (
        remote_run_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        dispatch_key TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL,
        accepted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_run_executors_runtime_idx ON mr_run_executors(runtime_id, accepted_at DESC);
    `;
    if (this.legacySchema) await this.legacySchema.exec(this.legacySchema.dialect === "tidb" ? TIDB_HOST_DISPATCH_SCHEMA_SQL : canonicalSchema);
  }

  async claim(input: { readonly dispatchKey: string; readonly assignmentId: string; readonly ownerUserId: string; readonly now: number; readonly leaseMs: number }): Promise<DispatchClaim> {
    return await this.database.transaction(async () => {
      const existing = (await this.database.records.find("runtime_dispatches", { dispatch_key: input.dispatchKey }))[0];
      if (existing?.state === "accepted" && existing.remote_run_id !== null) {
        return { kind: "accepted", remoteRunId: existing.remote_run_id, ownerUserId: existing.owner_user_id };
      }
      if (existing?.state === "starting" && (existing.lease_expires_at ?? 0) >= input.now) return { kind: "in_flight" };
      await this.database.records.insert("runtime_dispatches", { dispatch_key: input.dispatchKey, assignment_id: input.assignmentId,
        owner_user_id: input.ownerUserId, state: "starting", lease_expires_at: input.now + input.leaseMs,
        created_at: existing?.created_at ?? input.now, updated_at: input.now }, "replace");
      return { kind: "claimed" };
    });
  }

  async accept(dispatchKey: string, remoteRunId: string, now = Date.now()): Promise<void> {
    await this.database.transaction(async () => {
      const prior = (await this.database.records.find("runtime_dispatches", { dispatch_key: dispatchKey }))[0];
      if (prior?.state === "accepted" && prior.remote_run_id === remoteRunId) return;
      const changed = await this.database.records.update("runtime_dispatches", { dispatch_key: dispatchKey, state: "starting" },
        () => ({ remote_run_id: remoteRunId, state: "accepted", lease_expires_at: null, updated_at: now }));
      if (!changed || !prior) throw new Error("Host dispatch claim was lost before Run acceptance");
      await this.database.records.insert("runtime_executors", { remote_run_id: remoteRunId, runtime_id: this.runtimeId,
        dispatch_key: dispatchKey, owner_user_id: prior.owner_user_id, accepted_at: now });
    });
  }

  async release(dispatchKey: string): Promise<void> {
    await this.database.records.remove("runtime_dispatches", { dispatch_key: dispatchKey, state: "starting" });
  }

  async ownerForRun(remoteRunId: string): Promise<string | undefined> {
    const row = (await this.database.records.find("runtime_dispatches", { remote_run_id: remoteRunId, state: "accepted" }))[0];
    return row?.owner_user_id;
  }

  async ownedRunIds(): Promise<readonly string[]> {
    const rows = (await this.database.records.find("runtime_executors", { runtime_id: this.runtimeId })).sort((a, b) => a.accepted_at - b.accepted_at || a.remote_run_id.localeCompare(b.remote_run_id));
    return rows.map((row) => row.remote_run_id);
  }

  /**
   * Counts only Runs this Host is actively executing, even when every Host
   * shares one database. A Run paused for durable recovery has no executing
   * model/tool action, so it must not retain an admission slot while it waits.
   */
  async activeRunCount(): Promise<number> {
    let count = 0;
    for (const id of await this.ownedRunIds()) {
      const run = (await this.database.records.find("runs", { id, status: "running" }))[0];
      if (run && !(await this.database.records.find("run_recovery_states", { run_id: id })).length) count++;
    }
    return count;
  }
}

export async function installHostDispatchSchema(database: SqlConnection): Promise<void> {
  await new HostDispatchStore(database).installSchema();
}

export class RuntimeDispatchInFlightError extends Error {}
