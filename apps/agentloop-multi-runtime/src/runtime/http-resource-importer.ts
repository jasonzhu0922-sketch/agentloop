import { createHash } from "node:crypto";
import type { RunService } from "@zhujun/agentloop";
import type { ResourceImporter } from "./runtime-host.ts";

const MAX_IMPORTED_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Downloads Router-issued immutable refs and imports them into this Host's local Source Store. */
export class HttpResourceImporter implements ResourceImporter {
  private readonly runs: Pick<RunService, "uploadSource">;
  private readonly routerAttachmentToken: string;

  constructor(
    runs: Pick<RunService, "uploadSource">,
    routerAttachmentToken: string,
  ) {
    this.runs = runs;
    this.routerAttachmentToken = routerAttachmentToken;
  }

  async importForRun(input: Parameters<ResourceImporter["importForRun"]>[0]): Promise<readonly string[]> {
    const sourceIds: string[] = [];
    for (const resource of input.resources) {
      const uri = new URL(resource.uri);
      if (uri.protocol !== "http:" && uri.protocol !== "https:") throw new TypeError("resource URI must use http or https");
      if (!Number.isSafeInteger(resource.byteSize) || resource.byteSize < 0 || resource.byteSize > MAX_IMPORTED_ATTACHMENT_BYTES) {
        throw new RangeError("resource byteSize is invalid");
      }
      const response = await fetch(uri, { headers: { authorization: `Bearer ${this.routerAttachmentToken}` } });
      if (!response.ok) throw new Error(`Router attachment fetch failed with HTTP ${response.status}`);
      const content = Buffer.from(await response.arrayBuffer());
      if (content.length !== resource.byteSize) throw new Error(`attachment ${resource.attachmentId} byte size mismatch`);
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (sha256 !== resource.sha256) throw new Error(`attachment ${resource.attachmentId} sha256 mismatch`);
      const source = await this.runs.uploadSource(input.subject.userId, {
        originalName: resource.originalName,
        mimeType: resource.mediaType,
        content,
      });
      if (source.status !== "ready") throw sourceImportError(source);
      sourceIds.push(source.id);
    }
    return sourceIds;
  }
}

function sourceImportError(source: Awaited<ReturnType<RunService["uploadSource"]>>): Error {
  if (source.status === "unsupported") {
    return new Error(`附件「${source.originalName}」：该格式暂不支持（${source.extension || "未知格式"}）。请上传受支持的文件格式。`);
  }
  return new Error(`附件「${source.originalName}」暂不可用：${source.status}`);
}
