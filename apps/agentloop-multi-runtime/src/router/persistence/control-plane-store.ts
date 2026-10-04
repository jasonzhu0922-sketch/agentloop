import { randomUUID } from "node:crypto";
import { sqlForDialect, upsertSql, type SqlConnection, type SqlValue } from "@zhujun/agentloop";
import { TIDB_CONTROL_PLANE_SCHEMA_SQL } from "./tidb-schema.ts";
import type {
  ConversationAttachmentSnapshot,
  ExecutionLocation,
  PortableResourceRef,
  RuntimeInstance,
  RuntimeKind,
  RuntimeProfile,
  RuntimeRunStatus,
  RuntimeRunOperationsProjection,
  RouterRunPage,
  RouterRunSummary,
  SubmitConversationTask,
} from "../../shared/contracts.ts";
import {
  RuntimeCapacityError,
  type AssignmentStatus,
  type ControlPlaneRepository,
  type DispatchFailure,
  type RuntimeCatalogEntry,
  type RuntimeCatalogPage,
  type RuntimeHeartbeat,
  type StoredAssignment,
  type StoredConversationPage,
  type StoredConversationTurn,
  type StoredRuntimeEndpoint,
  type PersistedRunOperations,
} from "../application/control-plane-contracts.ts";
import { migrateRouterState } from "./state-migrations.ts";

interface TaskRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  conversation_id: string;
  client_message_id: string;
  input: string;
  requested_runtime_id: string | null;
  requested_profile: string | null;
  execution_target_json: string;
  data_policy_json: string;
  required_capabilities_json: string;
  requested_model_key: string | null;
  allow_dangerous_tools: number;
  resource_refs_json: string;
  message_attachments_json: string;
  local_directory_scope_ids_json: string;
  status: string;
}

interface AssignmentRow {
  id: string;
  runtime_id: string;
  endpoint: string;
  dispatch_key: string;
  remote_run_id: string | null;
  status: AssignmentStatus;
  reservation_expires_at: number | null;
  error_code: string | null;
  error_message: string | null;
  tenant_id: string;
  owner_user_id: string;
  conversation_id: string;
}

interface AdminRunRow {
  task_id: string;
  task_input: string;
  task_status: string;
  task_created_at: number;
  task_updated_at: number;
  data_policy_json: string;
  assignment_id: string | null;
  remote_run_id: string | null;
  assignment_status: string | null;
  assignment_error_code: string | null;
  assignment_error_message: string | null;
  runtime_id: string | null;
  runtime_name: string | null;
  turn_model_key: string | null;
  turn_output: string | null;
  turn_status: string | null;
  turn_error_code: string | null;
  turn_completed_at: number | null;
  plan_json: string | null;
  outcome_json: string | null;
}

/** Durable Router control-plane state. It owns neither AgentLoop Runs nor their Evidence. */
export class ControlPlaneStore implements ControlPlaneRepository {
  private readonly database: SqlConnection;
  /** Ephemeral liveness/capacity snapshots; heartbeat pings never write SQL. */
  private readonly runtimeHeartbeats = new Map<string, RuntimeHeartbeat>();
  private readonly registeredRuntimeIds = new Set<string>();

  constructor(database: SqlConnection) {
    this.database = database;
  }

  async ready(): Promise<void> {
    await migrateRouterState(this.database);
    const runtimes = await this.database.prepare("SELECT id FROM mr_runtime_nodes").all() as Array<{ id: string }>;
    for (const runtime of runtimes) this.registeredRuntimeIds.add(runtime.id);
  }

  /** Invoked only by the versioned schema migration registry. */
  async installSchema(): Promise<void> {
    const canonicalSchema = `
      CREATE TABLE IF NOT EXISTS mr_runtime_nodes (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        endpoint TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'cloud',
        device_id TEXT,
        tenant_id TEXT,
        owner_user_id TEXT,
        connection_id TEXT,
        connection_epoch INTEGER,
        lease_expires_at INTEGER,
        catalog_version TEXT,
        profile TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        max_concurrent_runs INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        active_run_count INTEGER NOT NULL DEFAULT 0,
        queued_run_count INTEGER NOT NULL DEFAULT 0,
        last_heartbeat_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mr_tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        input TEXT NOT NULL,
        requested_runtime_id TEXT,
        requested_profile TEXT,
        execution_target_json TEXT NOT NULL DEFAULT '{"kind":"cloud_pool"}',
        data_policy_json TEXT NOT NULL DEFAULT '{"mode":"cloud"}',
        required_capabilities_json TEXT NOT NULL,
        requested_model_key TEXT,
        allow_dangerous_tools INTEGER NOT NULL,
        resource_refs_json TEXT NOT NULL,
        message_attachments_json TEXT NOT NULL DEFAULT '[]',
        local_directory_scope_ids_json TEXT NOT NULL DEFAULT '[]',
        plan_json TEXT,
        outcome_json TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(tenant_id, owner_user_id, conversation_id, client_message_id)
      );
      CREATE TABLE IF NOT EXISTS mr_assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES mr_tasks(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES mr_runtime_nodes(id),
        dispatch_key TEXT NOT NULL UNIQUE,
        remote_run_id TEXT,
        status TEXT NOT NULL,
        reservation_expires_at INTEGER,
        error_code TEXT,
        error_message TEXT,
        last_observed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_assignments_task_idx ON mr_assignments(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS mr_assignments_runtime_state_idx ON mr_assignments(runtime_id, status, reservation_expires_at);
      CREATE TABLE IF NOT EXISTS mr_turns (
        assignment_id TEXT PRIMARY KEY REFERENCES mr_assignments(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        execution_location TEXT NOT NULL DEFAULT 'cloud',
        model_key TEXT,
        user_input TEXT,
        assistant_output TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_turns_conversation_idx ON mr_turns(tenant_id, owner_user_id, conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS mr_conversation_runtime_migrations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL REFERENCES mr_assignments(id) ON DELETE CASCADE,
        previous_runtime_id TEXT NOT NULL REFERENCES mr_runtime_nodes(id),
        selected_runtime_id TEXT NOT NULL REFERENCES mr_runtime_nodes(id),
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_conversation_runtime_migrations_conversation_idx
        ON mr_conversation_runtime_migrations(tenant_id, owner_user_id, conversation_id, created_at DESC);
    `;
    await this.database.exec(this.database.dialect === "tidb" ? TIDB_CONTROL_PLANE_SCHEMA_SQL : canonicalSchema);
    // PostgreSQL deployments always start from the canonical schema above.
    // PRAGMA is exclusively a SQLite legacy-schema inspection mechanism.
    if (this.database.dialect === "sqlite") {
      const taskColumns = await this.database.prepare("PRAGMA table_info(mr_tasks)").all() as Array<{ name: string }>;
      if (!taskColumns.some((column) => column.name === "requested_runtime_id")) {
        await this.database.exec("ALTER TABLE mr_tasks ADD COLUMN requested_runtime_id TEXT");
      }
      if (!taskColumns.some((column) => column.name === "execution_target_json")) {
        await this.database.exec(`ALTER TABLE mr_tasks ADD COLUMN execution_target_json TEXT NOT NULL DEFAULT '{"kind":"cloud_pool"}'`);
      }
      if (!taskColumns.some((column) => column.name === "data_policy_json")) {
        await this.database.exec(`ALTER TABLE mr_tasks ADD COLUMN data_policy_json TEXT NOT NULL DEFAULT '{"mode":"cloud"}'`);
      }
      if (!taskColumns.some((column) => column.name === "local_directory_scope_ids_json")) {
        await this.database.exec("ALTER TABLE mr_tasks ADD COLUMN local_directory_scope_ids_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!taskColumns.some((column) => column.name === "message_attachments_json")) {
        await this.database.exec("ALTER TABLE mr_tasks ADD COLUMN message_attachments_json TEXT NOT NULL DEFAULT '[]'");
      }
      const runtimeColumns = await this.database.prepare("PRAGMA table_info(mr_runtime_nodes)").all() as Array<{ name: string }>;
      for (const [name, definition] of [
        ["kind", "TEXT NOT NULL DEFAULT 'cloud'"],
        ["device_id", "TEXT"],
        ["tenant_id", "TEXT"],
        ["owner_user_id", "TEXT"],
        ["connection_id", "TEXT"],
        ["connection_epoch", "INTEGER"],
        ["lease_expires_at", "INTEGER"],
        ["catalog_version", "TEXT"],
        ["display_name", "TEXT"],
      ] as const) {
        if (!runtimeColumns.some((column) => column.name === name)) {
          await this.database.exec(`ALTER TABLE mr_runtime_nodes ADD COLUMN ${name} ${definition}`);
        }
      }
      const assignmentColumns = await this.database.prepare("PRAGMA table_info(mr_assignments)").all() as Array<{ name: string }>;
      if (!assignmentColumns.some((column) => column.name === "error_code")) {
        await this.database.exec("ALTER TABLE mr_assignments ADD COLUMN error_code TEXT");
      }
      if (!assignmentColumns.some((column) => column.name === "error_message")) {
        await this.database.exec("ALTER TABLE mr_assignments ADD COLUMN error_message TEXT");
      }
      const turnColumns = await this.database.prepare("PRAGMA table_info(mr_turns)").all() as Array<{ name: string }>;
      if (!turnColumns.some((column) => column.name === "execution_location")) {
        await this.database.exec("ALTER TABLE mr_turns ADD COLUMN execution_location TEXT NOT NULL DEFAULT 'cloud'");
        // Old rows predate durable provenance. Recover the immutable location
        // from their Task policy once, while it is still available locally.
        await this.database.exec(`
          UPDATE mr_turns
          SET execution_location = CASE
            WHEN (SELECT data_policy_json FROM mr_tasks t JOIN mr_assignments a ON a.task_id = t.id WHERE a.id = mr_turns.assignment_id) = '{"mode":"local"}' THEN 'local'
            WHEN (SELECT data_policy_json FROM mr_tasks t JOIN mr_assignments a ON a.task_id = t.id WHERE a.id = mr_turns.assignment_id) = '{"mode":"strict_local"}' THEN 'strict_local'
            ELSE 'cloud'
          END
        `);
      }
      if (!turnColumns.some((column) => column.name === "model_key")) {
        await this.database.exec("ALTER TABLE mr_turns ADD COLUMN model_key TEXT");
      }
    }
  }

  async seedRuntimes(runtimes: readonly (RuntimeInstance & { readonly endpoint: string })[], now = Date.now()): Promise<void> {
    await this.database.transaction(async () => {
      const statement = this.database.prepare(upsertSql({
        dialect: this.database.dialect,
        insert: `INSERT INTO mr_runtime_nodes(id, display_name, endpoint, kind, profile, capabilities_json, max_concurrent_runs, status, active_run_count, queued_run_count, updated_at)
          VALUES (?, ?, ?, 'cloud', ?, ?, ?, 'offline', 0, 0, ?)`,
        conflictTarget: "id",
        sqliteAndPostgresUpdate: "display_name = excluded.display_name, endpoint = excluded.endpoint, profile = excluded.profile, capabilities_json = excluded.capabilities_json, updated_at = excluded.updated_at",
        tidbUpdate: "display_name = VALUES(display_name), endpoint = VALUES(endpoint), profile = VALUES(profile), capabilities_json = VALUES(capabilities_json), updated_at = VALUES(updated_at)",
      }));
      for (const runtime of runtimes) {
        await statement.run(runtime.id, runtime.displayName ?? null, runtime.endpoint, runtime.profile, JSON.stringify(runtime.capabilities), runtime.maxConcurrentRuns, now);
        this.registeredRuntimeIds.add(runtime.id);
      }
    });
  }

  /** Registers a Runtime advertised by an authenticated device connection. */
  async registerLocalRuntime(input: {
    readonly runtimeId: string;
    readonly displayName?: string;
    readonly deviceId: string;
    readonly tenantId: string;
    readonly ownerUserId: string;
    readonly connectionId: string;
    readonly connectionEpoch: number;
    readonly profile: RuntimeProfile;
    readonly capabilities: readonly string[];
    readonly maxConcurrentRuns: number;
    readonly status: "ready" | "draining";
    readonly catalogVersion: string;
    readonly leaseExpiresAt: number;
    readonly now?: number;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    const params = [
      input.runtimeId,
      input.displayName ?? null,
      `local-runtime://${input.runtimeId}`,
      input.deviceId,
      input.tenantId,
      input.ownerUserId,
      input.connectionId,
      input.connectionEpoch,
      input.leaseExpiresAt,
      input.catalogVersion,
      input.profile,
      JSON.stringify(input.capabilities),
      input.maxConcurrentRuns,
      input.status,
      now,
      now,
    ] as const;
    await this.database.transaction(async () => {
      // This identity invariant is a compare-and-write operation, not an
      // upsert. SQLite's BEGIN IMMEDIATE serializes it; PostgreSQL and TiDB
      // lock the existing row explicitly.
      const existing = await this.database.prepare(sqlForDialect(this.database.dialect, {
        sqlite: "SELECT kind, device_id FROM mr_runtime_nodes WHERE id = ?",
        postgres: "SELECT kind, device_id FROM mr_runtime_nodes WHERE id = ? FOR UPDATE",
        tidb: "SELECT kind, device_id FROM mr_runtime_nodes WHERE id = ? FOR UPDATE",
      })).get(input.runtimeId) as { kind: string; device_id: string | null } | undefined;
      if (existing !== undefined && (existing.kind !== "local" || existing.device_id !== input.deviceId)) {
        throw new TypeError("runtime_id_conflict");
      }
      if (existing === undefined) {
        await this.database.prepare(`
          INSERT INTO mr_runtime_nodes(
            id, display_name, endpoint, kind, device_id, tenant_id, owner_user_id, connection_id, connection_epoch, lease_expires_at, catalog_version,
            profile, capabilities_json, max_concurrent_runs, status, active_run_count, queued_run_count,
            last_heartbeat_at, updated_at
          ) VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
        `).run(...params);
        return;
      }
      await this.database.prepare(`
        UPDATE mr_runtime_nodes SET
          display_name = COALESCE(?, display_name), endpoint = ?, tenant_id = ?, owner_user_id = ?, connection_id = ?, connection_epoch = ?, lease_expires_at = ?,
          catalog_version = ?, profile = ?, capabilities_json = ?, max_concurrent_runs = ?, status = ?,
          last_heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND kind = 'local' AND device_id = ?
      `).run(
        params[1], params[2], params[4], params[5], params[6], params[7], params[8], params[9], params[10], params[11], params[12],
        params[13], params[14], params[15], input.runtimeId, input.deviceId,
      );
    });
    this.registeredRuntimeIds.add(input.runtimeId);
    this.runtimeHeartbeats.set(input.runtimeId, {
      runtimeId: input.runtimeId,
      status: input.status,
      activeRunCount: 0,
      queuedRunCount: 0,
      maxConcurrentRuns: input.maxConcurrentRuns,
      observedAt: now,
    });
  }

  async disconnectLocalRuntimes(connectionId: string, now = Date.now()): Promise<void> {
    await this.database.prepare(`
      UPDATE mr_runtime_nodes SET status = 'offline', lease_expires_at = ?, updated_at = ?
      WHERE kind = 'local' AND connection_id = ?
    `).run(now, now, connectionId);
    const runtimes = await this.database.prepare("SELECT id FROM mr_runtime_nodes WHERE kind = 'local' AND connection_id = ?").all(connectionId) as Array<{ id: string }>;
    for (const runtime of runtimes) this.runtimeHeartbeats.delete(runtime.id);
  }

  async unregisterLocalRuntime(runtimeId: string, connectionId: string, now = Date.now()): Promise<void> {
    await this.database.prepare(`
      UPDATE mr_runtime_nodes SET status = 'offline', lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND kind = 'local' AND connection_id = ?
    `).run(now, now, runtimeId, connectionId);
    this.runtimeHeartbeats.delete(runtimeId);
    this.registeredRuntimeIds.delete(runtimeId);
  }

  async heartbeat(heartbeat: RuntimeHeartbeat): Promise<void> {
    if (!Number.isSafeInteger(heartbeat.activeRunCount) || heartbeat.activeRunCount < 0) throw new TypeError("activeRunCount must be a non-negative integer");
    if (!Number.isSafeInteger(heartbeat.queuedRunCount) || heartbeat.queuedRunCount < 0) throw new TypeError("queuedRunCount must be a non-negative integer");
    if (heartbeat.maxConcurrentRuns !== undefined && (!Number.isSafeInteger(heartbeat.maxConcurrentRuns) || heartbeat.maxConcurrentRuns < 1)) {
      throw new TypeError("maxConcurrentRuns must be a positive integer");
    }
    if (heartbeat.startedAt !== undefined && (!Number.isSafeInteger(heartbeat.startedAt) || heartbeat.startedAt < 0)) throw new TypeError("startedAt must be a non-negative integer");
    if (!this.registeredRuntimeIds.has(heartbeat.runtimeId)) throw new TypeError("runtime is not statically registered");
    this.runtimeHeartbeats.set(heartbeat.runtimeId, heartbeat);
  }

  async runtimeEndpoints(tenantId?: string, ownerUserId?: string): Promise<readonly StoredRuntimeEndpoint[]> {
    if (tenantId === undefined || ownerUserId === undefined) {
      return await this.database.prepare("SELECT id, endpoint FROM mr_runtime_nodes WHERE kind = 'cloud' ORDER BY id").all() as StoredRuntimeEndpoint[];
    }
    return await this.database.prepare(`
      SELECT id, endpoint FROM mr_runtime_nodes
      WHERE kind = 'cloud' OR (kind = 'local' AND tenant_id = ? AND owner_user_id = ?)
      ORDER BY id
    `).all(tenantId, ownerUserId) as StoredRuntimeEndpoint[];
  }

  /** Static Hosts registered with this Router; availability remains heartbeat-driven. */
  async runtimeCatalog(tenantId?: string, ownerUserId?: string): Promise<readonly RuntimeCatalogEntry[]> {
    const rows = await (tenantId === undefined || ownerUserId === undefined
      ? this.database.prepare("SELECT id, display_name, profile, kind, device_id, status FROM mr_runtime_nodes WHERE kind = 'cloud' ORDER BY id").all()
      : this.database.prepare(`
          SELECT id, display_name, profile, kind, device_id, status FROM mr_runtime_nodes
          WHERE kind = 'cloud' OR (kind = 'local' AND tenant_id = ? AND owner_user_id = ?)
          ORDER BY id
    `).all(tenantId, ownerUserId)) as Array<{
      id: string;
      display_name: string | null;
      profile: RuntimeProfile;
      kind: RuntimeKind;
      device_id: string | null;
      status: "ready" | "draining" | "offline";
    }>;
    return rows.map((row) => ({
      id: row.id,
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      profile: row.profile,
      kind: row.kind,
      status: this.runtimeHeartbeats.get(row.id)?.status ?? row.status,
      ...(row.device_id === null ? {} : { deviceId: row.device_id }),
    }));
  }

  /** Full Router-owned Runtime inventory for the separately authenticated Admin plane. */
  async adminRuntimeCatalog(input: { readonly scopeId?: string; readonly limit: number; readonly offset: number }): Promise<RuntimeCatalogPage> {
    const scopeFilter = input.scopeId === undefined ? "" : "WHERE kind = 'cloud' OR tenant_id = ?";
    const scopeParams = input.scopeId === undefined ? [] : [input.scopeId];
    const rows = await this.database.prepare(`
      SELECT id, display_name, profile, kind, device_id, tenant_id, status,
        capabilities_json, max_concurrent_runs, active_run_count, queued_run_count,
        catalog_version, last_heartbeat_at, lease_expires_at, updated_at
      FROM mr_runtime_nodes
      ${scopeFilter}
      ORDER BY updated_at DESC, id DESC
    `).all(...scopeParams) as Array<{
      id: string;
      display_name: string | null;
      profile: RuntimeProfile;
      kind: RuntimeKind;
      device_id: string | null;
      tenant_id: string | null;
      status: "ready" | "draining" | "offline";
      capabilities_json: string;
      max_concurrent_runs: number | string;
      active_run_count: number | string;
      queued_run_count: number | string;
      catalog_version: string | null;
      last_heartbeat_at: number | string | null;
      lease_expires_at: number | string | null;
      updated_at: number | string;
    }>;
    // Heartbeat status is intentionally process-local. Filter the resolved
    // status here so both persisted and freshly observed offline Runtimes are
    // removed before pagination.
    const inventory = rows.map((row) => {
      const heartbeat = this.runtimeHeartbeats.get(row.id);
      return {
        id: row.id,
        ...(row.display_name === null ? {} : { displayName: row.display_name }),
        profile: row.profile,
        kind: row.kind,
        status: heartbeat?.status ?? row.status,
        ...(row.device_id === null ? {} : { deviceId: row.device_id }),
        ...(row.tenant_id === null ? {} : { scopeId: row.tenant_id }),
        capabilities: parseStringArray(row.capabilities_json),
        maxConcurrentRuns: heartbeat?.maxConcurrentRuns ?? integerValue(row.max_concurrent_runs),
        activeRunCount: heartbeat?.activeRunCount ?? integerValue(row.active_run_count),
        queuedRunCount: heartbeat?.queuedRunCount ?? integerValue(row.queued_run_count),
        ...(row.catalog_version === null ? {} : { catalogVersion: row.catalog_version }),
        startedAt: heartbeat?.startedAt ?? integerValue(row.updated_at),
        ...(heartbeat === undefined ? (row.last_heartbeat_at === null ? {} : { lastHeartbeatAt: integerValue(row.last_heartbeat_at) }) : { lastHeartbeatAt: heartbeat.observedAt }),
        ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: integerValue(row.lease_expires_at) }),
      };
    }).filter((runtime) => runtime.status !== "offline");
    const total = inventory.length;
    const pageCount = Math.max(1, Math.ceil(total / input.limit));
    const page = Math.min(Math.floor(input.offset / input.limit) + 1, pageCount);
    return { items: inventory.slice(input.offset, input.offset + input.limit), page, pageSize: input.limit, total, pageCount };
  }

  /** Router-owned conversation index, ordered by the latest task activity. */
  async listConversations(
    tenantId: string,
    ownerUserId: string,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<StoredConversationPage> {
    const rows = await this.database.prepare(`
      SELECT
        grouped.conversation_id,
        grouped.created_at,
        grouped.updated_at,
        grouped.run_count,
        (
          SELECT first_task.input
          FROM mr_tasks first_task
          WHERE first_task.tenant_id = grouped.tenant_id
            AND first_task.owner_user_id = grouped.owner_user_id
            AND first_task.conversation_id = grouped.conversation_id
          ORDER BY first_task.created_at ASC, first_task.id ASC
          LIMIT 1
        ) AS title,
        (
          SELECT latest_task.status
          FROM mr_tasks latest_task
          WHERE latest_task.tenant_id = grouped.tenant_id
            AND latest_task.owner_user_id = grouped.owner_user_id
            AND latest_task.conversation_id = grouped.conversation_id
          ORDER BY latest_task.created_at DESC, latest_task.id DESC
          LIMIT 1
        ) AS last_status
      FROM (
        SELECT tenant_id, owner_user_id, conversation_id,
          MIN(created_at) AS created_at,
          MAX(updated_at) AS updated_at,
          COUNT(*) AS run_count
        FROM mr_tasks
        WHERE tenant_id = ? AND owner_user_id = ?
        GROUP BY tenant_id, owner_user_id, conversation_id
      ) grouped
      ORDER BY grouped.updated_at DESC, grouped.conversation_id DESC
      LIMIT ? OFFSET ?
    `).all(tenantId, ownerUserId, page.limit + 1, page.offset) as Array<{
      conversation_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      run_count: number;
      last_status: string;
    }>;
    const visibleRows = rows.slice(0, page.limit);
    const conversations = visibleRows.map((row) => ({
      id: row.conversation_id,
      title: row.title.slice(0, 36),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      runCount: Number(row.run_count),
      lastStatus: row.last_status,
    }));
    const hasMore = rows.length > page.limit;
    return {
      conversations,
      hasMore,
      ...(hasMore ? { nextOffset: page.offset + conversations.length } : {}),
    };
  }

  /** Chronological turn index; Run output and events remain Host-owned. */
  async conversation(
    tenantId: string,
    ownerUserId: string,
    conversationId: string,
  ): Promise<{ readonly turns: readonly StoredConversationTurn[] } | undefined> {
    const rows = await this.database.prepare(`
      SELECT
        t.client_message_id,
        t.input,
        t.resource_refs_json,
        t.message_attachments_json,
        t.data_policy_json,
        t.created_at,
        t.updated_at,
        a.id AS assignment_id,
        a.runtime_id,
        runtime.display_name AS runtime_display_name,
        a.remote_run_id,
        a.status AS assignment_status,
        a.error_code,
        a.error_message,
        turn.assistant_output AS final_assistant_output,
        turn.status AS final_status,
        turn.error_code AS final_error_code,
        turn.model_key AS final_model_key,
        turn.completed_at AS final_completed_at
      FROM mr_tasks t
      LEFT JOIN (
        SELECT id, task_id, runtime_id, remote_run_id, status, error_code, error_message
        FROM (
          SELECT
            latest_assignment.id,
            latest_assignment.task_id,
            latest_assignment.runtime_id,
            latest_assignment.remote_run_id,
            latest_assignment.status,
            latest_assignment.error_code,
            latest_assignment.error_message,
            ROW_NUMBER() OVER (
              PARTITION BY latest_assignment.task_id
              ORDER BY latest_assignment.created_at DESC, latest_assignment.id DESC
            ) AS assignment_rank
          FROM mr_assignments latest_assignment
        ) ranked_assignments
        WHERE assignment_rank = 1
      ) a ON a.task_id = t.id
      LEFT JOIN mr_turns turn ON turn.assignment_id = a.id
      LEFT JOIN mr_runtime_nodes runtime ON runtime.id = a.runtime_id
      WHERE t.tenant_id = ? AND t.owner_user_id = ? AND t.conversation_id = ?
      ORDER BY t.created_at ASC, t.id ASC
    `).all(tenantId, ownerUserId, conversationId) as Array<{
      client_message_id: string;
      input: string;
      resource_refs_json: string;
      message_attachments_json: string;
      data_policy_json: string;
      created_at: number;
      updated_at: number;
      assignment_id: string | null;
      runtime_id: string | null;
      runtime_display_name: string | null;
      remote_run_id: string | null;
      assignment_status: AssignmentStatus | null;
      error_code: string | null;
      error_message: string | null;
      final_assistant_output: string | null;
      final_status: "completed" | "failed" | "cancelled" | null;
      final_error_code: string | null;
      final_model_key: string | null;
      final_completed_at: number | null;
    }>;
    if (rows.length === 0) return undefined;
    return {
      turns: rows.map((row) => ({
        clientMessageId: row.client_message_id,
        input: row.input,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        attachments: browserAttachments(row.message_attachments_json, row.resource_refs_json),
        ...(row.final_status === null || row.final_completed_at === null ? {} : {
          finalTurn: {
            status: row.final_status,
            ...(row.final_assistant_output === null ? {} : { assistantOutput: row.final_assistant_output }),
            ...(row.final_error_code === null ? {} : { errorCode: row.final_error_code }),
            ...(row.final_model_key === null ? {} : { modelKey: row.final_model_key }),
            completedAt: row.final_completed_at,
          },
        }),
        ...(row.assignment_id === null || row.runtime_id === null || row.assignment_status === null ? {} : {
          assignment: {
            id: row.assignment_id,
            runtimeId: row.runtime_id,
            ...(row.runtime_display_name === null ? {} : { runtimeDisplayName: row.runtime_display_name }),
            executionLocation: executionLocationFromDataPolicy(row.data_policy_json),
            status: row.assignment_status,
            hasRun: row.remote_run_id !== null,
            ...(row.remote_run_id === null ? {} : { remoteRunId: row.remote_run_id }),
            ...(row.error_code === null ? {} : { errorCode: row.error_code }),
            ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
          },
        }),
      })),
    };
  }

  async listAdminRuns(page: { readonly limit: number; readonly offset: number }): Promise<RouterRunPage> {
    const rows = await this.database.prepare(adminRunSelect("ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?")).all(page.limit, page.offset) as AdminRunRow[];
    const totalRow = await this.database.prepare("SELECT COUNT(*) AS total FROM mr_tasks").get() as { total: number };
    const total = Number(totalRow.total);
    const pageCount = Math.max(1, Math.ceil(total / page.limit));
    const normalizedPage = Math.min(Math.floor(page.offset / page.limit) + 1, pageCount);
    return { items: rows.map(toAdminRunSummary), page: normalizedPage, pageSize: page.limit, total, pageCount };
  }

  async adminRun(id: string): Promise<RouterRunSummary | undefined> {
    const row = await this.database.prepare(adminRunSelect("WHERE t.id = ? OR a.remote_run_id = ? LIMIT 1")).get(id, id) as AdminRunRow | undefined;
    return row === undefined ? undefined : toAdminRunSummary(row);
  }

  /** Remove one persisted conversation only when no Runtime may still mutate it. */
  async deleteConversation(tenantId: string, ownerUserId: string, conversationId: string): Promise<void> {
    await this.database.transaction(async () => {
      const active = await this.database.prepare(`
        SELECT 1
        FROM mr_tasks task JOIN mr_assignments assignment ON assignment.task_id = task.id
        WHERE task.tenant_id = ? AND task.owner_user_id = ? AND task.conversation_id = ?
          AND assignment.status IN ('reserved', 'accepted', 'unknown')
        LIMIT 1
      `).get(tenantId, ownerUserId, conversationId);
      if (active !== undefined) throw new ConversationDeleteConflictError();
      await this.database.prepare(`
        DELETE FROM mr_tasks WHERE tenant_id = ? AND owner_user_id = ? AND conversation_id = ?
      `).run(tenantId, ownerUserId, conversationId);
    });
  }

  async reserve(task: SubmitConversationTask, input: { readonly heartbeatTtlMs: number; readonly reservationTtlMs: number; readonly now?: number }): Promise<StoredAssignment> {
    const now = input.now ?? Date.now();
    return await this.database.transaction(async () => {
      await this.expireReservations(now);
      const existing = await this.findTask(task);
      if (existing !== undefined) {
        const current = await this.latestAssignment(existing.id);
        if (current !== undefined && current.status !== "expired" && current.status !== "failed") return toStoredAssignment(current);
        const executionTarget = JSON.parse(existing.execution_target_json) as { kind: string };
        if (current !== undefined && executionTarget.kind === "local_device") {
          return await this.rearmLocalAssignment(current, existing, now, input.heartbeatTtlMs, input.reservationTtlMs);
        }
        return await this.reserveForTask(existing, now, input.heartbeatTtlMs, input.reservationTtlMs);
      }
      const created: TaskRow = {
        id: `task_${randomUUID()}`,
        tenant_id: task.tenantId,
        owner_user_id: task.ownerUserId,
        conversation_id: task.conversationId,
        client_message_id: task.clientMessageId,
        input: task.dataPolicy?.mode === "strict_local" ? "" : task.input,
        requested_runtime_id: task.requestedRuntimeId ?? null,
        requested_profile: task.requestedProfile ?? null,
        execution_target_json: JSON.stringify(task.executionTarget ?? { kind: "cloud_pool", ...(task.requestedProfile === undefined ? {} : { profile: task.requestedProfile }) }),
        data_policy_json: JSON.stringify(task.dataPolicy ?? { mode: "cloud" }),
        required_capabilities_json: JSON.stringify(task.requiredCapabilities ?? []),
        requested_model_key: task.requestedModelKey ?? null,
        allow_dangerous_tools: task.allowDangerousTools !== false ? 1 : 0,
        resource_refs_json: JSON.stringify(task.resourceRefs ?? []),
        message_attachments_json: JSON.stringify(task.messageAttachments ?? browserAttachmentsFromResourceRefs(task.resourceRefs ?? [])),
        local_directory_scope_ids_json: JSON.stringify(task.localDirectoryScopeIds ?? []),
        status: "dispatching",
      };
      await this.database.prepare(`
        INSERT INTO mr_tasks(id, tenant_id, owner_user_id, conversation_id, client_message_id, input, requested_runtime_id, requested_profile, execution_target_json, data_policy_json, required_capabilities_json, requested_model_key, allow_dangerous_tools, resource_refs_json, message_attachments_json, local_directory_scope_ids_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        created.id, created.tenant_id, created.owner_user_id, created.conversation_id, created.client_message_id,
        created.input, created.requested_runtime_id, created.requested_profile, created.execution_target_json, created.data_policy_json, created.required_capabilities_json, created.requested_model_key,
        created.allow_dangerous_tools, created.resource_refs_json, created.message_attachments_json, created.local_directory_scope_ids_json, created.status, now, now,
      );
      return await this.reserveForTask(created, now, input.heartbeatTtlMs, input.reservationTtlMs);
    });
  }

  async markAccepted(assignmentId: string, remoteRunId: string, now = Date.now()): Promise<void> {
    await this.database.transaction(async () => {
      const result = await this.database.prepare(`
        UPDATE mr_assignments SET remote_run_id = ?, status = 'accepted', reservation_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'reserved'
      `).run(remoteRunId, now, assignmentId);
      if (result.changes === 0) return;
      await this.database.prepare(`UPDATE mr_tasks SET status = 'running', updated_at = ? WHERE id = (SELECT task_id FROM mr_assignments WHERE id = ?)`)
        .run(now, assignmentId);
    });
  }

  async markDispatchFailure(assignmentId: string, failure: DispatchFailure, now = Date.now()): Promise<void> {
    if (!isSafeDispatchFailure(failure)) throw new TypeError("invalid dispatch failure");
    await this.database.transaction(async () => {
      const result = await this.database.prepare(`
        UPDATE mr_assignments
        SET status = 'failed', reservation_expires_at = NULL, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND status = 'reserved'
      `).run(failure.code, failure.message, now, assignmentId);
      if (result.changes === 0) return;
      await this.database.prepare(`UPDATE mr_tasks SET status = 'failed', updated_at = ? WHERE id = (SELECT task_id FROM mr_assignments WHERE id = ?)`)
        .run(now, assignmentId);
    });
  }

  async createContinuationAssignment(parentAssignmentId: string, remoteRunId: string, now = Date.now()): Promise<StoredAssignment> {
    return await this.database.transaction(async () => {
      const parent = await this.database.prepare(`
        SELECT a.task_id, a.runtime_id, a.created_at FROM mr_assignments a WHERE a.id = ?
      `).get(parentAssignmentId) as { task_id: string; runtime_id: string; created_at: number } | undefined;
      if (parent === undefined) throw new RangeError("parent assignment not found");
      const continuationAt = Math.max(now, parent.created_at + 1);
      const id = `assignment_${randomUUID()}`;
      await this.database.prepare(`
        INSERT INTO mr_assignments(
          id, task_id, runtime_id, dispatch_key, remote_run_id, status,
          reservation_expires_at, last_observed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'accepted', NULL, ?, ?, ?)
      `).run(id, parent.task_id, parent.runtime_id, `checkpoint_${randomUUID()}`, remoteRunId, continuationAt, continuationAt, continuationAt);
      await this.database.prepare("UPDATE mr_tasks SET status = 'running', updated_at = ? WHERE id = ?")
        .run(continuationAt, parent.task_id);
      const row = await this.database.prepare(assignmentSelect("WHERE a.id = ?")).get(id) as AssignmentRow;
      return toStoredAssignment(row);
    });
  }

  async observeRun(assignmentId: string, run: RuntimeRunStatus, now = Date.now()): Promise<void> {
    const status = run.status === "running" ? "accepted" : run.status;
    const finishedAt = Number.isSafeInteger(run.finishedAt) && run.finishedAt! >= 0 ? run.finishedAt! : null;
    const completedAt = terminalTurnCompletedAt(finishedAt, now);
    const provenance = await this.database.prepare(`
      SELECT t.data_policy_json FROM mr_assignments a JOIN mr_tasks t ON t.id = a.task_id WHERE a.id = ?
    `).get(assignmentId) as { data_policy_json: string } | undefined;
    if (provenance === undefined) throw new RangeError("assignment not found");
    const executionLocation = executionLocationFromDataPolicy(provenance.data_policy_json);
    await this.database.transaction(async () => {
      // A Host Run is terminal once completed, failed, or cancelled.  A late
      // status poll must not turn that durable terminal projection back into
      // an in-progress Assignment.
      const updated = await this.database.prepare(`
        UPDATE mr_assignments
        SET status = ?,
          error_code = CASE WHEN ? = 'failed' THEN COALESCE(?, error_code) ELSE error_code END,
          error_message = CASE WHEN ? = 'failed' THEN COALESCE(?, error_message) ELSE error_message END,
          last_observed_at = ?, updated_at = CASE WHEN ? = 'accepted' THEN updated_at ELSE ? END
        WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
      `)
        .run(
          status,
          status,
          run.errorCode ?? null,
          status,
          run.errorMessage ?? null,
          now,
          status,
          now,
          assignmentId,
        );
      if (updated.changes === 0) return;
      if (status !== "accepted") {
        // Observation time belongs to the assignment. Conversation recency must
        // use the Host's activity time, never the time a poll happens to discover it.
        // An unknown finish time must not manufacture new user-visible activity.
        const taskProjection = terminalTaskProjectionUpdate(status, assignmentId, finishedAt);
        await this.database.prepare(taskProjection.sql).run(...taskProjection.params);
        await this.database.prepare(upsertSql({
          dialect: this.database.dialect,
          insert: `INSERT INTO mr_turns(
            assignment_id, tenant_id, owner_user_id, conversation_id, client_message_id,
            runtime_id, execution_location, model_key, user_input, assistant_output, status, error_code, created_at, completed_at
          )
          SELECT a.id, t.tenant_id, t.owner_user_id, t.conversation_id, t.client_message_id,
            a.runtime_id, ?, ?,
            CASE WHEN t.data_policy_json = '{"mode":"strict_local"}' THEN NULL ELSE t.input END,
            CASE WHEN t.data_policy_json = '{"mode":"strict_local"}' THEN NULL ELSE ? END,
            ?, ?, t.created_at, ?
          FROM mr_assignments a JOIN mr_tasks t ON t.id = a.task_id
          WHERE a.id = ? AND t.data_policy_json <> '{"mode":"strict_local"}'`,
          conflictTarget: "assignment_id",
          sqliteAndPostgresUpdate: "assistant_output = excluded.assistant_output, status = excluded.status, error_code = excluded.error_code, model_key = COALESCE(excluded.model_key, mr_turns.model_key), completed_at = excluded.completed_at",
          tidbUpdate: "assistant_output = VALUES(assistant_output), status = VALUES(status), error_code = VALUES(error_code), model_key = COALESCE(VALUES(model_key), model_key), completed_at = VALUES(completed_at)",
        })).run(executionLocation, run.modelKey ?? null, run.output ?? run.partialOutput ?? null, status, run.errorCode ?? null, completedAt, assignmentId);
      }
    });
  }

  async persistRunOperations(assignmentId: string, projection: RuntimeRunOperationsProjection): Promise<void> {
    await this.database.prepare(`
      UPDATE mr_tasks SET plan_json = ?, outcome_json = ?, updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
      WHERE id = (SELECT task_id FROM mr_assignments WHERE id = ?)
    `).run(JSON.stringify(projection.plan), projection.outcome === undefined ? null : JSON.stringify(projection.outcome), projection.run.createdAt, projection.run.createdAt, assignmentId);
  }

  async readRunOperations(assignmentId: string): Promise<PersistedRunOperations | undefined> {
    const row = await this.database.prepare("SELECT plan_json, outcome_json FROM mr_tasks WHERE id = (SELECT task_id FROM mr_assignments WHERE id = ?)").get(assignmentId) as { plan_json?: string | null; outcome_json?: string | null } | undefined;
    if (row?.plan_json === undefined || row.plan_json === null) return undefined;
    return { plan: JSON.parse(row.plan_json) as PersistedRunOperations["plan"], ...(row.outcome_json === null || row.outcome_json === undefined ? {} : { outcome: JSON.parse(row.outcome_json) as PersistedRunOperations["outcome"] }) };
  }

  async assignment(id: string): Promise<StoredAssignment | undefined> {
    const row = await this.database.prepare(assignmentSelect("WHERE a.id = ?")).get(id) as AssignmentRow | undefined;
    return row === undefined ? undefined : toStoredAssignment(row);
  }

  /** Keyset batches avoid starving later assignments when a Host stays unreachable. */
  async unsettledAssignments(afterId: string, limit: number): Promise<readonly StoredAssignment[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("invalid reconciliation batch size");
    const rows = await this.database.prepare(assignmentSelect(
      "WHERE a.status IN ('accepted', 'unknown') AND a.remote_run_id IS NOT NULL AND a.remote_run_id <> '' AND a.id > ? ORDER BY a.id LIMIT ?",
    )).all(afterId, limit) as AssignmentRow[];
    return rows.map(toStoredAssignment);
  }

  private async reserveForTask(task: TaskRow, now: number, heartbeatTtlMs: number, reservationTtlMs: number): Promise<StoredAssignment> {
    const executionTarget = JSON.parse(task.execution_target_json) as { kind: "cloud_pool"; profile?: RuntimeProfile } | { kind: "local_device"; deviceId: string; runtimeId: string };
    const selectedRuntimeId = executionTarget.kind === "local_device" ? executionTarget.runtimeId : task.requested_runtime_id;
    if (selectedRuntimeId !== null) {
      const configured = await this.database.prepare("SELECT id FROM mr_runtime_nodes WHERE id = ?").get(selectedRuntimeId) as { id: string } | undefined;
      if (configured === undefined) throw new TypeError(`Runtime \"${selectedRuntimeId}\" is not registered`);
    }
    const candidates = await this.database.prepare(`
      SELECT n.id, n.endpoint, n.kind, n.device_id, n.tenant_id, n.owner_user_id, n.profile, n.capabilities_json, n.max_concurrent_runs
      FROM mr_runtime_nodes n
    `).all() as Array<{
      id: string; endpoint: string; kind: RuntimeKind; device_id: string | null; tenant_id: string | null; owner_user_id: string | null; profile: RuntimeProfile; capabilities_json: string; max_concurrent_runs: number;
    }>;
    const required = JSON.parse(task.required_capabilities_json) as string[];
    // Keep the database-facing name snake_case. PostgreSQL folds unquoted
    // camelCase aliases to lowercase, while SQLite and TiDB preserve them;
    // reading `runtimeId` here would turn a real affinity into undefined only
    // after switching the shared control plane to PostgreSQL.
    const affinity = await this.database.prepare(`
      SELECT a.runtime_id AS runtime_id
      FROM mr_assignments a JOIN mr_tasks t ON t.id = a.task_id
      WHERE t.tenant_id = ? AND t.owner_user_id = ? AND t.conversation_id = ?
        -- A reservation prevents capacity oversubscription while dispatch is
        -- in flight, but it has not started a Run and must not make the
        -- conversation sticky to that Host.  Affinity begins only after the
        -- Host has accepted the dispatch and supplied a remote Run id.
        AND a.remote_run_id IS NOT NULL
      ORDER BY a.created_at DESC LIMIT 1
    `).get(task.tenant_id, task.owner_user_id, task.conversation_id) as { runtime_id: string } | undefined;
    const eligibleCandidates = [];
    for (const node of candidates) {
      const heartbeat = this.runtimeHeartbeats.get(node.id);
      if (heartbeat === undefined || heartbeat.status !== "ready" || heartbeat.observedAt < now - heartbeatTtlMs) continue;
      eligibleCandidates.push({
        ...node,
        active_run_count: heartbeat.activeRunCount,
        queued_run_count: heartbeat.queuedRunCount,
        max_concurrent_runs: heartbeat.maxConcurrentRuns ?? node.max_concurrent_runs,
        pending_admissions: await this.pendingAdmissionCount(node.id, heartbeat.observedAt),
      });
    }
    const eligible = eligibleCandidates
      .filter((node) => (executionTarget.kind === "local_device"
        ? node.kind === "local" && node.device_id === executionTarget.deviceId && node.id === executionTarget.runtimeId
          && node.tenant_id === task.tenant_id && node.owner_user_id === task.owner_user_id
        : node.kind === "cloud" && (selectedRuntimeId === null || node.id === selectedRuntimeId))
        && (task.requested_profile === null || node.profile === task.requested_profile)
        && required.every((capability) => (JSON.parse(node.capabilities_json) as string[]).includes(capability)))
      .filter((node) => node.active_run_count + Number(node.pending_admissions) < node.max_concurrent_runs)
      .sort((left, right) => {
        if (affinity !== undefined && left.id === affinity.runtime_id) return -1;
        if (affinity !== undefined && right.id === affinity.runtime_id) return 1;
        return score(left) - score(right) || left.id.localeCompare(right.id);
      });
    // Affinity is deliberately a preference, never an availability gate.  The
    // old Host can be draining, full, or absent; in each case a new Run may
    // use another compatible healthy Host.  A running Run itself is not moved
    // here -- that requires the separate run-lease/fencing recovery protocol.
    const selected = eligible[0];
    if (selected === undefined && selectedRuntimeId !== null) {
      throw new RuntimeCapacityError(`Runtime \"${selectedRuntimeId}\" is not ready or has no reservable capacity slot`);
    }
    if (selected === undefined) throw new RuntimeCapacityError("No healthy Runtime has a reservable capacity slot");
    const id = `assignment_${randomUUID()}`;
    const dispatchKey = `dispatch_${randomUUID()}`;
    const expires = now + reservationTtlMs;
    await this.database.prepare(`
      INSERT INTO mr_assignments(id, task_id, runtime_id, dispatch_key, status, reservation_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)
    `).run(id, task.id, selected.id, dispatchKey, expires, now, now);
    if (affinity !== undefined && affinity.runtime_id !== selected.id) {
      await this.database.prepare(`
        INSERT INTO mr_conversation_runtime_migrations(
          id, tenant_id, owner_user_id, conversation_id, assignment_id,
          previous_runtime_id, selected_runtime_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'preferred_runtime_unavailable_or_at_capacity', ?)
      `).run(
        `migration_${randomUUID()}`,
        task.tenant_id,
        task.owner_user_id,
        task.conversation_id,
        id,
        affinity.runtime_id,
        selected.id,
        now,
      );
    }
    const row = await this.database.prepare(assignmentSelect("WHERE a.id = ?")).get(id) as AssignmentRow;
    return toStoredAssignment(row);
  }

  /**
   * A Local Agent may create a Run immediately before its ACK is lost. Reuse
   * the same Assignment and dispatch key so the Agent ledger returns that Run
   * instead of starting a duplicate after reconnect.
   */
  private async rearmLocalAssignment(
    current: AssignmentRow,
    task: TaskRow,
    now: number,
    heartbeatTtlMs: number,
    reservationTtlMs: number,
  ): Promise<StoredAssignment> {
    const heartbeat = this.runtimeHeartbeats.get(current.runtime_id);
    if (heartbeat === undefined || heartbeat.status !== "ready" || heartbeat.observedAt < now - heartbeatTtlMs) {
      throw new RuntimeCapacityError(`Runtime \"${current.runtime_id}\" is not ready or has no reservable capacity slot`);
    }
    await this.database.prepare(`
      UPDATE mr_assignments
      SET status = 'reserved', reservation_expires_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND remote_run_id IS NULL
    `).run(now + reservationTtlMs, now, current.id);
    await this.database.prepare("UPDATE mr_tasks SET status = 'dispatching', updated_at = ? WHERE id = ?").run(now, task.id);
    const row = await this.database.prepare(assignmentSelect("WHERE a.id = ?")).get(current.id) as AssignmentRow;
    return toStoredAssignment(row);
  }

  private async pendingAdmissionCount(runtimeId: string, heartbeatObservedAt: number): Promise<number> {
    const row = await this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM mr_assignments
      WHERE runtime_id = ? AND (status = 'reserved' OR (status = 'accepted' AND updated_at > ?))
    `).get(runtimeId, heartbeatObservedAt) as { count: number | string };
    return Number(row.count);
  }

  private async expireReservations(now: number): Promise<void> {
    await this.database.prepare(`UPDATE mr_assignments SET status = 'expired', updated_at = ? WHERE status = 'reserved' AND reservation_expires_at < ?`)
      .run(now, now);
    await this.database.prepare(`UPDATE mr_tasks SET status = 'queued', updated_at = ? WHERE status = 'dispatching' AND id IN (SELECT task_id FROM mr_assignments WHERE status = 'expired')`)
      .run(now);
  }

  private async findTask(task: SubmitConversationTask): Promise<TaskRow | undefined> {
    return await this.database.prepare(`
      SELECT id, tenant_id, owner_user_id, conversation_id, client_message_id, input, requested_runtime_id, requested_profile, execution_target_json, data_policy_json, required_capabilities_json, requested_model_key, allow_dangerous_tools, resource_refs_json, message_attachments_json, local_directory_scope_ids_json, status
      FROM mr_tasks WHERE tenant_id = ? AND owner_user_id = ? AND conversation_id = ? AND client_message_id = ?
    `).get(task.tenantId, task.ownerUserId, task.conversationId, task.clientMessageId) as TaskRow | undefined;
  }

  private async latestAssignment(taskId: string): Promise<AssignmentRow | undefined> {
    return await this.database.prepare(assignmentSelect("WHERE a.task_id = ? ORDER BY a.created_at DESC LIMIT 1")).get(taskId) as AssignmentRow | undefined;
  }
}

/**
 * A PostgreSQL parameter used only in `? IS NULL` has no inferred type.  Keep
 * the unknown-finish branch free of timestamp parameters rather than asking a
 * database driver to manufacture a timestamp from NULL.
 */
export function terminalTaskProjectionUpdate(
  status: Exclude<AssignmentStatus, "reserved" | "accepted" | "unknown" | "expired">,
  assignmentId: string,
  finishedAt: number | null,
): { readonly sql: string; readonly params: readonly SqlValue[] } {
  const latestAssignment = `
    id = (SELECT task_id FROM mr_assignments WHERE id = ?)
      AND ? = (SELECT latest.id FROM mr_assignments latest WHERE latest.task_id = mr_tasks.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
  `;
  if (finishedAt === null) {
    return {
      sql: `UPDATE mr_tasks SET status = ? WHERE ${latestAssignment}`,
      params: [status, assignmentId, assignmentId],
    };
  }
  return {
    sql: `UPDATE mr_tasks SET status = ?, updated_at = CASE WHEN ? < created_at THEN created_at ELSE ? END WHERE ${latestAssignment}`,
    params: [status, finishedAt, finishedAt, assignmentId, assignmentId],
  };
}

/** Resolve the terminal instant before SQL binding so PostgreSQL sees one typed value. */
export function terminalTurnCompletedAt(finishedAt: number | null, observedAt: number): number {
  return finishedAt ?? observedAt;
}

export async function installControlPlaneSchema(database: SqlConnection): Promise<void> {
  await new ControlPlaneStore(database).installSchema();
}

export class ConversationDeleteConflictError extends Error {
  readonly statusCode = 409;

  constructor() { super("conversation_active_runs_prevent_delete"); }
}

function assignmentSelect(where: string): string {
  return `
    SELECT a.id, a.runtime_id, n.endpoint, a.dispatch_key, a.remote_run_id, a.status, a.reservation_expires_at, a.error_code, a.error_message,
      t.tenant_id, t.owner_user_id, t.conversation_id
    FROM mr_assignments a JOIN mr_runtime_nodes n ON n.id = a.runtime_id JOIN mr_tasks t ON t.id = a.task_id
    ${where}
  `;
}

function adminRunSelect(where: string): string {
  return `
    WITH latest_assignment AS (
      SELECT a.*, ROW_NUMBER() OVER (PARTITION BY a.task_id ORDER BY a.created_at DESC, a.id DESC) AS rn
      FROM mr_assignments a
    )
    SELECT
      t.id AS task_id, t.input AS task_input, t.status AS task_status, t.created_at AS task_created_at,
      t.updated_at AS task_updated_at, t.data_policy_json, t.plan_json, t.outcome_json,
      a.id AS assignment_id, a.remote_run_id, a.status AS assignment_status,
      a.error_code AS assignment_error_code, a.error_message AS assignment_error_message,
      n.id AS runtime_id, n.display_name AS runtime_name,
      tr.model_key AS turn_model_key, tr.assistant_output AS turn_output,
      tr.status AS turn_status, tr.error_code AS turn_error_code, tr.completed_at AS turn_completed_at
    FROM mr_tasks t
    LEFT JOIN latest_assignment a ON a.task_id = t.id AND a.rn = 1
    LEFT JOIN mr_runtime_nodes n ON n.id = a.runtime_id
    LEFT JOIN mr_turns tr ON tr.assignment_id = a.id
    ${where}
  `;
}

function toAdminRunSummary(row: AdminRunRow): RouterRunSummary {
  const status = adminRunStatus(row);
  const input = row.data_policy_json === '{"mode":"strict_local"}' || row.task_input.trim() === "" ? undefined : row.task_input;
  const modelKey = row.turn_model_key ?? undefined;
  const output = row.turn_output ?? undefined;
  const errorCode = row.turn_error_code ?? row.assignment_error_code ?? undefined;
  const errorMessage = row.assignment_error_message ?? undefined;
  return {
    id: row.remote_run_id ?? row.task_id,
    ...(input === undefined ? {} : { input }),
    status,
    createdAt: row.task_created_at,
    updatedAt: row.task_updated_at,
    ...(row.assignment_id === null ? {} : { assignmentId: row.assignment_id }),
    ...(row.remote_run_id === null ? {} : { remoteRunId: row.remote_run_id }),
    ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id }),
    ...(row.runtime_name === null ? {} : { runtimeName: row.runtime_name }),
    ...(modelKey === undefined ? {} : { modelKey }),
    ...(output === undefined ? {} : { output }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function adminRunStatus(row: AdminRunRow): RouterRunSummary["status"] {
  const value = row.turn_status ?? row.task_status ?? row.assignment_status;
  if (value === "completed" || value === "failed" || value === "cancelled" || value === "running" || value === "queued") return value;
  if (value === "accepted" || value === "reserved" || value === "dispatching") return "running";
  return "unknown";
}

function toStoredAssignment(row: AssignmentRow): StoredAssignment {
  if (row.remote_run_id === null && row.status !== "reserved" && row.status !== "failed" && row.status !== "expired") {
    throw new TypeError("non-admitted assignment has an invalid status");
  }
  return {
    id: row.id,
    runtimeId: row.runtime_id,
    dispatchKey: row.dispatch_key,
    remoteRunId: row.remote_run_id ?? "",
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    runtimeEndpoint: row.endpoint,
    ...(row.reservation_expires_at === null ? {} : { reservationExpiresAt: row.reservation_expires_at }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
  };
}

function isSafeDispatchFailure(value: DispatchFailure): boolean {
  return typeof value.code === "string" && value.code.length > 0 && value.code.length <= 128
    && typeof value.message === "string" && value.message.trim().length > 0 && value.message.length <= 1_024;
}

function score(node: { active_run_count: number; queued_run_count: number; pending_admissions: number; max_concurrent_runs: number }): number {
  return (node.active_run_count + Number(node.pending_admissions) + node.queued_run_count * 0.5) / node.max_concurrent_runs;
}

/** Task policies are immutable after admission, so they are safe provenance. */
function executionLocationFromDataPolicy(value: string): ExecutionLocation {
  try {
    const policy = JSON.parse(value) as { mode?: unknown };
    if (policy.mode === "local" || policy.mode === "strict_local" || policy.mode === "cloud") return policy.mode;
  } catch {
    // A malformed legacy policy must not be presented as local execution.
  }
  return "cloud";
}

function browserAttachments(value: string, fallbackResourceRefs: string): StoredConversationTurn["attachments"] {
  const snapshots = parseAttachmentSnapshots(value);
  return snapshots.length > 0 ? snapshots : browserAttachmentsFromResourceRefsJson(fallbackResourceRefs);
}

function browserAttachmentsFromResourceRefsJson(value: string): StoredConversationTurn["attachments"] {
  try {
    const refs = JSON.parse(value) as unknown;
    return browserAttachmentsFromResourceRefs(Array.isArray(refs) ? refs as readonly PortableResourceRef[] : []);
  } catch {
    return [];
  }
}

function browserAttachmentsFromResourceRefs(refs: readonly PortableResourceRef[]): StoredConversationTurn["attachments"] {
  return refs.flatMap((ref) => {
    if (ref === null || typeof ref !== "object") return [];
    const item = ref as Partial<PortableResourceRef>;
    if (typeof item.attachmentId !== "string" || typeof item.originalName !== "string") return [];
    return [{
      id: item.attachmentId,
      originalName: item.originalName,
      mediaType: typeof item.mediaType === "string" ? item.mediaType : "application/octet-stream",
      byteSize: typeof item.byteSize === "number" ? item.byteSize : 0,
    }];
  });
}

function parseAttachmentSnapshots(value: string): StoredConversationTurn["attachments"] {
  try {
    const snapshots = JSON.parse(value) as unknown;
    if (!Array.isArray(snapshots)) return [];
    return snapshots.flatMap((snapshot) => {
      if (snapshot === null || typeof snapshot !== "object") return [];
      const item = snapshot as Partial<ConversationAttachmentSnapshot>;
      if (typeof item.id !== "string" || typeof item.originalName !== "string") return [];
      return [{
        id: item.id,
        originalName: item.originalName,
        mediaType: typeof item.mediaType === "string" ? item.mediaType : "application/octet-stream",
        byteSize: typeof item.byteSize === "number" && Number.isSafeInteger(item.byteSize) && item.byteSize >= 0 ? item.byteSize : 0,
      }];
    });
  } catch {
    return [];
  }
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function integerValue(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
