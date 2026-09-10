import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PortableResourceRef } from "../domain/contracts.ts";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface ConversationAttachment {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly conversationId: string;
  readonly originalName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

interface StoredAttachment extends ConversationAttachment {
  readonly storageName: string;
}

/**
 * Local demo implementation of a Router-owned immutable attachment broker.
 * Production implements the same boundary using object storage and a control
 * plane database; Runtime Hosts never receive its filesystem location.
 */
export class FileAttachmentBroker {
  private readonly attachments = new Map<string, StoredAttachment>();
  private readonly root: string;
  private readonly hostReadBaseUrl: string;

  constructor(root: string, hostReadBaseUrl: string) {
    this.root = root;
    this.hostReadBaseUrl = hostReadBaseUrl;
  }

  async upload(input: Omit<ConversationAttachment, "id" | "byteSize" | "sha256"> & { readonly content: Buffer }): Promise<ConversationAttachment> {
    if (input.content.length > MAX_ATTACHMENT_BYTES) throw new RangeError(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    const attachment: StoredAttachment = {
      id: `attachment_${randomUUID()}`,
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      originalName: safeOriginalName(input.originalName),
      mediaType: input.mediaType || "application/octet-stream",
      byteSize: input.content.length,
      sha256: createHash("sha256").update(input.content).digest("hex"),
      storageName: `${randomUUID()}.bin`,
    };
    await mkdir(this.root, { recursive: true });
    await writeFile(resolve(this.root, attachment.storageName), input.content, { flag: "wx" });
    this.attachments.set(attachment.id, attachment);
    await this.persist();
    return publicAttachment(attachment);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath(), "utf8");
      const parsed = JSON.parse(raw) as StoredAttachment[];
      for (const attachment of parsed) this.attachments.set(attachment.id, attachment);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  resolveForTask(input: {
    readonly tenantId: string;
    readonly ownerUserId: string;
    readonly conversationId: string;
    readonly attachmentIds: readonly string[];
  }): readonly PortableResourceRef[] {
    return input.attachmentIds.map((id) => {
      const attachment = this.attachments.get(id);
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
    });
  }

  async readForRuntime(id: string): Promise<{ readonly attachment: ConversationAttachment; readonly content: Buffer }> {
    const attachment = this.attachments.get(id);
    if (attachment === undefined) throw new TypeError("attachment not found");
    return { attachment: publicAttachment(attachment), content: await readFile(resolve(this.root, attachment.storageName)) };
  }

  private indexPath(): string {
    return resolve(this.root, "attachments.json");
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.indexPath()), { recursive: true });
    const temporary = `${this.indexPath()}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.attachments.values()]));
    await rename(temporary, this.indexPath());
  }
}

function publicAttachment(value: StoredAttachment): ConversationAttachment {
  const { storageName: _storageName, ...attachment } = value;
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
