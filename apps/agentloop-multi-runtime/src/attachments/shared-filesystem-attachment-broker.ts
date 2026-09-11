import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppDatabase } from "@zhujun/agentloop";
import type { PortableResourceRef } from "../domain/contracts.ts";
import type { ConversationAttachment } from "./attachment-broker.ts";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

interface AttachmentRow extends ConversationAttachment {
  readonly storage_name: string;
}

/**
 * Router attachment boundary for multi-replica deployments.
 *
 * Metadata is authoritative in the shared control database, while immutable
 * bytes live on an RWX filesystem mounted at the same path by every Router.
 * Runtime Hosts continue to receive only Router-issued HTTP references.
 */
export class SharedFilesystemAttachmentBroker {
  private readonly database: AppDatabase;
  private readonly root: string;
  private readonly hostReadBaseUrl: string;

  constructor(
    database: AppDatabase,
    root: string,
    hostReadBaseUrl: string,
  ) {
    this.database = database;
    this.root = root;
    this.hostReadBaseUrl = hostReadBaseUrl;
  }

  async ready(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS mr_attachments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mr_attachments_subject_idx
        ON mr_attachments(tenant_id, owner_user_id, conversation_id, created_at DESC);
    `);
  }

  async upload(input: Omit<ConversationAttachment, "id" | "byteSize" | "sha256"> & { readonly content: Buffer }): Promise<ConversationAttachment> {
    if (input.content.length > MAX_ATTACHMENT_BYTES) throw new RangeError(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    const attachment: AttachmentRow = {
      id: `attachment_${randomUUID()}`,
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      originalName: safeOriginalName(input.originalName),
      mediaType: input.mediaType || "application/octet-stream",
      byteSize: input.content.length,
      sha256: createHash("sha256").update(input.content).digest("hex"),
      storage_name: `${randomUUID()}.bin`,
    };
    const path = this.pathFor(attachment.storage_name);
    await mkdir(this.root, { recursive: true });
    await writeFile(path, input.content, { flag: "wx" });
    try {
      await this.database.prepare(`
        INSERT INTO mr_attachments(
          id, tenant_id, owner_user_id, conversation_id, original_name,
          media_type, byte_size, sha256, storage_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attachment.id, attachment.tenantId, attachment.ownerUserId, attachment.conversationId,
        attachment.originalName, attachment.mediaType, attachment.byteSize, attachment.sha256,
        attachment.storage_name, Date.now(),
      );
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return publicAttachment(attachment);
  }

  async resolveForTask(input: {
    readonly tenantId: string;
    readonly ownerUserId: string;
    readonly conversationId: string;
    readonly attachmentIds: readonly string[];
  }): Promise<readonly PortableResourceRef[]> {
    return await Promise.all(input.attachmentIds.map(async (id) => {
      const attachment = await this.attachment(id);
      if (attachment === undefined) throw new TypeError(`attachment not found: ${id}`);
      if (attachment.tenantId !== input.tenantId || attachment.ownerUserId !== input.ownerUserId || attachment.conversationId !== input.conversationId) {
        throw new TypeError("attachment does not belong to this user conversation");
      }
      return {
        attachmentId: attachment.id,
        uri: new URL(`/v1/internal/attachments/${encodeURIComponent(attachment.id)}`, withTrailingSlash(this.hostReadBaseUrl)).toString(),
        sha256: attachment.sha256,
        mediaType: attachment.mediaType,
        originalName: attachment.originalName,
        byteSize: attachment.byteSize,
      };
    }));
  }

  async readForRuntime(id: string): Promise<{ readonly attachment: ConversationAttachment; readonly content: Buffer }> {
    const attachment = await this.attachment(id);
    if (attachment === undefined) throw new TypeError("attachment not found");
    return { attachment: publicAttachment(attachment), content: await readFile(this.pathFor(attachment.storage_name)) };
  }

  private async attachment(id: string): Promise<AttachmentRow | undefined> {
    const row = await this.database.prepare(`
      SELECT id, tenant_id, owner_user_id, conversation_id, original_name,
        media_type, byte_size, sha256, storage_name
      FROM mr_attachments WHERE id = ?
    `).get<{
      id: string; tenant_id: string; owner_user_id: string; conversation_id: string;
      original_name: string; media_type: string; byte_size: number; sha256: string; storage_name: string;
    }>(id);
    return row === undefined ? undefined : {
      id: row.id,
      tenantId: row.tenant_id,
      ownerUserId: row.owner_user_id,
      conversationId: row.conversation_id,
      originalName: row.original_name,
      mediaType: row.media_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      storage_name: row.storage_name,
    };
  }

  private pathFor(storageName: string): string {
    return resolve(this.root, storageName);
  }
}

function publicAttachment(value: AttachmentRow): ConversationAttachment {
  const { storage_name: _storageName, ...attachment } = value;
  return attachment;
}

function safeOriginalName(value: string): string {
  const name = value.replace(/[\\/\0]/g, "_").trim();
  if (name.length === 0 || name.length > 240) throw new TypeError("originalName must be between 1 and 240 characters");
  return name;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
