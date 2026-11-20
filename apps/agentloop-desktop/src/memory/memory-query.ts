import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { LocalRuntimeSummary } from "@zhujun/agentloop-local-runtime";
import { HttpError } from "../security/loopback.ts";

type Row = Record<string, any>;
const categories: Record<string, string> = {
  reusable: "i.subtype <> 'experience.episode'", all: "1=1", preference: "i.kind = 'preference'", fact: "i.kind = 'fact'",
  episode: "i.subtype = 'experience.episode'", task_group: "i.subtype = 'experience.task_group'", procedure: "i.subtype = 'experience.procedure'",
};
const evidenceTypes = ["memory.recalled", "memory.recall_failed", "memory.explicit_commit", "memory.settlement_enqueued", "memory.settlement_enqueue_failed",
  "human_loop.requested", "human_loop.answered", "decision.committed", "plan.admitted", "assistant.tool_call.committed", "tool.completed", "run.completed", "run.failed"];
function integer(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const value = params.get(name);
  if (value === null) return fallback;
  if (!/^\d{1,9}$/.test(value) || Number(value) > max) throw new HttpError(400, "memory_query_invalid");
  return Number(value);
}
function keyword(params: URLSearchParams, name: string): string {
  const value = params.get(name)?.trim() ?? "";
  if (value.length > 200) throw new HttpError(400, "memory_query_invalid");
  return value;
}
function page(params: URLSearchParams) {
  const limit = integer(params, "limit", 25, 100);
  if (!limit) throw new HttpError(400, "memory_query_invalid");
  return { offset: integer(params, "offset", 0, 1_000_000), limit };
}
function revision(row: Row) {
  return { id: row.id, revision: row.revision, content: row.content_markdown, value: JSON.parse(row.value_json),
    authority: row.authority, maturity: row.experience_maturity, confidence: row.confidence,
    applicability: JSON.parse(row.applicability_json), sources: JSON.parse(row.source_refs_json),
    activation: JSON.parse(row.activation_json), targets: JSON.parse(row.targets_json),
    validFrom: row.valid_from, expiresAt: row.expires_at, changeReason: row.change_reason, createdAt: row.created_at };
}
function job(row: Row) {
  return { runId: row.run_id, id: row.settlement_job_id, status: row.status, attempts: row.attempts,
    lastError: row.last_error, enqueuedAt: row.enqueued_at, nextAttemptAt: row.next_attempt_at };
}

/** Account-owned diagnostics. Never migrates a database, starts a worker or
 * accepts a renderer-supplied path/owner. Each request closes its read-only snapshot. */
export class MemoryQuery {
  private readonly root: string;
  private readonly owner: string;
  constructor(root: string, owner: string) { this.root = root; this.owner = owner; }

  private async read<T>(file: string, fn: (db: DatabaseSync) => T): Promise<T | undefined> {
    let stat;
    try { stat = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const offset = relative(await realpath(this.root), await realpath(file));
    if (!stat.isFile() || stat.isSymbolicLink() || offset.startsWith(`..${sep}`) || offset === ".." || isAbsolute(offset)) throw new HttpError(409, "memory_storage_invalid");
    const db = new DatabaseSync(file, { readOnly: true, timeout: 1_000 });
    try { db.exec("BEGIN"); return fn(db); } finally { db.close(); }
  }

  async items(params: URLSearchParams) {
    const { offset, limit } = page(params), q = keyword(params, "q");
    const category = params.get("category") ?? "reusable", status = params.get("status") ?? "active";
    if (!Object.hasOwn(categories, category) || !["all", "active", "superseded", "deleted"].includes(status)) throw new HttpError(400, "memory_query_invalid");
    return await this.read(join(this.root, "memory.db"), db => {
      const where = `i.owner_user_id = ? AND ${categories[category]} AND (? = 'all' OR i.status = ?)
        AND (? = '' OR instr(lower(i.subtype || ' ' || coalesce(i.canonical_key, '') || ' ' || r.content_markdown || ' ' || r.value_json), lower(?)) > 0)`;
      const args: SQLInputValue[] = [this.owner, status, status, q, q];
      const counts = db.prepare("SELECT kind, subtype, status, count(*) AS count FROM local_memory_items WHERE owner_user_id = ? GROUP BY kind, subtype, status").all(this.owner);
      const total = db.prepare(`SELECT count(*) AS count FROM local_memory_items i JOIN local_memory_revisions r ON r.id = i.current_revision_id AND r.memory_id = i.id WHERE ${where}`).get(...args)!.count;
      const items = db.prepare(`SELECT i.id, i.kind, i.subtype, i.status, i.canonical_key AS canonicalKey, i.updated_at AS updatedAt,
        r.revision, r.experience_maturity AS maturity, substr(r.content_markdown, 1, 240) AS preview
        FROM local_memory_items i JOIN local_memory_revisions r ON r.id = i.current_revision_id AND r.memory_id = i.id
        WHERE ${where} ORDER BY i.updated_at DESC, i.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
      return { available: true, counts, items, total, offset, limit };
    }) ?? { available: false, counts: [], items: [], total: 0, offset, limit };
  }

  async item(id: string, params: URLSearchParams) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "memory_query_invalid");
    const { offset, limit } = page(params);
    const result = await this.read(join(this.root, "memory.db"), db => {
      const item = db.prepare("SELECT id, kind, subtype, status, canonical_key AS canonicalKey, current_revision_id AS currentRevisionId FROM local_memory_items WHERE id = ? AND owner_user_id = ?").get(id, this.owner);
      if (!item) return undefined;
      const current = db.prepare("SELECT * FROM local_memory_revisions WHERE id = ? AND memory_id = ?").get(item.currentRevisionId as string, id)!;
      const revisions = db.prepare("SELECT * FROM local_memory_revisions WHERE memory_id = ? ORDER BY revision DESC LIMIT ? OFFSET ?").all(id, limit, offset).map(revision);
      const total = db.prepare("SELECT count(*) AS count FROM local_memory_revisions WHERE memory_id = ?").get(id)!.count;
      return { item, current: revision(current), revisions, total, offset, limit };
    });
    if (!result) throw new HttpError(404, "memory_item_not_found");
    return result;
  }

  async jobs(params: URLSearchParams) {
    const { offset, limit } = page(params), q = keyword(params, "q"), status = params.get("status") ?? "all";
    if (!["all", "queued", "processing", "succeeded", "failed", "dead_letter"].includes(status)) throw new HttpError(400, "memory_query_invalid");
    return await this.read(join(this.root, "memory.db"), db => {
      const args = [this.owner, status, status, q, q];
      const where = "owner_user_id = ? AND (? = 'all' OR status = ?) AND (? = '' OR instr(run_id, ?) > 0)";
      return { available: true,
        counts: db.prepare("SELECT status, count(*) AS count FROM local_memory_settlement_jobs WHERE owner_user_id = ? GROUP BY status").all(this.owner),
        total: db.prepare(`SELECT count(*) AS count FROM local_memory_settlement_jobs WHERE ${where}`).get(...args)!.count,
        jobs: db.prepare(`SELECT * FROM local_memory_settlement_jobs WHERE ${where} ORDER BY enqueued_at DESC, run_id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(job), offset, limit };
    }) ?? { available: false, counts: [], total: 0, jobs: [], offset, limit };
  }

  async run(params: URLSearchParams, runtimes: readonly LocalRuntimeSummary[]) {
    const key = keyword(params, "run"), runtimeId = params.get("runtimeId");
    if (!/^[a-zA-Z0-9_-]{4,200}$/.test(key) || (runtimeId !== null && !runtimes.some(r => r.id === runtimeId))) throw new HttpError(400, "memory_query_invalid");
    const afterSeq = integer(params, "afterSeq", 0, 1_000_000_000), { limit } = page(params);
    const matches: Row[] = [];
    for (const runtime of runtimes.filter(r => runtimeId === null || r.id === runtimeId)) {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runtime.storageKey)) throw new HttpError(409, "memory_storage_invalid");
      const file = runtime.isDefault ? join(this.root, "runtime.db") : join(this.root, "runtimes", runtime.storageKey, "agentloop.db");
      const rows = await this.read(file, db => db.prepare(`SELECT id, status, substr(input, 1, 180) AS input, created_at AS createdAt FROM runs
        WHERE owner_user_id = ? AND instr(id, ?) > 0 ORDER BY created_at DESC LIMIT 21`).all(this.owner, key));
      for (const row of rows ?? []) matches.push({ ...row, runtimeId: runtime.id, runtimeName: runtime.displayName });
      if (matches.length > 20) throw new HttpError(400, "memory_run_query_too_broad");
    }
    if (matches.length !== 1) return { matches, detail: null };
    const match = matches[0]!, runtime = runtimes.find(r => r.id === match.runtimeId)!;
    const file = runtime.isDefault ? join(this.root, "runtime.db") : join(this.root, "runtimes", runtime.storageKey, "agentloop.db");
    const evidence = await this.read(file, db => {
      const run = db.prepare("SELECT id, status, input, output, error_code AS errorCode FROM runs WHERE id = ? AND owner_user_id = ?").get(match.id, this.owner);
      if (!run) return undefined; // Deleted between the two snapshots.
      const types = evidenceTypes.map(() => "?").join(",");
      const rows = db.prepare(`SELECT seq, type, payload_json, created_at AS createdAt FROM run_events WHERE run_id = ? AND seq > ? AND type IN (${types}) ORDER BY seq LIMIT ?`).all(match.id, afterSeq, ...evidenceTypes, limit + 1);
      const hasMore = rows.length > limit;
      return { run, events: rows.slice(0, limit).map(row => ({ seq: row.seq, type: row.type, createdAt: row.createdAt, data: JSON.parse(row.payload_json as string) })), hasMore };
    });
    if (!evidence) throw new HttpError(404, "memory_run_not_found");
    const memory = await this.read(join(this.root, "memory.db"), db => ({
      // Diagnostics remain read-only for pre-review databases as well.
      applicationReviews: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_memory_application_reviews'").get()
        ? db.prepare("SELECT review_json FROM local_memory_application_reviews WHERE owner_user_id = ? AND run_id = ? ORDER BY created_at, id").all(this.owner, match.id).map(row => JSON.parse(row.review_json as string)) : [],
      invalidations: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_memory_run_invalidations'").get()
        ? db.prepare("SELECT source_json, created_at FROM local_memory_run_invalidations WHERE owner_user_id = ? AND run_id = ? ORDER BY created_at").all(this.owner, match.id).map(row => ({ source: JSON.parse(row.source_json as string), createdAt: row.created_at })) : [],
      projections: db.prepare("SELECT projection_json FROM local_memory_projections WHERE owner_user_id = ? AND run_id = ? ORDER BY created_at, id").all(this.owner, match.id).map(row => JSON.parse(row.projection_json as string)),
      jobs: db.prepare("SELECT * FROM local_memory_settlement_jobs WHERE owner_user_id = ? AND run_id = ? ORDER BY enqueued_at").all(this.owner, match.id).map(job),
      attempts: db.prepare("SELECT attempt_json FROM local_memory_settlement_attempts WHERE owner_user_id = ? AND run_id = ? ORDER BY created_at, id").all(this.owner, match.id).map(row => JSON.parse(row.attempt_json as string)),
    }));
    return { matches, detail: { ...evidence, memoryAvailable: memory !== undefined, projections: memory?.projections ?? [], jobs: memory?.jobs ?? [], attempts: memory?.attempts ?? [], applicationReviews: memory?.applicationReviews ?? [], invalidations: memory?.invalidations ?? [] } };
  }
}
