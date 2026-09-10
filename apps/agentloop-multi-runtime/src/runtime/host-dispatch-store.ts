import type { AppDatabase } from "@zhujun/agentloop";

export type DispatchClaim =
  | { readonly kind: "claimed" }
  | { readonly kind: "accepted"; readonly remoteRunId: string; readonly ownerUserId: string }
  | { readonly kind: "in_flight" };

/** Durable dispatch idempotency and execution ownership ledger in the shared state store. */
export class HostDispatchStore {
  private readonly database: AppDatabase;
  private readonly runtimeId: string;

  constructor(database: AppDatabase, runtimeId = "legacy-runtime") {
    this.database = database;
    this.runtimeId = runtimeId;
  }

  async ready(): Promise<void> {
    await this.database.exec(`
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
      CREATE UNIQUE INDEX IF NOT EXISTS mr_host_dispatches_run_idx ON mr_host_dispatches(remote_run_id) WHERE remote_run_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS mr_run_executors (
        remote_run_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        dispatch_key TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL,
        accepted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_run_executors_runtime_idx ON mr_run_executors(runtime_id, accepted_at DESC);
    `);
  }

  async claim(input: { readonly dispatchKey: string; readonly assignmentId: string; readonly ownerUserId: string; readonly now: number; readonly leaseMs: number }): Promise<DispatchClaim> {
    return await this.database.transaction(async () => {
      const existing = await this.database.prepare(`
        SELECT owner_user_id, remote_run_id, state, lease_expires_at FROM mr_host_dispatches WHERE dispatch_key = ?
      `).get(input.dispatchKey) as { owner_user_id: string; remote_run_id: string | null; state: string; lease_expires_at: number | null } | undefined;
      if (existing?.state === "accepted" && existing.remote_run_id !== null) {
        return { kind: "accepted", remoteRunId: existing.remote_run_id, ownerUserId: existing.owner_user_id };
      }
      if (existing?.state === "starting" && (existing.lease_expires_at ?? 0) >= input.now) return { kind: "in_flight" };
      if (existing === undefined) {
        await this.database.prepare(`
          INSERT INTO mr_host_dispatches(dispatch_key, assignment_id, owner_user_id, state, lease_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, 'starting', ?, ?, ?)
        `).run(input.dispatchKey, input.assignmentId, input.ownerUserId, input.now + input.leaseMs, input.now, input.now);
      } else {
        await this.database.prepare(`
          UPDATE mr_host_dispatches SET assignment_id = ?, owner_user_id = ?, state = 'starting', lease_expires_at = ?, updated_at = ? WHERE dispatch_key = ?
        `).run(input.assignmentId, input.ownerUserId, input.now + input.leaseMs, input.now, input.dispatchKey);
      }
      return { kind: "claimed" };
    });
  }

  async accept(dispatchKey: string, remoteRunId: string, now = Date.now()): Promise<void> {
    await this.database.transaction(async () => {
      const result = await this.database.prepare(`
        UPDATE mr_host_dispatches SET remote_run_id = ?, state = 'accepted', lease_expires_at = NULL, updated_at = ?
        WHERE dispatch_key = ? AND state = 'starting'
      `).run(remoteRunId, now, dispatchKey);
      if (result.changes === 0) throw new Error("Host dispatch claim was lost before Run acceptance");
      const dispatch = await this.database.prepare(`
        SELECT owner_user_id FROM mr_host_dispatches WHERE dispatch_key = ? AND remote_run_id = ?
      `).get(dispatchKey, remoteRunId) as { owner_user_id: string } | undefined;
      if (dispatch === undefined) throw new Error("Host dispatch receipt is missing its owner");
      await this.database.prepare(`
        INSERT INTO mr_run_executors(remote_run_id, runtime_id, dispatch_key, owner_user_id, accepted_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(remote_run_id) DO UPDATE SET
          runtime_id = excluded.runtime_id,
          dispatch_key = excluded.dispatch_key,
          owner_user_id = excluded.owner_user_id,
          accepted_at = excluded.accepted_at
      `).run(remoteRunId, this.runtimeId, dispatchKey, dispatch.owner_user_id, now);
    });
  }

  async release(dispatchKey: string): Promise<void> {
    await this.database.prepare(`DELETE FROM mr_host_dispatches WHERE dispatch_key = ? AND state = 'starting'`).run(dispatchKey);
  }

  async ownerForRun(remoteRunId: string): Promise<string | undefined> {
    const row = await this.database.prepare(`SELECT owner_user_id FROM mr_host_dispatches WHERE remote_run_id = ? AND state = 'accepted'`).get(remoteRunId) as { owner_user_id: string } | undefined;
    return row?.owner_user_id;
  }

  /**
   * Counts only Runs this Host is actively executing, even when every Host
   * shares one database. A Run paused for durable recovery has no executing
   * model/tool action, so it must not retain an admission slot while it waits.
   */
  async activeRunCount(): Promise<number> {
    const row = await this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM mr_run_executors executors JOIN runs ON runs.id = executors.remote_run_id
      WHERE executors.runtime_id = ?
        AND runs.status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM run_recovery_states recovery
          WHERE recovery.run_id = runs.id
        )
    `).get(this.runtimeId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }
}

export class RuntimeDispatchInFlightError extends Error {}
