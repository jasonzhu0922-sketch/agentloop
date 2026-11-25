import { ascending, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../runtime-records.ts";
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

export class SourceRepository {
  private readonly connection: RuntimePersistence;

  constructor(connection: RuntimePersistenceInput) {
    this.connection = runtimePersistence(connection);
  }

  async insertSource(input: {
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
  }): Promise<SourceRow> {
    await this.connection.records.insert("sources", { id: input.id, owner_user_id: input.ownerUserId, conversation_id: input.conversationId ?? null,
      original_name: input.originalName, mime_type: input.mimeType, extension: input.extension, byte_size: input.byteSize, sha256: input.sha256,
      storage_path: input.storagePath, status: input.status, summary: input.summary ?? null, token_estimate: input.tokenEstimate,
      character_count: input.characterCount, truncated: input.truncated ? 1 : 0, error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null, created_at: input.createdAt, updated_at: input.createdAt });
    return await this.requireByOwner(input.ownerUserId, input.id);
  }

  async replaceChunks(sourceId: string, chunks: readonly Omit<SourceChunkRow, "source_id" | "created_at">[], now: number): Promise<void> {
    await this.connection.transaction(async () => {
      await this.connection.records.remove("source_chunks", { source_id: sourceId });
      for (const chunk of chunks) await this.connection.records.insert("source_chunks", { ...chunk, source_id: sourceId, created_at: now });
    });
  }

  async requireByOwner(ownerUserId: string, sourceId: string): Promise<SourceRow> {
    const source = (await this.connection.records.find("sources", { id: sourceId, owner_user_id: ownerUserId }))[0];
    if (source === undefined) throw notFound("Source");
    return source;
  }

  async listForConversation(ownerUserId: string, conversationId: string): Promise<SourceRow[]> {
    return (await this.connection.records.find("sources", { owner_user_id: ownerUserId, conversation_id: conversationId })).filter(row => row.status !== "deleted").sort(ascending("created_at"));
  }

  async listByRun(runId: string): Promise<SourceRow[]> {
    return await this.connection.transaction(async () => {
      const links = (await this.connection.records.find("run_sources", { run_id: runId })).sort(ascending("position"));
      const rows: SourceRow[] = [];
      for (const link of links) {
        const source = (await this.connection.records.find("sources", { id: link.source_id }))[0];
        if (source) rows.push(source);
      }
      return rows;
    });
  }

  async bindRunSources(input: {
    ownerUserId: string;
    conversationId: string;
    runId: string;
    sourceIds: readonly string[];
    createdAt: number;
  }): Promise<SourceRow[]> {
    if (input.sourceIds.length === 0) return [];
    return await this.connection.transaction(async () => {
    const rows = await Promise.all(input.sourceIds.map((sourceId) => this.requireByOwner(input.ownerUserId, sourceId)));
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
    for (const [index, row] of rows.entries()) {
      const changed = await this.connection.records.update("sources", { id: row.id, owner_user_id: input.ownerUserId }, value =>
        value.conversation_id === null || value.conversation_id === input.conversationId ? { conversation_id: input.conversationId, updated_at: input.createdAt } : undefined);
      if (!changed) throw new AppError("FORBIDDEN", "Source cannot be claimed for this conversation", 403);
      await this.connection.records.insert("run_sources", { run_id: input.runId, source_id: row.id, position: index, role: "user_supplied", created_at: input.createdAt });
    }
    return rows.map((row) => ({ ...row, conversation_id: input.conversationId }));
    });
  }

  async chunks(sourceId: string): Promise<SourceChunkRow[]> {
    return (await this.connection.records.find("source_chunks", { source_id: sourceId })).sort(ascending("chunk_index"));
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
