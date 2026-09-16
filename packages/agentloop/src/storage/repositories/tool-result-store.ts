import { createHash, randomUUID } from "node:crypto";
import { AppError, notFound } from "../../shared/errors.ts";
import type { SqlConnection } from "../connection.ts";

export interface ToolResultRef {
  readonly locator: string;
  readonly sha256: string;
  readonly characters: number;
}

export interface ToolResultWindow extends ToolResultRef {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly offset: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset?: number;
}

export interface StoredToolResult extends ToolResultRef {
  readonly ownerUserId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly createdAt: number;
}

export interface ToolResultStore {
  put(input: {
    readonly ownerUserId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly content: string;
    readonly createdAt: number;
  }): Promise<ToolResultRef>;
  /** Reconcile a blob written before the SQL Action/outcome commit completed. */
  findByToolCall(input: {
    readonly ownerUserId: string;
    readonly runId: string;
    readonly toolCallId: string;
  }): Promise<StoredToolResult | undefined>;
  read(input: {
    readonly ownerUserId: string;
    readonly runId: string;
    readonly locator: string;
    readonly offset: number;
    readonly limit: number;
    readonly expectedSha256?: string;
  }): Promise<ToolResultWindow>;
}

interface ToolResultRow {
  locator: string;
  owner_user_id: string;
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  content: string;
  sha256: string;
  characters: number | string | bigint;
  created_at: number | string | bigint;
}

const LOCATOR_PREFIX = "tool-result://";
const MAX_READ_CHARACTERS = 50_000;
const MAX_LOCATOR_CHARACTERS = 512;

/** Provider-neutral opaque locator grammar shared by stores, projections and recovery. */
export function isToolResultLocator(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 2
    && value.length <= MAX_LOCATOR_CHARACTERS
    && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u.test(value);
}

/** Portable SQL-backed store used until a host provides an object-store adapter. */
export class SqlToolResultStore implements ToolResultStore {
  private readonly database: SqlConnection;

  constructor(database: SqlConnection) {
    this.database = database;
  }

  async put(input: {
    readonly ownerUserId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly content: string;
    readonly createdAt: number;
  }): Promise<ToolResultRef> {
    const sha256 = digest(input.content);
    return await this.database.transaction(async () => {
      const ownedRun = await this.database.prepare(`
        SELECT id FROM runs WHERE id = ? AND owner_user_id = ?
      `).get(input.runId, input.ownerUserId) as { id: string } | undefined;
      if (ownedRun === undefined) throw notFound("Run");
      const existing = await this.byToolCall(input.runId, input.toolCallId);
      if (existing !== undefined) {
        if (
          existing.owner_user_id !== input.ownerUserId
          || existing.tool_name !== input.toolName
          || existing.sha256 !== sha256
          || existing.content !== input.content
        ) {
          throw new AppError(
            "CONFLICT",
            "Tool result already exists with different content",
            409,
            { runId: input.runId, toolCallId: input.toolCallId },
          );
        }
        return refFromRow(normalizeRow(existing));
      }
      const locator = `${LOCATOR_PREFIX}${randomUUID()}`;
      await this.database.prepare(`
        INSERT INTO tool_result_blobs(
          locator, owner_user_id, run_id, tool_call_id, tool_name,
          content, sha256, characters, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        locator,
        input.ownerUserId,
        input.runId,
        input.toolCallId,
        input.toolName,
        input.content,
        sha256,
        input.content.length,
        input.createdAt,
      );
      return { locator, sha256, characters: input.content.length };
    });
  }

  async read(input: {
    readonly ownerUserId: string;
    readonly runId: string;
    readonly locator: string;
    readonly offset: number;
    readonly limit: number;
    readonly expectedSha256?: string;
  }): Promise<ToolResultWindow> {
    if (!input.locator.startsWith(LOCATOR_PREFIX)) throw notFound("Tool result");
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new AppError("BAD_REQUEST", "Tool result offset must be a non-negative integer", 400);
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_READ_CHARACTERS) {
      throw new AppError(
        "BAD_REQUEST",
        `Tool result limit must be between 1 and ${MAX_READ_CHARACTERS}`,
        400,
      );
    }
    const row = await this.database.prepare(`
      SELECT locator, owner_user_id, run_id, tool_call_id, tool_name,
             content, sha256, characters, created_at
      FROM tool_result_blobs
      WHERE locator = ? AND owner_user_id = ? AND run_id = ?
    `).get(input.locator, input.ownerUserId, input.runId) as ToolResultRow | undefined;
    if (row === undefined) throw notFound("Tool result");
    const normalized = normalizeRow(row);
    if (digest(normalized.content) !== normalized.sha256 || normalized.content.length !== normalized.characters) {
      throw new AppError("INTERNAL_ERROR", "Stored Tool result failed its integrity check", 500, {
        locator: normalized.locator,
        toolCallId: normalized.tool_call_id,
      });
    }
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== normalized.sha256) {
      throw new AppError("CONFLICT", "Tool result hash does not match the requested content", 409, {
        locator: normalized.locator,
        expectedSha256: input.expectedSha256,
        actualSha256: normalized.sha256,
      });
    }
    const content = normalized.content.slice(input.offset, input.offset + input.limit);
    const nextOffset = input.offset + content.length;
    return {
      ...refFromRow(normalized),
      toolCallId: normalized.tool_call_id,
      toolName: normalized.tool_name,
      offset: input.offset,
      content,
      truncated: input.offset > 0 || nextOffset < normalized.characters,
      ...(nextOffset < normalized.characters ? { nextOffset } : {}),
    };
  }

  async findByToolCall(input: {
    readonly ownerUserId: string;
    readonly runId: string;
    readonly toolCallId: string;
  }): Promise<StoredToolResult | undefined> {
    const row = await this.byToolCall(input.runId, input.toolCallId);
    if (row === undefined || row.owner_user_id !== input.ownerUserId) return undefined;
    const normalized = normalizeRow(row);
    if (digest(normalized.content) !== normalized.sha256 || normalized.content.length !== normalized.characters) {
      throw new AppError("INTERNAL_ERROR", "Stored Tool result failed its integrity check", 500);
    }
    return {
      ...refFromRow(normalized),
      ownerUserId: normalized.owner_user_id,
      runId: normalized.run_id,
      toolCallId: normalized.tool_call_id,
      toolName: normalized.tool_name,
      content: normalized.content,
      createdAt: normalized.created_at,
    };
  }

  private async byToolCall(runId: string, toolCallId: string): Promise<ToolResultRow | undefined> {
    return await this.database.prepare(`
      SELECT locator, owner_user_id, run_id, tool_call_id, tool_name,
             content, sha256, characters, created_at
      FROM tool_result_blobs WHERE run_id = ? AND tool_call_id = ?
    `).get(runId, toolCallId) as ToolResultRow | undefined;
  }
}

function refFromRow(row: ToolResultRow & { characters: number }): ToolResultRef {
  return { locator: row.locator, sha256: row.sha256, characters: row.characters };
}

function normalizeRow(row: ToolResultRow): ToolResultRow & { characters: number; created_at: number } {
  return {
    ...row,
    characters: safeWideInteger(row.characters, "Tool result character count"),
    created_at: safeWideInteger(row.created_at, "Tool result creation time"),
  };
}

function safeWideInteger(value: number | string | bigint, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError("INTERNAL_ERROR", `${label} is outside the supported range`, 500);
  }
  return parsed;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
