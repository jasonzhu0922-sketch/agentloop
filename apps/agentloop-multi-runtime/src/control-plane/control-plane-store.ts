import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@zhujun/agentloop";
import type { PortableResourceRef, RuntimeAssignment, RuntimeInstance, RuntimeProfile, RuntimeRunStatus, SubmitConversationTask } from "../domain/contracts.ts";

export type AssignmentStatus = "reserved" | "accepted" | "completed" | "failed" | "cancelled" | "unknown" | "expired";

export interface RuntimeHeartbeat {
  readonly runtimeId: string;
  readonly status: "ready" | "draining" | "offline";
  readonly activeRunCount: number;
  readonly queuedRunCount: number;
  /** The limit enforced by this Host's local admission gate. */
  readonly maxConcurrentRuns?: number;
  readonly observedAt: number;
}

export interface StoredAssignment extends RuntimeAssignment {
  readonly status: AssignmentStatus;
  readonly reservationExpiresAt?: number;
  readonly runtimeEndpoint: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface StoredRuntimeEndpoint {
  readonly id: string;
  readonly endpoint: string;
}

export interface RuntimeCatalogEntry {
  readonly id: string;
  readonly profile: RuntimeProfile;
}

export interface StoredConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly runCount: number;
  readonly lastStatus: string;
}

export interface StoredConversationPage {
  readonly conversations: readonly StoredConversationSummary[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
}

export interface StoredConversationTurn {
  readonly clientMessageId: string;
  readonly input: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attachments: readonly {
    readonly id: string;
    readonly originalName: string;
    readonly mediaType: string;
    readonly byteSize: number;
  }[];
  readonly assignment?: {
    readonly id: string;
    readonly runtimeId: string;
    readonly status: AssignmentStatus;
    readonly hasRun: boolean;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  };
}

interface TaskRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  conversation_id: string;
  client_message_id: string;
  input: string;
  requested_runtime_id: string | null;
  requested_profile: string | null;
  required_capabilities_json: string;
  requested_model_key: string | null;
  allow_dangerous_tools: number;
  resource_refs_json: string;
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

/** Durable Router control-plane state. It owns neither AgentLoop Runs nor their Evidence. */
export class ControlPlaneStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  async ready(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS mr_runtime_nodes (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
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
        required_capabilities_json TEXT NOT NULL,
        requested_model_key TEXT,
        allow_dangerous_tools INTEGER NOT NULL,
        resource_refs_json TEXT NOT NULL,
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
    `);
    // PostgreSQL deployments always start from the canonical schema above.
    // PRAGMA is exclusively a SQLite legacy-schema inspection mechanism.
    if (this.database.dialect === "sqlite") {
      const taskColumns = await this.database.prepare("PRAGMA table_info(mr_tasks)").all() as Array<{ name: string }>;
      if (!taskColumns.some((column) => column.name === "requested_runtime_id")) {
        await this.database.exec("ALTER TABLE mr_tasks ADD COLUMN requested_runtime_id TEXT");
      }
      const assignmentColumns = await this.database.prepare("PRAGMA table_info(mr_assignments)").all() as Array<{ name: string }>;
      if (!assignmentColumns.some((column) => column.name === "error_code")) {
        await this.database.exec("ALTER TABLE mr_assignments ADD COLUMN error_code TEXT");
      }
      if (!assignmentColumns.some((column) => column.name === "error_message")) {
        await this.database.exec("ALTER TABLE mr_assignments ADD COLUMN error_message TEXT");
      }
    }
  }

  async seedRuntimes(runtimes: readonly (RuntimeInstance & { readonly endpoint: string })[], now = Date.now()): Promise<void> {
    await this.database.transaction(async () => {
      const statement = this.database.prepare(`
        INSERT INTO mr_runtime_nodes(id, endpoint, profile, capabilities_json, max_concurrent_runs, status, active_run_count, queued_run_count, updated_at)
        VALUES (?, ?, ?, ?, ?, 'offline', 0, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
          endpoint = excluded.endpoint,
          profile = excluded.profile,
          capabilities_json = excluded.capabilities_json,
          updated_at = excluded.updated_at
      `);
      for (const runtime of runtimes) {
        await statement.run(runtime.id, runtime.endpoint, runtime.profile, JSON.stringify(runtime.capabilities), runtime.maxConcurrentRuns, now);
      }
    });
  }

  async heartbeat(heartbeat: RuntimeHeartbeat): Promise<void> {
    if (!Number.isSafeInteger(heartbeat.activeRunCount) || heartbeat.activeRunCount < 0) throw new TypeError("activeRunCount must be a non-negative integer");
    if (!Number.isSafeInteger(heartbeat.queuedRunCount) || heartbeat.queuedRunCount < 0) throw new TypeError("queuedRunCount must be a non-negative integer");
    if (heartbeat.maxConcurrentRuns !== undefined && (!Number.isSafeInteger(heartbeat.maxConcurrentRuns) || heartbeat.maxConcurrentRuns < 1)) {
      throw new TypeError("maxConcurrentRuns must be a positive integer");
    }
    const result = await this.database.prepare(`
      UPDATE mr_runtime_nodes
      SET status = ?, active_run_count = ?, queued_run_count = ?,
        max_concurrent_runs = COALESCE(?, max_concurrent_runs),
        last_heartbeat_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      heartbeat.status,
      heartbeat.activeRunCount,
      heartbeat.queuedRunCount,
      heartbeat.maxConcurrentRuns ?? null,
      heartbeat.observedAt,
      heartbeat.observedAt,
      heartbeat.runtimeId,
    );
    if (result.changes === 0) throw new TypeError("runtime is not statically registered");
  }

  async runtimeEndpoints(): Promise<readonly StoredRuntimeEndpoint[]> {
    return await this.database.prepare("SELECT id, endpoint FROM mr_runtime_nodes ORDER BY id").all() as StoredRuntimeEndpoint[];
  }

  /** Static Hosts registered with this Router; availability remains heartbeat-driven. */
  async runtimeCatalog(): Promise<readonly RuntimeCatalogEntry[]> {
    return await this.database.prepare("SELECT id, profile FROM mr_runtime_nodes ORDER BY id").all() as RuntimeCatalogEntry[];
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
        t.created_at,
        t.updated_at,
        a.id AS assignment_id,
        a.runtime_id,
        a.remote_run_id,
        a.status AS assignment_status,
        a.error_code,
        a.error_message
      FROM mr_tasks t
      LEFT JOIN mr_assignments a ON a.id = (
        SELECT latest_assignment.id
        FROM mr_assignments latest_assignment
        WHERE latest_assignment.task_id = t.id
        ORDER BY latest_assignment.created_at DESC, latest_assignment.id DESC
        LIMIT 1
      )
      WHERE t.tenant_id = ? AND t.owner_user_id = ? AND t.conversation_id = ?
      ORDER BY t.created_at ASC, t.id ASC
    `).all(tenantId, ownerUserId, conversationId) as Array<{
      client_message_id: string;
      input: string;
      resource_refs_json: string;
      created_at: number;
      updated_at: number;
      assignment_id: string | null;
      runtime_id: string | null;
      remote_run_id: string | null;
      assignment_status: AssignmentStatus | null;
      error_code: string | null;
      error_message: string | null;
    }>;
    if (rows.length === 0) return undefined;
    return {
      turns: rows.map((row) => ({
        clientMessageId: row.client_message_id,
        input: row.input,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        attachments: browserAttachments(row.resource_refs_json),
        ...(row.assignment_id === null || row.runtime_id === null || row.assignment_status === null ? {} : {
          assignment: {
            id: row.assignment_id,
            runtimeId: row.runtime_id,
            status: row.assignment_status,
            hasRun: row.remote_run_id !== null,
            ...(row.error_code === null ? {} : { errorCode: row.error_code }),
            ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
          },
        }),
      })),
    };
  }

  async reserve(task: SubmitConversationTask, input: { readonly heartbeatTtlMs: number; readonly reservationTtlMs: number; readonly now?: number }): Promise<StoredAssignment> {
    const now = input.now ?? Date.now();
    return await this.database.transaction(async () => {
      await this.expireReservations(now);
      const existing = await this.findTask(task);
      if (existing !== undefined) {
        const current = await this.latestAssignment(existing.id);
        if (current !== undefined && current.status !== "expired" && current.status !== "failed") return toStoredAssignment(current);
        return await this.reserveForTask(existing, now, input.heartbeatTtlMs, input.reservationTtlMs);
      }
      const created: TaskRow = {
        id: `task_${randomUUID()}`,
        tenant_id: task.tenantId,
        owner_user_id: task.ownerUserId,
        conversation_id: task.conversationId,
        client_message_id: task.clientMessageId,
        input: task.input,
        requested_runtime_id: task.requestedRuntimeId ?? null,
        requested_profile: task.requestedProfile ?? null,
        required_capabilities_json: JSON.stringify(task.requiredCapabilities ?? []),
        requested_model_key: task.requestedModelKey ?? null,
        allow_dangerous_tools: task.allowDangerousTools !== false ? 1 : 0,
        resource_refs_json: JSON.stringify(task.resourceRefs ?? []),
        status: "dispatching",
      };
      await this.database.prepare(`
        INSERT INTO mr_tasks(id, tenant_id, owner_user_id, conversation_id, client_message_id, input, requested_runtime_id, requested_profile, required_capabilities_json, requested_model_key, allow_dangerous_tools, resource_refs_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        created.id, created.tenant_id, created.owner_user_id, created.conversation_id, created.client_message_id,
        created.input, created.requested_runtime_id, created.requested_profile, created.required_capabilities_json, created.requested_model_key,
        created.allow_dangerous_tools, created.resource_refs_json, created.status, now, now,
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

  async markDispatchFailure(assignmentId: string, now = Date.now()): Promise<void> {
    await this.database.transaction(async () => {
      await this.database.prepare(`UPDATE mr_assignments SET status = 'failed', reservation_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'reserved'`)
        .run(now, assignmentId);
      await this.database.prepare(`UPDATE mr_tasks SET status = 'queued', updated_at = ? WHERE id = (SELECT task_id FROM mr_assignments WHERE id = ?)`)
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
        await this.database.prepare(`UPDATE mr_tasks SET status = ?, updated_at = CASE
          WHEN ? IS NULL THEN updated_at
          WHEN ? < created_at THEN created_at ELSE ? END
          WHERE id = (SELECT task_id FROM mr_assignments WHERE id = ?)
            AND ? = (SELECT latest.id FROM mr_assignments latest WHERE latest.task_id = mr_tasks.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)`)
          .run(status, finishedAt, finishedAt, finishedAt, assignmentId, assignmentId);
      }
    });
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
    if (task.requested_runtime_id !== null) {
      const configured = await this.database.prepare("SELECT id FROM mr_runtime_nodes WHERE id = ?").get(task.requested_runtime_id) as { id: string } | undefined;
      if (configured === undefined) throw new TypeError(`Runtime \"${task.requested_runtime_id}\" is not registered`);
    }
    const candidates = await this.database.prepare(`
      SELECT n.id, n.endpoint, n.profile, n.capabilities_json, n.max_concurrent_runs, n.active_run_count, n.queued_run_count,
        COALESCE(SUM(CASE
          WHEN a.status = 'reserved' THEN 1
          -- A Host heartbeat is authoritative for already accepted Runs. Keep
          -- only admissions accepted after that snapshot as a local safety
          -- reservation until the Host reports them in active_run_count.
          WHEN a.status = 'accepted' AND a.updated_at > n.last_heartbeat_at THEN 1
          ELSE 0
        END), 0) AS pending_admissions
      FROM mr_runtime_nodes n
      LEFT JOIN mr_assignments a ON a.runtime_id = n.id AND a.status IN ('reserved', 'accepted')
      WHERE n.status = 'ready' AND n.last_heartbeat_at IS NOT NULL AND n.last_heartbeat_at >= ?
      GROUP BY n.id
    `).all(now - heartbeatTtlMs) as Array<{
      id: string; endpoint: string; profile: RuntimeProfile; capabilities_json: string; max_concurrent_runs: number;
      active_run_count: number; queued_run_count: number; pending_admissions: number;
    }>;
    const required = JSON.parse(task.required_capabilities_json) as string[];
    const affinity = await this.database.prepare(`
      SELECT a.runtime_id AS runtimeId
      FROM mr_assignments a JOIN mr_tasks t ON t.id = a.task_id
      WHERE t.tenant_id = ? AND t.owner_user_id = ? AND t.conversation_id = ?
        -- A reservation prevents capacity oversubscription while dispatch is
        -- in flight, but it has not started a Run and must not make the
        -- conversation sticky to that Host.  Affinity begins only after the
        -- Host has accepted the dispatch and supplied a remote Run id.
        AND a.remote_run_id IS NOT NULL
      ORDER BY a.created_at DESC LIMIT 1
    `).get(task.tenant_id, task.owner_user_id, task.conversation_id) as { runtimeId: string } | undefined;
    const eligible = candidates
      .filter((node) => (task.requested_runtime_id === null || node.id === task.requested_runtime_id)
        && (task.requested_profile === null || node.profile === task.requested_profile)
        && required.every((capability) => (JSON.parse(node.capabilities_json) as string[]).includes(capability)))
      .filter((node) => node.active_run_count + Number(node.pending_admissions) < node.max_concurrent_runs)
      .sort((left, right) => {
        if (affinity !== undefined && left.id === affinity.runtimeId) return -1;
        if (affinity !== undefined && right.id === affinity.runtimeId) return 1;
        return score(left) - score(right) || left.id.localeCompare(right.id);
      });
    // Affinity is deliberately a preference, never an availability gate.  The
    // old Host can be draining, full, or absent; in each case a new Run may
    // use another compatible healthy Host.  A running Run itself is not moved
    // here -- that requires the separate run-lease/fencing recovery protocol.
    const selected = eligible[0];
    if (selected === undefined && task.requested_runtime_id !== null) {
      throw new RuntimeCapacityError(`Runtime \"${task.requested_runtime_id}\" is not ready or has no reservable capacity slot`);
    }
    if (selected === undefined) throw new RuntimeCapacityError("No healthy Runtime has a reservable capacity slot");
    const id = `assignment_${randomUUID()}`;
    const dispatchKey = `dispatch_${randomUUID()}`;
    const expires = now + reservationTtlMs;
    await this.database.prepare(`
      INSERT INTO mr_assignments(id, task_id, runtime_id, dispatch_key, status, reservation_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)
    `).run(id, task.id, selected.id, dispatchKey, expires, now, now);
    if (affinity !== undefined && affinity.runtimeId !== selected.id) {
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
        affinity.runtimeId,
        selected.id,
        now,
      );
    }
    const row = await this.database.prepare(assignmentSelect("WHERE a.id = ?")).get(id) as AssignmentRow;
    return toStoredAssignment(row);
  }

  private async expireReservations(now: number): Promise<void> {
    await this.database.prepare(`UPDATE mr_assignments SET status = 'expired', updated_at = ? WHERE status = 'reserved' AND reservation_expires_at < ?`)
      .run(now, now);
    await this.database.prepare(`UPDATE mr_tasks SET status = 'queued', updated_at = ? WHERE status = 'dispatching' AND id IN (SELECT task_id FROM mr_assignments WHERE status = 'expired')`)
      .run(now);
  }

  private async findTask(task: SubmitConversationTask): Promise<TaskRow | undefined> {
    return await this.database.prepare(`
      SELECT id, tenant_id, owner_user_id, conversation_id, client_message_id, input, requested_runtime_id, requested_profile, required_capabilities_json, requested_model_key, allow_dangerous_tools, resource_refs_json, status
      FROM mr_tasks WHERE tenant_id = ? AND owner_user_id = ? AND conversation_id = ? AND client_message_id = ?
    `).get(task.tenantId, task.ownerUserId, task.conversationId, task.clientMessageId) as TaskRow | undefined;
  }

  private async latestAssignment(taskId: string): Promise<AssignmentRow | undefined> {
    return await this.database.prepare(assignmentSelect("WHERE a.task_id = ? ORDER BY a.created_at DESC LIMIT 1")).get(taskId) as AssignmentRow | undefined;
  }
}

export class RuntimeCapacityError extends Error {}

function assignmentSelect(where: string): string {
  return `
    SELECT a.id, a.runtime_id, n.endpoint, a.dispatch_key, a.remote_run_id, a.status, a.reservation_expires_at, a.error_code, a.error_message,
      t.tenant_id, t.owner_user_id, t.conversation_id
    FROM mr_assignments a JOIN mr_runtime_nodes n ON n.id = a.runtime_id JOIN mr_tasks t ON t.id = a.task_id
    ${where}
  `;
}

function toStoredAssignment(row: AssignmentRow): StoredAssignment {
  if (row.remote_run_id === null && row.status !== "reserved") throw new TypeError("non-reserved assignment is missing remoteRunId");
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

function score(node: { active_run_count: number; queued_run_count: number; pending_admissions: number; max_concurrent_runs: number }): number {
  return (node.active_run_count + Number(node.pending_admissions) + node.queued_run_count * 0.5) / node.max_concurrent_runs;
}

function browserAttachments(value: string): StoredConversationTurn["attachments"] {
  try {
    const refs = JSON.parse(value) as unknown;
    if (!Array.isArray(refs)) return [];
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
  } catch {
    return [];
  }
}
