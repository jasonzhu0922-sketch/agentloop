import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { recordTransaction, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "./runtime-records.ts";
import { runtimeRecordSchema, type RuntimeRows, type RuntimeTable } from "./runtime-record-schema.ts";
import type { SqlConnection } from "./connection.ts";
import { importRuntimeRecords, type RuntimeTransferManifest } from "./runtime-record-transfer.ts";

export interface RuntimeArchiveStore {
  /** Immutable, checksum verified write. A remote implementation may upload to shared object storage. */
  put(key: string, bytes: Uint8Array, sha256: string): Promise<void>;
  get?(key: string): Promise<Uint8Array>;
}
export class FileRuntimeArchiveStore implements RuntimeArchiveStore {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async get(key: string): Promise<Uint8Array> {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new TypeError("Invalid Runtime archive key");
    return await readFile(path);
  }
  async put(key: string, bytes: Uint8Array, sha256: string): Promise<void> {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new TypeError("Invalid Runtime archive key");
    if (digest(bytes) !== sha256) throw new Error("Runtime archive checksum mismatch");
    try { if (digest(await readFile(path)) === sha256) return; throw new Error("Runtime archive content changed"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.pending`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      await rename(temporary, path);
      const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
      if (digest(await readFile(path)) !== sha256) throw new Error("Runtime archive verification failed");
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Offline restore of explicitly selected manifests, including all required parent/source manifests.
 * Checks every object before importing. Missing dependencies fail without deleting source history.
 */
export async function restoreRuntimeArchives(state: RuntimePersistenceInput, store: RuntimeArchiveStore,
  manifests: readonly { key: string; sha256: string }[]): Promise<{ inserted: number; unchanged: number; sha256: string }> {
  if (!store.get) throw new Error("Runtime archive storage must implement get for restore");
  const tables: Record<string, Map<string, Record<string, unknown>>> = {};
  const add = (table: string, row: Record<string, unknown>) => {
    if (!(table in runtimeRecordSchema)) throw new Error("Unknown Runtime archive table");
    const identity = JSON.stringify(runtimeRecordSchema[table].key.map(key => row[key]));
    const rows = tables[table] ??= new Map(), prior = rows.get(identity);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      if (table === "conversations" && prior.owner_user_id === row.owner_user_id) {
        if (Number(prior.updated_at) > Number(row.updated_at)) return;
      } else throw new Error("Runtime archive manifests contain different revisions; select one verified snapshot per Run");
    }
    rows.set(identity, Object.fromEntries(Object.keys(runtimeRecordSchema[table].defaults).map(key => [key, row[key] ?? runtimeRecordSchema[table].defaults[key]])));
  };
  for (const reference of manifests) {
    const bytes = await store.get(reference.key);
    if (digest(bytes) !== reference.sha256) throw new Error("Runtime archive manifest checksum mismatch");
    const manifest = JSON.parse(Buffer.from(bytes).toString());
    if (manifest.schema !== "agentloop.runtimeArchive/v1") throw new Error("Unsupported Runtime archive schema");
    for (const [table, rows] of Object.entries(manifest.tables)) for (const row of rows as Record<string, unknown>[]) add(table, row);
    let cursor = 0;
    for (const segment of manifest.segments) {
      const bytes = await store.get(segment.key);
      if (digest(bytes) !== segment.sha256 || segment.firstSeq !== cursor + 1) throw new Error("Runtime archive segment checksum/sequence mismatch");
      const rows = JSON.parse(Buffer.from(bytes).toString());
      if (rows.length !== segment.lastSeq - cursor) throw new Error("Runtime archive segment count mismatch");
      for (const row of rows) {
        if (row.seq !== ++cursor || row.run_id !== undefined && row.run_id !== manifest.summary.run.id) throw new Error("Runtime archive event gap/identity mismatch");
        add("run_events", { ...row, run_id: manifest.summary.run.id });
      }
    }
    if (cursor !== manifest.summary.lastEventSeq) throw new Error("Runtime archive is incomplete");
  }
  const body = { schema: "agentloop.runtimeTransfer/v1" as const, source: "verified-runtime-archives", tables: {}, counts: {} };
  for (const table of Object.keys(runtimeRecordSchema)) {
    body.tables[table] = [...(tables[table] ?? new Map())].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
    body.counts[table] = body.tables[table].length;
  }
  return await importRuntimeRecords(state, { ...body, sha256: digest(Buffer.from(JSON.stringify(body))) } as RuntimeTransferManifest);
}
export interface RuntimeRunSummary {
  readonly run: RuntimeRows["runs"];
  readonly plans: readonly RuntimeRows["plans"][];
  readonly outcome: RuntimeRows["run_outcomes"];
  readonly lastEventSeq: number;
}
export interface RuntimeSummarySink {
  write(namespace: string, summary: RuntimeRunSummary): Promise<void>;
  remove?(namespace: string, runId: string, lastSeq: number): Promise<void>;
  close?(): Promise<void>;
}

/** @deprecated Compatibility-only summary API. New hosts use RuntimeHistorySink and the durable history outbox. */
export class SqlRuntimeSummarySink implements RuntimeSummarySink {
  private readonly connect: () => Promise<SqlConnection>;
  private connection?: SqlConnection;
  private ready = false;
  constructor(connect: () => Promise<SqlConnection>) { this.connect = connect; }
  async write(namespace: string, summary: RuntimeRunSummary): Promise<void> {
    const db = this.connection ??= await this.connect();
    try {
      if (!this.ready) {
        await db.exec(`CREATE TABLE IF NOT EXISTS runtime_run_summaries (
          namespace VARCHAR(191) NOT NULL, run_id VARCHAR(191) NOT NULL, last_seq BIGINT NOT NULL,
          payload_json ${db.dialect === "tidb" ? "LONGTEXT" : "TEXT"} NOT NULL, PRIMARY KEY(namespace,run_id))`);
        this.ready = true;
      }
      const insert = "INSERT INTO runtime_run_summaries(namespace,run_id,last_seq,payload_json) VALUES (?,?,?,?)";
      const update = db.dialect === "tidb" ?
        " ON DUPLICATE KEY UPDATE payload_json=IF(VALUES(last_seq)>=last_seq,VALUES(payload_json),payload_json),last_seq=GREATEST(last_seq,VALUES(last_seq))" :
        " ON CONFLICT(namespace,run_id) DO UPDATE SET last_seq=excluded.last_seq,payload_json=excluded.payload_json WHERE runtime_run_summaries.last_seq<=excluded.last_seq";
      await db.prepare(insert + update).run(namespace, summary.run.id, summary.lastEventSeq, JSON.stringify(summary));
    } catch (error) { this.ready = false; this.connection = undefined; await db.close().catch(() => {}); throw error; }
  }
  async remove(namespace: string, runId: string, lastSeq: number): Promise<void> {
    await this.write(namespace, { run: { id: runId }, plans: [], outcome: { status: "deleted" }, lastEventSeq: lastSeq } as unknown as RuntimeRunSummary);
  }
  async close(): Promise<void> { await this.connection?.close(); this.connection = undefined; }
}

/** Independent archive and summary workers. Neither participates in Runtime commit acknowledgement. */
export class RuntimeRecordMaintenance {
  private readonly state: RuntimePersistence;
  private readonly namespace: string;
  private readonly archive: RuntimeArchiveStore;
  private readonly sink?: RuntimeSummarySink;
  private readonly artifactReader?: (runId: string) => Promise<readonly import("../runtime/process-artifacts.ts").ProcessArtifact[]>;
  private readonly artifactContent?: (artifact: import("../runtime/process-artifacts.ts").ProcessArtifact) => Promise<Uint8Array>;
  private readonly background = new AsyncResource("RuntimeRecordMaintenance");
  private timer?: ReturnType<typeof setInterval>;
  private archiving?: Promise<void>;
  private projecting?: Promise<void>;
  private closed = false;
  private readonly archived = new Map<string, number>();
  private readonly projected = new Map<string, number>();
  private archiveFailed = false;
  private archiveError?: string;
  private projectionFailed = false;
  constructor(options: { state: RuntimePersistenceInput; namespace: string; archive: RuntimeArchiveStore; summary?: RuntimeSummarySink; artifacts?: (runId: string) => Promise<readonly import("../runtime/process-artifacts.ts").ProcessArtifact[]>; artifactContent?: (artifact: import("../runtime/process-artifacts.ts").ProcessArtifact) => Promise<Uint8Array> }) {
    this.state = runtimePersistence(options.state); this.namespace = options.namespace; this.archive = options.archive; this.sink = options.summary; this.artifactReader = options.artifacts; this.artifactContent=options.artifactContent;
  }
  status() { return { archivedRuns: this.archived.size, projectedRuns: this.projected.size, archivePending: this.archiveFailed, projectionPending: this.projectionFailed, archiveError: this.archiveError }; }
  start(intervalMs = 5000): void {
    if (this.timer || this.closed) return;
    const kick = () => this.background.runInAsyncScope(() => {
      void this.archiveNow().catch(() => {}); void this.projectNow().catch(() => {});
    });
    this.timer = setInterval(kick, intervalMs); this.timer.unref(); kick();
  }
  private async *summaries(): AsyncGenerator<RuntimeRunSummary> {
    let cursor: string | undefined;
    do {
      const page = await this.state.records.scan("runs", cursor, 50); cursor = page.cursor;
      for (const run of page.rows) {
        if (run.status === "running") continue;
        const summary = await recordTransaction(this.state,async () => {
          const current = (await this.state.records.find("runs", { id: run.id }))[0];
          const outcome = (await this.state.records.find("run_outcomes", { run_id: run.id }))[0];
          if (!current || !outcome) return undefined;
          const sequence = (await this.state.records.find("run_event_sequences", { run_id: run.id }))[0];
          return { run: current, plans: await this.state.records.find("plans", { run_id: run.id }), outcome, lastEventSeq: (sequence?.next_seq ?? 1) - 1 };
        });
        if (summary) yield summary;
      }
    } while (cursor);
  }
  archiveNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.archiving ??= this.background.runInAsyncScope(async () => {
      try {
        for await (const summary of this.summaries()) {
          if (this.archived.get(summary.run.id) === summary.lastEventSeq) continue;
          const snapshot = await this.snapshot(summary);
          const root = `${createHash("sha256").update(this.namespace).digest("hex")}/${createHash("sha256").update(summary.run.id).digest("hex")}`;
          const segments: { key: string; sha256: string; firstSeq: number; lastSeq: number }[] = [];
          let cursor = 0;
          while (cursor < summary.lastEventSeq) {
            const page = this.state.eventPage ? await this.state.eventPage(summary.run.id, cursor, 250) :
              (await this.state.records.find("run_events", { run_id: summary.run.id })).filter(row => row.seq > cursor).sort((a, b) => a.seq - b.seq).slice(0, 250);
            const rows = page.filter(row => row.seq <= summary.lastEventSeq);
            if (!rows.length) throw new Error("Runtime archive event gap");
            if (rows[0].seq !== cursor + 1 || rows.some((row, index) => row.seq !== cursor + index + 1)) throw new Error("Runtime archive sequence gap");
            const bytes = Buffer.from(JSON.stringify(rows)), checksum = digest(bytes), key = `${root}/events/${cursor + 1}-${rows.at(-1)!.seq}-${checksum}.json`;
            await this.archive.put(key, bytes, checksum);
            segments.push({ key, sha256: checksum, firstSeq: cursor + 1, lastSeq: rows.at(-1)!.seq }); cursor = rows.at(-1)!.seq;
          }
          const bytes = Buffer.from(JSON.stringify({ schema: "agentloop.runtimeArchive/v1", summary, tables: snapshot, segments }));
          const checksum = digest(bytes);
          // A manifest is written only after all referenced event segments are verified.
          const key = `${root}/snapshots/${summary.lastEventSeq}-${checksum}.json`;
          await this.archive.put(key, bytes, checksum);
          await this.state.historyOutbox?.publish({ objectId: `archive:${summary.run.id}`, kind: "archives", deleted: false,
            ownerId: summary.run.owner_user_id, conversationId: summary.run.conversation_id ?? "", runId: summary.run.id, planId: "",
            payload: { key, sha256: checksum, bytes: bytes.length, schema: "agentloop.runtimeArchive/v1", lastEventSeq: summary.lastEventSeq } });
          if (this.artifactReader) for (const artifact of await this.artifactReader(summary.run.id)) {
            if (!artifact.sha256 || !this.artifactContent) throw new Error("Runtime artifact checksum/content reader is unavailable");
            const content=await this.artifactContent(artifact);
            if(content.byteLength!==artifact.bytes || digest(content)!==artifact.sha256) throw new Error("Runtime artifact content changed before archival");
            const storageRef=`artifacts/${artifact.sha256}.bin`;
            await this.archive.put(storageRef,content,artifact.sha256);
            await this.state.historyOutbox?.publish({ objectId: `artifact:${summary.run.id}:${artifact.id}`, kind: "artifacts", deleted: false,
              ownerId: summary.run.owner_user_id, conversationId: summary.run.conversation_id ?? "", runId: summary.run.id, planId: "",
              payload: { ...artifact, type:artifact.mimeType, storageRef, storageKind:"archive" } });
          }
          this.archived.set(summary.run.id, summary.lastEventSeq);
          if (this.archived.size > 10000) this.archived.delete(this.archived.keys().next().value!);
        }
        this.archiveFailed = false; this.archiveError = undefined;
      } catch (error) { this.archiveFailed = true; this.archiveError = String(error).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/giu, "<url>"); throw error; }
      finally { this.archiving = undefined; }
    });
  }
  private async snapshot(summary: RuntimeRunSummary): Promise<Partial<{ [T in RuntimeTable]: RuntimeRows[T][] }>> {
    return await recordTransaction(this.state,async () => {
      const current = (await this.state.records.find("runs", { id: summary.run.id }))[0];
      const sequence = (await this.state.records.find("run_event_sequences", { run_id: summary.run.id }))[0];
      if (!current || current.status === "running" || (sequence?.next_seq ?? 1) - 1 !== summary.lastEventSeq)
        throw new Error("Runtime archive snapshot changed; retry on the next background pass");
      const result: Record<string, unknown[]> = { runs: [current] };
      for (const [name, definition] of Object.entries(runtimeRecordSchema)) {
        const table = name as RuntimeTable;
        if (table === "runs" || table === "run_events" || table === "runtime_deletions") continue;
        const rows: unknown[] = [];
        if ("run_id" in definition.defaults) rows.push(...await this.state.records.find(table, { run_id: summary.run.id }));
        else if ("plan_id" in definition.defaults) for (const plan of summary.plans) rows.push(...await this.state.records.find(table, { plan_id: plan.id }));
        if (rows.length) result[table] = rows;
      }
      const links = result.run_sources as RuntimeRows["run_sources"][] | undefined;
      result.sources = []; result.source_chunks = [];
      for (const link of links ?? []) {
        result.sources.push(...await this.state.records.find("sources", { id: link.source_id }));
        result.source_chunks.push(...await this.state.records.find("source_chunks", { source_id: link.source_id }));
      }
      result.local_runtime_dispatches = await this.state.records.find("local_runtime_dispatches", { remote_run_id: summary.run.id });
      result.runtime_dispatches = await this.state.records.find("runtime_dispatches", { remote_run_id: summary.run.id });
      result.runtime_executors = await this.state.records.find("runtime_executors", { remote_run_id: summary.run.id });
      if (summary.run.conversation_id) result.conversations = await this.state.records.find("conversations", { id: summary.run.conversation_id });
      return result;
    });
  }
  projectNow(): Promise<void> {
    if (this.closed || !this.sink) return Promise.resolve();
    return this.projecting ??= this.background.runInAsyncScope(async () => {
      try {
        for await (const summary of this.summaries()) {
          if (this.projected.get(summary.run.id) === summary.lastEventSeq) continue;
          await this.sink!.write(this.namespace, summary); this.projected.set(summary.run.id, summary.lastEventSeq);
          if (this.projected.size > 10000) this.projected.delete(this.projected.keys().next().value!);
        }
        if (this.sink!.remove) {
          let cursor: string | undefined;
          do {
            const page = await this.state.records.scan("runtime_deletions", cursor, 100); cursor = page.cursor;
            for (const row of page.rows) await this.sink!.remove(this.namespace, row.run_id, row.last_seq);
          } while (cursor);
        }
        this.projectionFailed = false;
      } catch (error) { this.projectionFailed = true; throw error; }
      finally { this.projecting = undefined; }
    });
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.archiving, this.projecting]); await this.sink?.close?.();
  }
}
