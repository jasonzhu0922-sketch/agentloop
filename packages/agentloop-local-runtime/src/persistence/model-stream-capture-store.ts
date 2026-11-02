import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelStreamRawCaptureInput,
  ModelStreamRawCaptureRef,
  ModelStreamRawCaptureWriter,
} from "@zhujun/agentloop";

const DEFAULT_RETENTION_MS = 72 * 60 * 60 * 1_000;
const DEFAULT_MAX_STORE_BYTES = 256 * 1024 * 1024;

/** Private, bounded diagnostic storage. Captures are never workspace artifacts. */
export class LocalModelStreamCaptureStore {
  private readonly root: string;
  private readonly retentionMs: number;
  private readonly maxStoreBytes: number;

  constructor(
    root: string,
    options: Readonly<{ retentionMs?: number; maxStoreBytes?: number }> = {},
  ) {
    this.root = root;
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS, "retentionMs");
    this.maxStoreBytes = positiveInteger(options.maxStoreBytes, DEFAULT_MAX_STORE_BYTES, "maxStoreBytes");
  }

  readonly capture: ModelStreamRawCaptureWriter = async (
    input: ModelStreamRawCaptureInput,
  ): Promise<ModelStreamRawCaptureRef> => {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    await this.prune().catch(() => undefined);

    const runSegment = safeSegment(input.runId);
    const runRoot = join(this.root, runSegment);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await chmod(runRoot, 0o700).catch(() => undefined);

    const id = `${Date.now()}-${randomUUID()}`;
    const rawName = `${id}.sse`;
    const metadataName = `${id}.json`;
    const rawPath = join(runRoot, rawName);
    const metadataPath = join(runRoot, metadataName);
    const pendingRawPath = `${rawPath}.pending`;
    const pendingMetadataPath = `${metadataPath}.pending`;
    const metadata = {
      schema: input.schema,
      capturedAt: Date.now(),
      runId: input.runId,
      request: input.request,
      response: input.response,
      anomalyReasons: input.anomalyReasons,
      raw: {
        file: rawName,
        capturedBytes: input.rawSse.byteLength,
        rawBytes: input.rawBytes,
        rawSha256: input.rawSha256,
        truncated: input.truncated,
      },
    };

    try {
      await writeFile(pendingRawPath, input.rawSse, { flag: "wx", mode: 0o600 });
      await writeFile(pendingMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(pendingRawPath, 0o600).catch(() => undefined);
      await chmod(pendingMetadataPath, 0o600).catch(() => undefined);
      await rename(pendingRawPath, rawPath);
      await rename(pendingMetadataPath, metadataPath);
      await chmod(rawPath, 0o600).catch(() => undefined);
      await chmod(metadataPath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(pendingRawPath, { force: true }).catch(() => undefined);
      await rm(pendingMetadataPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      schema: "agentloop.modelStreamRawCaptureRef/v1",
      ref: `local-model-stream-capture:${runSegment}/${id}`,
      capturedBytes: input.rawSse.byteLength,
      rawBytes: input.rawBytes,
      rawSha256: input.rawSha256,
      truncated: input.truncated,
    };
  };

  private async prune(): Promise<void> {
    const now = Date.now();
    const directories = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const files: Array<{ path: string; size: number; modifiedAt: number }> = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const runRoot = join(this.root, directory.name);
      const entries = await readdir(runRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(runRoot, entry.name);
        const info = await stat(path);
        if (now - info.mtimeMs >= this.retentionMs) await rm(path, { force: true });
        else files.push({ path, size: info.size, modifiedAt: info.mtimeMs });
      }
    }
    let retainedBytes = files.reduce((total, file) => total + file.size, 0);
    for (const file of files.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
      if (retainedBytes <= this.maxStoreBytes) break;
      await rm(file.path, { force: true });
      retainedBytes -= file.size;
    }
  }
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  return normalized.length > 0 ? normalized : "unknown-run";
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive integer`);
  return resolved;
}
