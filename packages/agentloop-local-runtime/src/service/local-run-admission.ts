import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@zhujun/agentloop";
import type { LocalRuntimeControl } from "../contracts/host.ts";
import type { LocalRunInput } from "./local-runtime.ts";

interface AdmissionRow { fingerprint: string; reservation_id: string; run_id: string | null; run_deleted: number }
type StartedRun = Awaited<ReturnType<LocalRuntimeControl["runs"]["startConversation"]>>;
interface AdmissionResult { readonly run: StartedRun; readonly replayed: boolean }
export interface LocalRunAdmissionHooks {
  admit?<T>(start: (runtime: LocalRuntimeControl) => Promise<{ runId: string; value: T }>): Promise<T>;
  settled?(runId: string): Promise<void>;
  readonly maxConcurrentRuns?: number;
  readonly validateModel?: (modelKey: string) => void;
}

export async function initializeLocalRunAdmissions(runtimeDatabase: LocalRuntimeControl["database"]): Promise<void> {
  await runtimeDatabase.transaction(async () => {
    await runtimeDatabase.exec(`CREATE TABLE IF NOT EXISTS local_run_admissions (
      owner_user_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      reservation_id TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL,
      run_deleted INTEGER NOT NULL DEFAULT 0 CHECK(run_deleted IN (0, 1)),
      PRIMARY KEY(owner_user_id, request_id), UNIQUE(run_id)
    )`);
    const columns = await runtimeDatabase.prepare("PRAGMA table_info(local_run_admissions)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "run_deleted")) {
      await runtimeDatabase.exec("ALTER TABLE local_run_admissions ADD COLUMN run_deleted INTEGER NOT NULL DEFAULT 0 CHECK(run_deleted IN (0, 1))");
    }
    // Preserve request identity when Kernel deletes a conversation. This mark
    // participates in the deletion transaction; absent, unmarked Runs remain
    // integrity failures rather than silently becoming safe to execute again.
    await runtimeDatabase.exec(`CREATE TRIGGER IF NOT EXISTS local_run_admissions_mark_run_deleted
      AFTER DELETE ON runs BEGIN
        UPDATE local_run_admissions SET run_deleted = 1
        WHERE run_id = OLD.id AND owner_user_id = OLD.owner_user_id;
      END`);
  });
}

function conflict(message: string): AppError { return new AppError("CONFLICT", message, 409); }

/** One coordinator per live control. Reservations survive process loss; an
 * unbound reservation is never retried automatically. Run binding is committed
 * atomically with Kernel Run/source creation, not after the model has started.
 */
export class LocalRunAdmissionService {
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<AdmissionResult> }>();
  private pending = 0;
  private settlementError?: unknown;
  private readonly watched = new Set<string>();
  private readonly background = new Set<Promise<void>>();
  constructor(private readonly runtime: LocalRuntimeControl, private readonly hooks: LocalRunAdmissionHooks = {}) {
    const capacity = hooks.maxConcurrentRuns ?? 10;
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError("maxConcurrentRuns must be a positive integer");
  }

  start(owner: string, input: LocalRunInput, legacy?: { dispatchKey: string; assignmentId: string }): Promise<StartedRun> {
    return this.startResult(owner, input, legacy).then(result => result.run);
  }

  startResult(owner: string, input: LocalRunInput, legacy?: { dispatchKey: string; assignmentId: string }): Promise<AdmissionResult> {
    input = { input: input.input, modelKey: input.modelKey, conversationId: input.conversationId,
      requestId: input.requestId, allowDangerousTools: input.allowDangerousTools,
      directoryScopeIds: input.directoryScopeIds === undefined ? undefined : [...input.directoryScopeIds],
      uploadedSourceIds: input.uploadedSourceIds === undefined ? undefined : [...input.uploadedSourceIds],
      connectorConnectionIds: input.connectorConnectionIds === undefined ? undefined : [...input.connectorConnectionIds] };
    const requestId = input.requestId ?? randomUUID();
    if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 256) return Promise.reject(new TypeError("request_id_invalid"));
    // Hash only the defined business fields; omitted connector selection and []
    // remain distinct. Do not persist raw prompts or credentials in this ledger.
    const fingerprint = createHash("sha256").update(JSON.stringify({
      input: input.input, modelKey: input.modelKey, conversationId: input.conversationId ?? null,
      directoryScopeIds: input.directoryScopeIds ?? [], uploadedSourceIds: input.uploadedSourceIds ?? [],
      connectorConnectionIds: input.connectorConnectionIds ?? null, allowDangerousTools: input.allowDangerousTools ?? false,
    })).digest("hex");
    const key = JSON.stringify([owner, requestId]);
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending.fingerprint === fingerprint ? pending.promise : Promise.reject(conflict("request_id_payload_conflict"));
    const promise = Promise.resolve().then(() => this.startOnce(owner, requestId, fingerprint, input, legacy))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { fingerprint, promise });
    return promise;
  }

  private async row(owner: string, requestId: string): Promise<AdmissionRow | undefined> {
    return await this.runtime.database.prepare("SELECT fingerprint, reservation_id, run_id, run_deleted FROM local_run_admissions WHERE owner_user_id = ? AND request_id = ?")
      .get(owner, requestId) as AdmissionRow | undefined;
  }

  private async startOnce(owner: string, requestId: string, fingerprint: string, input: LocalRunInput, legacy?: { dispatchKey: string; assignmentId: string }): Promise<AdmissionResult> {
    const existing = await this.row(owner, requestId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw conflict("request_id_payload_conflict");
      if (existing.run_deleted) throw new AppError("NOT_FOUND", "admission_run_deleted", 410);
      if (existing.run_id === null) throw conflict("admission_outcome_unknown");
      return { run: await this.runtime.runs.get(owner, existing.run_id), replayed: true };
    }
    if (legacy !== undefined) {
      const previous = await this.runtime.database.prepare("SELECT owner_user_id, remote_run_id FROM local_runtime_dispatches WHERE dispatch_key = ?")
        .get(legacy.dispatchKey) as { owner_user_id: string; remote_run_id: string } | undefined;
      if (previous !== undefined) {
        if (previous.owner_user_id !== owner) throw conflict("local_runtime_dispatch_owner_mismatch");
        return { run: await this.runtime.runs.get(owner, previous.remote_run_id), replayed: true };
      }
    }
    await this.refresh();
    const run = await this.admit(async runtime => {
      if (!input.modelKey) throw new AppError("MODEL_ERROR", "model_required", 400);
      if (this.hooks.validateModel !== undefined) this.hooks.validateModel(input.modelKey);
      else if (!runtime.modelKeys.includes(input.modelKey)) throw new AppError("MODEL_ERROR", "local_model_unavailable", 409);
      const visibleDirectories = await runtime.scopes.paths(input.directoryScopeIds ?? []);
      const reservation = randomUUID();
      const claimed = await runtime.database.transaction(async () => {
        await runtime.database.prepare(`INSERT INTO local_run_admissions(owner_user_id, request_id, fingerprint, reservation_id, created_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_user_id, request_id) DO NOTHING`).run(owner, requestId, fingerprint, reservation, Date.now());
        return this.row(owner, requestId);
      });
      if (claimed?.reservation_id !== reservation) {
        if (claimed?.fingerprint !== fingerprint) throw conflict("request_id_payload_conflict");
        if (claimed.run_deleted) throw new AppError("NOT_FOUND", "admission_run_deleted", 410);
        if (claimed.run_id === null) throw conflict("admission_outcome_unknown");
        return { runId: claimed.run_id, value: await runtime.runs.get(owner, claimed.run_id) };
      }
      try {
        if (input.conversationId !== undefined) await runtime.runs.ensureConversation(owner, input.conversationId, input.input);
        const started = await runtime.runs.startConversation(owner, input.input, {
          conversationId: input.conversationId, modelKey: input.modelKey, visibleDirectories,
          sourceIds: input.uploadedSourceIds ?? [], allowDangerousTools: input.allowDangerousTools ?? false,
          connectorConnectionIds: input.connectorConnectionIds ?? runtime.connectorConnectionIds,
        }, { persist: async run => {
          const result = await runtime.database.prepare(`UPDATE local_run_admissions SET run_id = ?
            WHERE owner_user_id = ? AND request_id = ? AND reservation_id = ? AND run_id IS NULL`)
            .run(run.id, owner, requestId, reservation);
          if (Number(result.changes) !== 1) throw conflict("admission_reservation_lost");
          if (legacy !== undefined) await runtime.database.prepare(`INSERT INTO local_runtime_dispatches(dispatch_key, assignment_id, owner_user_id, remote_run_id, created_at)
            VALUES (?, ?, ?, ?, ?)`).run(legacy.dispatchKey, legacy.assignmentId, owner, run.id, Date.now());
        } });
        return { runId: started.id, value: started };
      } catch (error) {
        const persisted = await this.row(owner, requestId);
        if (persisted?.run_id != null) {
          // Commit may have succeeded even when a subsequent notification failed.
          // Preserve its identity; never start a second Run on a lost response.
          return { runId: persisted.run_id, value: await runtime.runs.get(owner, persisted.run_id) };
        }
        // The same transaction would have attached run_id if a Run had committed.
        // Only this provably uncommitted attempt may release its reservation.
        await runtime.database.transaction(async () => {
          await runtime.database.prepare(`DELETE FROM local_run_admissions
            WHERE owner_user_id = ? AND request_id = ? AND reservation_id = ? AND run_id IS NULL`).run(owner, requestId, reservation);
        });
        throw error;
      }
    });
    this.watch(run.id);
    return { run, replayed: false };
  }

  private async admit<T>(start: (runtime: LocalRuntimeControl) => Promise<{ runId: string; value: T }>): Promise<T> {
    if (this.hooks.admit !== undefined) return this.hooks.admit(start);
    if (this.pending + this.runtime.activeRunIds.size >= (this.hooks.maxConcurrentRuns ?? 10)) throw new AppError("CONFLICT", "runtime_capacity_exhausted", 429);
    this.pending++;
    try {
      const started = await start(this.runtime);
      this.runtime.activeRunIds.add(started.runId);
      return started.value;
    } finally { this.pending--; }
  }

  private watch(runId: string): void {
    if (this.watched.has(runId)) return;
    this.watched.add(runId);
    const task = this.runtime.runs.whenRunIdle(runId).then(() => this.refresh()).catch(error => {
      // Retain and surface the failure to the next API/close, not a detached
      // unhandled rejection or a silently successful lifecycle transition.
      this.settlementError = error;
    }).finally(() => { this.watched.delete(runId); this.background.delete(task); });
    this.background.add(task);
  }

  /** Call only after refresh confirms no active work; never wait on a live model during close. */
  async flushSettlements(): Promise<void> { await Promise.all([...this.background]); await this.refresh(); }

  async refresh(): Promise<void> {
    if (this.settlementError !== undefined) {
      const error = this.settlementError; this.settlementError = undefined;
      throw error;
    }
    const rows = await this.runtime.database.prepare(`SELECT a.owner_user_id, a.run_id, a.run_deleted, r.status,
      recovery.state AS recovery_state, recovery.planning_token, recovery.resume_token FROM local_run_admissions a
      LEFT JOIN runs r ON r.id = a.run_id AND r.owner_user_id = a.owner_user_id
      LEFT JOIN run_recovery_states recovery ON recovery.run_id = r.id WHERE a.run_id IS NOT NULL`)
      .all() as Array<{ owner_user_id: string; run_id: string; run_deleted: number; status: string | null; recovery_state: string | null; planning_token: string | null; resume_token: string | null }>;
    const settled: string[] = [];
    for (const row of rows) {
      if (row.status === null && !row.run_deleted) throw conflict("admission_run_missing");
      const paused = (row.recovery_state === "waiting_recovery" || row.recovery_state === "waiting_user")
        && row.planning_token === null && row.resume_token === null;
      if ((row.status === "running" && !paused) || this.runtime.runs.isRunExecuting(row.run_id)) this.runtime.activeRunIds.add(row.run_id);
      else if (this.runtime.activeRunIds.delete(row.run_id)) settled.push(row.run_id);
    }
    for (const runId of settled) await this.hooks.settled?.(runId);
  }
}
