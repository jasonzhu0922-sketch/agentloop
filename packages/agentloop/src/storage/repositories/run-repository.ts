import type { SqlConnection } from "../connection.ts";
import { AppError, notFound } from "../../shared/errors.ts";

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunRow {
  id: string;
  owner_user_id: string;
  conversation_id: string | null;
  parent_run_id: string | null;
  depth: number;
  allow_dangerous_tools: number;
  model_key: string | null;
  status: RunStatus;
  input: string;
  output: string | null;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface RunEventRow {
  seq: number;
  type: string;
  payload_json: string;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  title: string;
  visible_directories_json: string;
  created_at: number;
  updated_at: number;
}

export interface ConversationSummaryRow extends ConversationRow {
  run_count: number;
}

const RUN_COLUMNS = `
  id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools,
  model_key, status, input, output, error_code, created_at, finished_at
`;

export class RunRepository {
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    this.connection = connection;
  }

  async get(runId: string): Promise<RunRow | undefined> {
    return await this.connection.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM runs WHERE id = ?
    `).get(runId) as RunRow | undefined;
  }

  async getByOwner(runId: string, ownerUserId: string): Promise<RunRow | undefined> {
    return await this.connection.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM runs WHERE id = ? AND owner_user_id = ?
    `).get(runId, ownerUserId) as RunRow | undefined;
  }

  async listByOwner(ownerUserId: string, limit: number): Promise<RunRow[]> {
    return await this.connection.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM runs WHERE owner_user_id = ? AND parent_run_id IS NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(ownerUserId, limit) as unknown as RunRow[];
  }

  async insertRun(input: {
    id: string;
    ownerUserId: string;
    conversationId?: string;
    allowDangerousTools: boolean;
    modelKey?: string;
    input: string;
    createdAt: number;
  }): Promise<void> {
    await this.connection.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools,
        model_key, status, input, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      input.id,
      input.ownerUserId,
      input.conversationId ?? null,
      null,
      0,
      input.allowDangerousTools ? 1 : 0,
      input.modelKey ?? null,
      input.input,
      input.createdAt,
    );
  }

  async listConversationSummaries(
    ownerUserId: string,
    page?: { readonly limit: number; readonly offset: number },
  ): Promise<ConversationSummaryRow[]> {
    return await this.connection.prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at,
             c.visible_directories_json,
             (SELECT COUNT(*) FROM runs r WHERE r.conversation_id = c.id AND r.parent_run_id IS NULL) AS run_count
      FROM conversations c
      WHERE c.owner_user_id = ?
      ORDER BY c.updated_at DESC
      ${page === undefined ? "" : "LIMIT ? OFFSET ?"}
    `).all(
      ownerUserId,
      ...(page === undefined ? [] : [page.limit, page.offset]),
    ) as unknown as ConversationSummaryRow[];
  }

  async lastTopLevelStatus(conversationId: string): Promise<{ status: RunStatus } | undefined> {
    return await this.connection.prepare(`
      SELECT status FROM runs WHERE conversation_id = ? AND parent_run_id IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(conversationId) as { status: RunStatus } | undefined;
  }

  async findConversation(ownerUserId: string, conversationId: string): Promise<ConversationRow | undefined> {
    return await this.connection.prepare(`
      SELECT id, title, visible_directories_json, created_at, updated_at
      FROM conversations WHERE id = ? AND owner_user_id = ?
    `).get(conversationId, ownerUserId) as ConversationRow | undefined;
  }

  async topLevelRunsInConversation(conversationId: string): Promise<RunRow[]> {
    return await this.connection.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM runs WHERE conversation_id = ? AND parent_run_id IS NULL
      ORDER BY created_at ASC
    `).all(conversationId) as unknown as RunRow[];
  }

  async touchConversation(conversationId: string, now: number): Promise<void> {
    await this.connection.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
  }

  async setConversationVisibleDirectories(
    ownerUserId: string,
    conversationId: string,
    visibleDirectories: readonly string[],
    now: number,
  ): Promise<ConversationRow> {
    const updated = await this.connection.prepare(`
      UPDATE conversations
      SET visible_directories_json = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ?
    `).run(JSON.stringify([...visibleDirectories]), now, conversationId, ownerUserId);
    if (updated.changes === 0) throw notFound("Conversation");
    return await this.findConversation(ownerUserId, conversationId) as ConversationRow;
  }

  async insertConversation(input: { id: string; ownerUserId: string; title: string; createdAt: number }): Promise<void> {
    await this.connection.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.id, input.ownerUserId, input.title, input.createdAt, input.createdAt);
  }

  async deleteConversation(ownerUserId: string, conversationId: string): Promise<void> {
    await this.connection.transaction(async () => {
      const conversation = await this.connection.prepare(`
        SELECT id FROM conversations WHERE id = ? AND owner_user_id = ?
      `).get(conversationId, ownerUserId) as { id: string } | undefined;
      if (conversation === undefined) throw notFound("Conversation");

      const active = await this.connection.prepare(`
        WITH RECURSIVE run_tree(id, status) AS (
          SELECT id, status FROM runs WHERE conversation_id = ? AND owner_user_id = ?
          UNION ALL
          SELECT child.id, child.status
          FROM runs child JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.owner_user_id = ?
        )
        SELECT id FROM run_tree
        WHERE status = 'running'
          AND (
            EXISTS (
              SELECT 1 FROM runtime_actions action
              WHERE action.run_id = run_tree.id AND action.state = 'dispatched'
            )
            OR NOT EXISTS (
              SELECT 1
              FROM run_recovery_states state
              JOIN runtime_actions action ON action.id = state.action_id
              WHERE state.run_id = run_tree.id AND action.state = 'recovery_required'
            )
          )
        LIMIT 1
      `).get(conversationId, ownerUserId, ownerUserId) as { id: string } | undefined;
      if (active !== undefined) {
        throw new AppError("CONFLICT", "Cannot delete a conversation while one of its runs is active", 409);
      }

      await this.connection.prepare(`
        WITH RECURSIVE run_tree(id) AS (
          SELECT id FROM runs WHERE conversation_id = ? AND owner_user_id = ?
          UNION ALL
          SELECT child.id FROM runs child JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.owner_user_id = ?
        )
        DELETE FROM run_recovery_states WHERE run_id IN (SELECT id FROM run_tree)
      `).run(conversationId, ownerUserId, ownerUserId);
      await this.connection.prepare(`
        WITH RECURSIVE run_tree(id) AS (
          SELECT id FROM runs WHERE conversation_id = ? AND owner_user_id = ?
          UNION ALL
          SELECT child.id FROM runs child JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.owner_user_id = ?
        )
        DELETE FROM runs WHERE id IN (SELECT id FROM run_tree)
      `).run(conversationId, ownerUserId, ownerUserId);
      await this.connection.prepare("DELETE FROM conversations WHERE id = ? AND owner_user_id = ?")
        .run(conversationId, ownerUserId);
    });
  }

  async conversationTranscript(conversationId: string): Promise<Array<{ input: string; output: string | null }>> {
    return await this.connection.prepare(`
      SELECT input, output FROM runs
      WHERE conversation_id = ? AND parent_run_id IS NULL
      ORDER BY created_at ASC
    `).all(conversationId) as unknown as Array<{ input: string; output: string | null }>;
  }

  async eventsByRun(runId: string): Promise<RunEventRow[]> {
    return await this.connection.prepare(`
      SELECT seq, type, payload_json, created_at
      FROM run_events WHERE run_id = ? ORDER BY seq
    `).all(runId) as unknown as RunEventRow[];
  }

  async appendEvent(
    runId: string,
    input: { type: string; data: Readonly<Record<string, unknown>>; createdAt: number },
  ): Promise<number> {
    return await this.connection.transaction(async () => {
      const sequence = await this.connection.prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
      ).get(runId) as { seq: number };
      await this.connection.prepare(`
        INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, sequence.seq, input.type, JSON.stringify(input.data), input.createdAt);
      return sequence.seq;
    });
  }
}
