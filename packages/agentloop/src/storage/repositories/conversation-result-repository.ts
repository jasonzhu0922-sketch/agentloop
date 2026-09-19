import { createHash } from "node:crypto";
import type { SqlConnection } from "../connection.ts";

export interface ConversationResultRecord {
  readonly runId: string;
  readonly planId?: string;
  readonly output: string;
  readonly sha256: string;
  readonly characters: number;
}

/**
 * Read-only access to completed semantic Outcomes. The query is deliberately
 * scoped by both owner and conversation: a result reference is useful input,
 * never a capability to browse arbitrary Runs.
 */
export class ConversationResultRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  async readCompleted(input: {
    readonly actorUserId: string;
    readonly conversationId: string;
    readonly runId: string;
    readonly sha256: string;
  }): Promise<ConversationResultRecord | undefined> {
    const row = await this.database.prepare(`
      SELECT outcomes.plan_id, outcomes.output
      FROM run_outcomes outcomes
      JOIN runs ON runs.id = outcomes.run_id
      WHERE outcomes.run_id = ?
        AND outcomes.status = 'completed'
        AND outcomes.output IS NOT NULL
        AND runs.owner_user_id = ?
        AND runs.conversation_id = ?
    `).get(input.runId, input.actorUserId, input.conversationId) as {
      plan_id: string | null;
      output: string;
    } | undefined;
    if (row === undefined) return undefined;
    const sha256 = createHash("sha256").update(row.output).digest("hex");
    if (sha256 !== input.sha256) return undefined;
    return {
      runId: input.runId,
      ...(row.plan_id === null ? {} : { planId: row.plan_id }),
      output: row.output,
      sha256,
      characters: row.output.length,
    };
  }
}
