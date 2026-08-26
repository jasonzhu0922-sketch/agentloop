import type { SqlConnection } from "../connection.ts";
import { AppError, notFound } from "../../shared/errors.ts";
import type { UploadedSourceStatus, UploadedSourceSummary } from "../../runtime/contracts.ts";

export interface SourceRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly conversation_id: string | null;
  readonly original_name: string;
  readonly mime_type: string;
  readonly extension: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly storage_path: string;
  readonly status: UploadedSourceStatus;
  readonly summary: string | null;
  readonly token_estimate: number;
  readonly character_count: number;
  readonly truncated: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SourceChunkRow {
  readonly source_id: string;
  readonly chunk_index: number;
  readonly kind: "text" | "table" | "metadata";
  readonly locator: string;
  readonly content: string;
  readonly token_estimate: number;
  readonly sha256: string;
  readonly created_at: number;
}

const SOURCE_COLUMNS = `
  id, owner_user_id, conversation_id, original_name, mime_type, extension,
  byte_size, sha256, storage_path, status, summary, token_estimate,
  character_count, truncated, error_code, error_message, created_at, updated_at
`;

export class SourceRepository {
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    this.connection = connection;
  }

  insertSource(input: {
    id: string;
    ownerUserId: string;
    conversationId?: string;
    originalName: string;
    mimeType: string;
    extension: string;
    byteSize: number;
    sha256: string;
    storagePath: string;
    status: UploadedSourceStatus;
    summary?: string;
    tokenEstimate: number;
    characterCount: number;
    truncated: boolean;
    errorCode?: string;
    errorMessage?: string;
    createdAt: number;
  }): SourceRow {
    this.connection.prepare(`
      INSERT INTO sources(
        id, owner_user_id, conversation_id, original_name, mime_type, extension,
        byte_size, sha256, storage_path, status, summary, token_estimate,
        character_count, truncated, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.ownerUserId,
      input.conversationId ?? null,
      input.originalName,
      input.mimeType,
      input.extension,
      input.byteSize,
      input.sha256,
      input.storagePath,
      input.status,
      input.summary ?? null,
      input.tokenEstimate,
      input.characterCount,
      input.truncated ? 1 : 0,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.createdAt,
      input.createdAt,
    );
    return this.requireByOwner(input.ownerUserId, input.id);
  }

  replaceChunks(sourceId: string, chunks: readonly Omit<SourceChunkRow, "source_id" | "created_at">[], now: number): void {
    this.connection.transaction(() => {
      this.connection.prepare("DELETE FROM source_chunks WHERE source_id = ?").run(sourceId);
      const insert = this.connection.prepare(`
        INSERT INTO source_chunks(source_id, chunk_index, kind, locator, content, token_estimate, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of chunks) {
        insert.run(sourceId, chunk.chunk_index, chunk.kind, chunk.locator, chunk.content, chunk.token_estimate, chunk.sha256, now);
      }
    });
  }

  requireByOwner(ownerUserId: string, sourceId: string): SourceRow {
    const source = this.connection.prepare(`
      SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = ? AND owner_user_id = ?
    `).get(sourceId, ownerUserId) as SourceRow | undefined;
    if (source === undefined) throw notFound("Source");
    return source;
  }

  listForConversation(ownerUserId: string, conversationId: string): SourceRow[] {
    return this.connection.prepare(`
      SELECT ${SOURCE_COLUMNS}
      FROM sources
      WHERE owner_user_id = ? AND conversation_id = ? AND status != 'deleted'
      ORDER BY created_at ASC
    `).all(ownerUserId, conversationId) as unknown as SourceRow[];
  }

  listByRun(runId: string): SourceRow[] {
    return this.connection.prepare(`
      SELECT ${SOURCE_COLUMNS}
      FROM sources s
      JOIN run_sources rs ON rs.source_id = s.id
      WHERE rs.run_id = ?
      ORDER BY rs.position ASC
    `).all(runId) as unknown as SourceRow[];
  }

  bindRunSources(input: {
    ownerUserId: string;
    conversationId: string;
    runId: string;
    sourceIds: readonly string[];
    createdAt: number;
  }): SourceRow[] {
    if (input.sourceIds.length === 0) return [];
    const rows = input.sourceIds.map((sourceId) => this.requireByOwner(input.ownerUserId, sourceId));
    for (const row of rows) {
      if (row.status !== "ready") {
        throw new AppError("BAD_REQUEST", `Source ${row.id} is not ready: ${row.status}`, 400, {
          sourceId: row.id,
          status: row.status,
        });
      }
      if (row.conversation_id !== null && row.conversation_id !== input.conversationId) {
        throw new AppError("FORBIDDEN", "Source belongs to another conversation", 403, { sourceId: row.id });
      }
    }
    const update = this.connection.prepare(`
      UPDATE sources SET conversation_id = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND (conversation_id IS NULL OR conversation_id = ?)
    `);
    const insert = this.connection.prepare(`
      INSERT INTO run_sources(run_id, source_id, position, role, created_at)
      VALUES (?, ?, ?, 'user_supplied', ?)
    `);
    rows.forEach((row, index) => {
      const updated = update.run(input.conversationId, input.createdAt, row.id, input.ownerUserId, input.conversationId);
      if (updated.changes === 0) throw new AppError("FORBIDDEN", "Source cannot be claimed for this conversation", 403);
      insert.run(input.runId, row.id, index, input.createdAt);
    });
    return rows.map((row) => ({ ...row, conversation_id: input.conversationId }));
  }

  chunks(sourceId: string): SourceChunkRow[] {
    return this.connection.prepare(`
      SELECT source_id, chunk_index, kind, locator, content, token_estimate, sha256, created_at
      FROM source_chunks WHERE source_id = ? ORDER BY chunk_index ASC
    `).all(sourceId) as unknown as SourceChunkRow[];
  }
}

export function sourceSummary(row: SourceRow): UploadedSourceSummary {
  const chunkCount = Number(row.status === "ready"
    ? (row as SourceRow & { chunk_count?: number }).chunk_count ?? 0
    : 0);
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    extension: row.extension,
    byteSize: row.byte_size,
    sha256: row.sha256,
    status: row.status,
    ...(row.summary === null ? {} : { summary: row.summary }),
    chunkCount,
    truncated: row.truncated === 1,
  };
}
