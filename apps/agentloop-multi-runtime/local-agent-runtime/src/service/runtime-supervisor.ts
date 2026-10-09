import { randomUUID } from "node:crypto";
import type { AppDatabase, RunService } from "@zhujun/agentloop";
import type { LocalDirectoryScopeStore } from "../persistence/directory-scope-store.ts";

export type LocalRuntimeLifecycleStatus = "ready" | "draining" | "restarting" | "stopped" | "failed";
type PendingAction = "restart" | "stop";

/** Per-Runtime admission limit for device-local execution unless deployment overrides it. */
export const DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS = 10;

export interface LocalRuntimeDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly storageKey: string;
  readonly isDefault: boolean;
}

export interface LocalRuntimeControl extends LocalRuntimeDefinition {
  readonly database: AppDatabase;
  readonly runs: RunService;
  readonly scopes: LocalDirectoryScopeStore;
  readonly modelKeys: readonly string[];
  readonly activeRunIds: Set<string>;
}

export interface LocalRuntimeSummary extends LocalRuntimeDefinition {
  readonly status: LocalRuntimeLifecycleStatus;
  readonly activeRunCount: number;
  readonly pendingAction?: PendingAction;
  readonly updatedAt: number;
}

export type LocalRuntimeReclaimer = (definition: LocalRuntimeDefinition) => Promise<void>;

interface RuntimeRow {
  runtime_id: string;
  display_name: string;
  storage_key: string;
  is_default: number;
  status: LocalRuntimeLifecycleStatus;
  pending_action: PendingAction | null;
  updated_at: number;
}

/** Device-level authority for isolated Local Runtime instances and lifecycle. */
export class LocalRuntimeSupervisor {
  private readonly instances = new Map<string, LocalRuntimeControl>();
  private readonly pendingAdmissions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly database: AppDatabase;
  private readonly factory: (definition: LocalRuntimeDefinition) => Promise<LocalRuntimeControl>;
  private readonly reclaimer: LocalRuntimeReclaimer;
  private readonly maxConcurrentRuns: number;

  constructor(
    database: AppDatabase,
    factory: (definition: LocalRuntimeDefinition) => Promise<LocalRuntimeControl>,
    reclaimer: LocalRuntimeReclaimer = async () => undefined,
    maxConcurrentRuns = DEFAULT_LOCAL_RUNTIME_MAX_CONCURRENT_RUNS,
  ) {
    if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
      throw new TypeError("maxConcurrentRuns must be a positive integer");
    }
    this.database = database;
    this.factory = factory;
    this.reclaimer = reclaimer;
    this.maxConcurrentRuns = maxConcurrentRuns;
  }

  async ready(defaultRuntimeId: string): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_runtime_instances (
        runtime_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('ready', 'draining', 'restarting', 'stopped', 'failed')),
        pending_action TEXT CHECK(pending_action IS NULL OR pending_action IN ('restart', 'stop')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_runtime_operations (
        id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL REFERENCES local_runtime_instances(runtime_id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS local_runtime_operations_runtime_idx
        ON local_runtime_operations(runtime_id, created_at DESC);
    `);
    const count = await this.database.prepare("SELECT COUNT(*) AS count FROM local_runtime_instances").get() as { count: number };
    if (Number(count.count) === 0) {
      const now = Date.now();
      await this.database.prepare(`
        INSERT INTO local_runtime_instances(runtime_id, display_name, storage_key, is_default, status, created_at, updated_at)
        VALUES (?, '本机 Runtime', 'default', 1, 'ready', ?, ?)
      `).run(defaultRuntimeId, now, now);
    }
    await this.enforceSingleDefault();
    await this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS local_runtime_instances_one_default_idx
        ON local_runtime_instances(is_default) WHERE is_default = 1;
    `);
    const rows = await this.rows();
    for (const row of rows) {
      if (row.status === "stopped") continue;
      await this.startInstance(toDefinition(row), row.pending_action === null ? row.status : "ready");
      if (row.pending_action !== null || row.status === "restarting") {
        await this.updateState(row.runtime_id, "ready", null);
      }
    }
  }

  /** Preserve one stable default even when upgrading a legacy device database. */
  private async enforceSingleDefault(): Promise<void> {
    const current = await this.database.prepare(`
      SELECT runtime_id FROM local_runtime_instances WHERE is_default = 1 ORDER BY created_at, runtime_id
    `).all() as Array<{ runtime_id: string }>;
    const selected = current[0] ?? await this.database.prepare(`
      SELECT runtime_id FROM local_runtime_instances ORDER BY created_at, runtime_id LIMIT 1
    `).get() as { runtime_id: string } | undefined;
    if (selected === undefined) return;
    await this.database.prepare(`
      UPDATE local_runtime_instances SET is_default = CASE WHEN runtime_id = ? THEN 1 ELSE 0 END
    `).run(selected.runtime_id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(): Promise<readonly LocalRuntimeSummary[]> {
    return (await this.rows()).map((row) => ({
      ...toDefinition(row),
      status: row.status,
      activeRunCount: (this.instances.get(row.runtime_id)?.activeRunIds.size ?? 0) + (this.pendingAdmissions.get(row.runtime_id) ?? 0),
      ...(row.pending_action === null ? {} : { pendingAction: row.pending_action }),
      updatedAt: row.updated_at,
    }));
  }

  advertisements(): readonly {
    runtimeId: string;
    displayName: string;
    profile: "general";
    capabilities: readonly string[];
    maxConcurrentRuns: number;
    status: "ready" | "draining";
    catalogVersion: string;
  }[] {
    return [...this.instances.values()].map((runtime) => ({
      runtimeId: runtime.id,
      displayName: runtime.displayName,
      profile: "general",
      capabilities: [],
      maxConcurrentRuns: this.maxConcurrentRuns,
      status: this.statusFromCache(runtime.id) === "ready" ? "ready" : "draining",
      catalogVersion: "1",
    }));
  }

  runtime(runtimeId: string, requireReady = false): LocalRuntimeControl {
    const runtime = this.instances.get(runtimeId);
    if (runtime === undefined) throw new LocalRuntimeSupervisorError(409, "runtime_not_running");
    if (requireReady && this.statusFromCache(runtimeId) !== "ready") throw new LocalRuntimeSupervisorError(409, "runtime_draining");
    return runtime;
  }

  async admitRun<T>(runtimeId: string, start: (runtime: LocalRuntimeControl) => Promise<{ readonly runId: string; readonly value: T }>): Promise<T> {
    const runtime = this.runtime(runtimeId, true);
    if (this.activeWorkCount(runtimeId) >= this.maxConcurrentRuns) {
      throw new LocalRuntimeSupervisorError(429, "runtime_capacity_exhausted");
    }
    this.pendingAdmissions.set(runtimeId, (this.pendingAdmissions.get(runtimeId) ?? 0) + 1);
    this.emit();
    try {
      const started = await start(runtime);
      runtime.activeRunIds.add(started.runId);
      return started.value;
    } finally {
      const remaining = Math.max(0, (this.pendingAdmissions.get(runtimeId) ?? 1) - 1);
      if (remaining === 0) this.pendingAdmissions.delete(runtimeId);
      else this.pendingAdmissions.set(runtimeId, remaining);
      if (!this.hasActiveWorkForRuntime(runtimeId)) await this.completePending(runtimeId);
      this.emit();
    }
  }

  async create(displayName: string): Promise<LocalRuntimeSummary> {
    const name = displayName.trim();
    if (name.length < 1 || name.length > 100) throw new LocalRuntimeSupervisorError(400, "runtime_display_name_invalid");
    const id = `local_runtime_${randomUUID()}`;
    const now = Date.now();
    await this.database.prepare(`
      INSERT INTO local_runtime_instances(runtime_id, display_name, storage_key, is_default, status, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'ready', ?, ?)
    `).run(id, name, id, now, now);
    try {
      await this.startInstance({ id, displayName: name, storageKey: id, isDefault: false }, "ready");
      await this.operation(id, "create", "completed");
    } catch (error) {
      await this.updateState(id, "failed", null);
      await this.operation(id, "create", "failed", error);
      throw error;
    }
    return (await this.list()).find((runtime) => runtime.id === id)!;
  }

  async rename(runtimeId: string, displayName: string): Promise<LocalRuntimeSummary> {
    const name = displayName.trim();
    if (name.length < 1 || name.length > 100) throw new LocalRuntimeSupervisorError(400, "runtime_display_name_invalid");
    await this.row(runtimeId);
    await this.database.prepare(`
      UPDATE local_runtime_instances SET display_name = ?, updated_at = ? WHERE runtime_id = ?
    `).run(name, Date.now(), runtimeId);
    await this.operation(runtimeId, "rename", "completed");
    this.emit();
    return this.summary(runtimeId);
  }

  /**
   * Reclaim an idle, non-default Runtime and all of its Runtime-owned state.
   * Device-level shared storage is deliberately outside this lifecycle.
   */
  async remove(runtimeId: string): Promise<{ readonly runtimeId: string; readonly reclaimedData: true }> {
    const row = await this.row(runtimeId);
    if (row.is_default === 1) throw new LocalRuntimeSupervisorError(409, "default_runtime_cannot_be_deleted");
    if (this.hasActiveWorkForRuntime(runtimeId)) {
      throw new LocalRuntimeSupervisorError(409, "runtime_active_runs_prevent_delete");
    }
    const runtime = this.instances.get(runtimeId);
    if (runtime !== undefined) {
      await this.updateState(runtimeId, "draining", null);
      await runtime.database.close();
      this.instances.delete(runtimeId);
      this.statusCache.set(runtimeId, "stopped");
    }
    try {
      await this.reclaimer(toDefinition(row));
    } catch (error) {
      // The control record remains stopped so a failed filesystem cleanup can
      // be retried safely without reviving a partially reclaimed Runtime.
      await this.updateState(runtimeId, "stopped", null);
      this.emit();
      throw new LocalRuntimeSupervisorError(500, `runtime_resource_cleanup_failed:${error instanceof Error ? error.message : String(error)}`);
    }
    await this.database.prepare("DELETE FROM local_runtime_instances WHERE runtime_id = ?").run(runtimeId);
    this.statusCache.delete(runtimeId);
    this.emit();
    return { runtimeId, reclaimedData: true };
  }

  hasActiveWork(): boolean {
    return [...new Set([...this.instances.keys(), ...this.pendingAdmissions.keys()])]
      .some((runtimeId) => this.hasActiveWorkForRuntime(runtimeId));
  }

  /** Recreate every running instance after a device-level configuration change. */
  async reloadRunningInstances(): Promise<void> {
    if (this.hasActiveWork()) throw new LocalRuntimeSupervisorError(409, "runtime_active_runs_prevent_reconfiguration");
    const rows = await this.rows();
    for (const runtime of this.instances.values()) await runtime.database.close();
    this.instances.clear();
    for (const row of rows) {
      if (row.status === "stopped") continue;
      await this.startInstance(toDefinition(row), row.status === "draining" ? "draining" : "ready");
    }
    this.emit();
  }

  async drain(runtimeId: string): Promise<LocalRuntimeSummary> {
    this.runtime(runtimeId);
    await this.updateState(runtimeId, "draining", null);
    await this.operation(runtimeId, "drain", "completed");
    this.emit();
    return this.summary(runtimeId);
  }

  async restart(runtimeId: string): Promise<LocalRuntimeSummary> {
    this.runtime(runtimeId);
    await this.updateState(runtimeId, "draining", "restart");
    await this.operation(runtimeId, "restart", this.hasActiveWorkForRuntime(runtimeId) ? "waiting_for_drain" : "running");
    this.emit();
    if (!this.hasActiveWorkForRuntime(runtimeId)) await this.completePending(runtimeId);
    return this.summary(runtimeId);
  }

  async stop(runtimeId: string): Promise<LocalRuntimeSummary> {
    this.runtime(runtimeId);
    await this.updateState(runtimeId, "draining", "stop");
    await this.operation(runtimeId, "stop", this.hasActiveWorkForRuntime(runtimeId) ? "waiting_for_drain" : "running");
    this.emit();
    if (!this.hasActiveWorkForRuntime(runtimeId)) await this.completePending(runtimeId);
    return this.summary(runtimeId);
  }

  async start(runtimeId: string): Promise<LocalRuntimeSummary> {
    const row = await this.row(runtimeId);
    if (this.instances.has(runtimeId) && row.status === "draining" && row.pending_action === null) {
      await this.updateState(runtimeId, "ready", null);
      await this.operation(runtimeId, "start", "completed");
      this.emit();
      return this.summary(runtimeId);
    }
    if (row.status !== "stopped" && this.instances.has(runtimeId)) return this.summary(runtimeId);
    await this.startInstance(toDefinition(row), "ready");
    await this.updateState(runtimeId, "ready", null);
    await this.operation(runtimeId, "start", "completed");
    this.emit();
    return this.summary(runtimeId);
  }

  async runSettled(runtimeId: string, runId: string): Promise<void> {
    const runtime = this.instances.get(runtimeId);
    if (runtime === undefined) return;
    runtime.activeRunIds.delete(runId);
    if (!this.hasActiveWorkForRuntime(runtimeId)) await this.completePending(runtimeId);
    this.emit();
  }

  async close(): Promise<void> {
    for (const runtime of this.instances.values()) await runtime.database.close();
    this.instances.clear();
    await this.database.close();
  }

  private readonly statusCache = new Map<string, LocalRuntimeLifecycleStatus>();

  private statusFromCache(runtimeId: string): LocalRuntimeLifecycleStatus {
    return this.statusCache.get(runtimeId) ?? "stopped";
  }

  private async startInstance(definition: LocalRuntimeDefinition, status: LocalRuntimeLifecycleStatus): Promise<void> {
    const runtime = await this.factory(definition);
    this.instances.set(definition.id, runtime);
    this.statusCache.set(definition.id, status === "draining" ? "draining" : "ready");
  }

  private async completePending(runtimeId: string): Promise<void> {
    const row = await this.row(runtimeId);
    if (row.pending_action === null) return;
    const runtime = this.instances.get(runtimeId);
    if (this.hasActiveWorkForRuntime(runtimeId)) return;
    if (row.pending_action === "stop") {
      await runtime?.database.close();
      this.instances.delete(runtimeId);
      this.statusCache.set(runtimeId, "stopped");
      await this.updateState(runtimeId, "stopped", null);
      await this.finishOperation(runtimeId, "stop", "completed");
      this.emit();
      return;
    }
    await this.updateState(runtimeId, "restarting", "restart");
    this.statusCache.set(runtimeId, "restarting");
    this.emit();
    await runtime?.database.close();
    this.instances.delete(runtimeId);
    try {
      await this.startInstance(toDefinition(row), "ready");
      await this.updateState(runtimeId, "ready", null);
      await this.finishOperation(runtimeId, "restart", "completed");
    } catch (error) {
      this.statusCache.set(runtimeId, "failed");
      await this.updateState(runtimeId, "failed", null);
      await this.finishOperation(runtimeId, "restart", "failed", error);
      throw error;
    } finally {
      this.emit();
    }
  }

  private async summary(runtimeId: string): Promise<LocalRuntimeSummary> {
    const summary = (await this.list()).find((runtime) => runtime.id === runtimeId);
    if (summary === undefined) throw new LocalRuntimeSupervisorError(404, "runtime_not_found");
    return summary;
  }

  private async rows(): Promise<RuntimeRow[]> {
    return await this.database.prepare(`
      SELECT runtime_id, display_name, storage_key, is_default, status, pending_action, updated_at
      FROM local_runtime_instances ORDER BY is_default DESC, created_at, runtime_id
    `).all() as RuntimeRow[];
  }

  private async row(runtimeId: string): Promise<RuntimeRow> {
    const row = await this.database.prepare(`
      SELECT runtime_id, display_name, storage_key, is_default, status, pending_action, updated_at
      FROM local_runtime_instances WHERE runtime_id = ?
    `).get(runtimeId) as RuntimeRow | undefined;
    if (row === undefined) throw new LocalRuntimeSupervisorError(404, "runtime_not_found");
    return row;
  }

  private async updateState(runtimeId: string, status: LocalRuntimeLifecycleStatus, pendingAction: PendingAction | null): Promise<void> {
    const now = Date.now();
    await this.database.prepare(`
      UPDATE local_runtime_instances SET status = ?, pending_action = ?, updated_at = ? WHERE runtime_id = ?
    `).run(status, pendingAction, now, runtimeId);
    this.statusCache.set(runtimeId, status);
  }

  private async operation(runtimeId: string, operation: string, status: string, detail?: unknown): Promise<void> {
    const now = Date.now();
    await this.database.prepare(`
      INSERT INTO local_runtime_operations(id, runtime_id, operation, status, detail, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `runtime_operation_${randomUUID()}`,
      runtimeId,
      operation,
      status,
      detail === undefined ? null : detail instanceof Error ? detail.message : String(detail),
      now,
      ["completed", "failed"].includes(status) ? now : null,
    );
  }

  private async finishOperation(runtimeId: string, operation: string, status: "completed" | "failed", detail?: unknown): Promise<void> {
    await this.database.prepare(`
      UPDATE local_runtime_operations SET status = ?, detail = ?, completed_at = ?
      WHERE id = (
        SELECT id FROM local_runtime_operations WHERE runtime_id = ? AND operation = ? AND completed_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      )
    `).run(status, detail === undefined ? null : detail instanceof Error ? detail.message : String(detail), Date.now(), runtimeId, operation);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private hasActiveWorkForRuntime(runtimeId: string): boolean {
    return this.activeWorkCount(runtimeId) > 0;
  }

  private activeWorkCount(runtimeId: string): number {
    return (this.instances.get(runtimeId)?.activeRunIds.size ?? 0) + (this.pendingAdmissions.get(runtimeId) ?? 0);
  }
}

export class LocalRuntimeSupervisorError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function toDefinition(row: RuntimeRow): LocalRuntimeDefinition {
  return {
    id: row.runtime_id,
    displayName: row.display_name,
    storageKey: row.storage_key,
    isDefault: row.is_default === 1,
  };
}
