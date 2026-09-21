import { createHash, randomUUID } from "node:crypto";
import type { SqlConnection } from "../storage/connection.ts";

export interface ToolResultRef {
  readonly schema: "agentloop.toolResultRef/v1";
  readonly resultId: string;
}

export interface ToolResultRecord {
  readonly ref: ToolResultRef;
  readonly actionId: string;
  readonly runId: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly resultSchema?: string;
  readonly content: string;
  readonly contentFormat: "json" | "text";
  readonly characters: number;
  readonly bytes: number;
  readonly createdAt: number;
}

interface ToolResultRow {
  id: string;
  action_id: string;
  run_id: string;
  plan_id: string | null;
  step_id: string | null;
  tool_call_id: string;
  tool_name: string;
  result_schema: string | null;
  content: string;
  content_format: "json" | "text";
  characters: number;
  bytes: number;
  created_at: number;
}

/** Runtime-owned canonical storage for successful Tool Action results. */
export class ToolResultRepository {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  async prepare(input: {
    readonly actionId: string;
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly value: unknown;
  }): Promise<ToolResultRef> {
    const serialized = serializeCanonicalToolResult(input.value);
    const id = `tr_${randomUUID()}`;
    const createdAt = Date.now();
    await this.database.prepare(`
      INSERT INTO tool_results(
        id, action_id, run_id, plan_id, step_id, tool_call_id, tool_name,
        result_schema, content, content_format, characters, bytes, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.actionId,
      input.runId,
      input.planId ?? null,
      input.stepId ?? null,
      input.toolCallId,
      input.toolName,
      resultSchema(input.value) ?? null,
      serialized.content,
      serialized.format,
      serialized.content.length,
      Buffer.byteLength(serialized.content),
      createHash("sha256").update(serialized.content).digest("hex"),
      createdAt,
    );
    return { schema: "agentloop.toolResultRef/v1", resultId: id };
  }

  async readAuthorized(input: {
    readonly resultId: string;
    readonly runId: string;
    readonly planId: string;
    readonly stepId: string;
  }): Promise<ToolResultRecord | undefined> {
    const row = await this.database.prepare(`
      SELECT results.*
      FROM tool_results AS results
      JOIN runtime_actions AS actions ON actions.id = results.action_id
      WHERE results.id = ?
        AND results.run_id = ?
        AND results.plan_id = ?
        AND results.step_id = ?
        AND actions.state = 'succeeded'
        AND actions.result_ref = results.id
    `).get(input.resultId, input.runId, input.planId, input.stepId) as ToolResultRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }
}

function serializeCanonicalToolResult(value: unknown): { content: string; format: "json" | "text" } {
  if (typeof value === "string") return { content: value, format: "text" };
  try {
    return { content: JSON.stringify(value) ?? "null", format: "json" };
  } catch {
    return { content: "Tool returned a value that could not be serialized", format: "text" };
  }
}

function resultSchema(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = (value as Record<string, unknown>).schema;
  return typeof schema === "string" && schema.length > 0 ? schema : undefined;
}

function toRecord(row: ToolResultRow): ToolResultRecord {
  return {
    ref: { schema: "agentloop.toolResultRef/v1", resultId: row.id },
    actionId: row.action_id,
    runId: row.run_id,
    ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    ...(row.result_schema === null ? {} : { resultSchema: row.result_schema }),
    content: row.content,
    contentFormat: row.content_format,
    characters: row.characters,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}
