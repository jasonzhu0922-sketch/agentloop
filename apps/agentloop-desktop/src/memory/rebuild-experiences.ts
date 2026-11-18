import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { AppDatabase, SqliteConnection } from "@zhujun/agentloop";
import { REUSABLE_LEARNING_CONTRACT, SETTLEMENT_V2, SqliteMemoryStore, settleV2Batch,
  type MemoryScope, type MemorySettlementEvidence, type MemorySettlementModel, type MemorySettlementReader } from "@zhujun/agentloop-memory";

type Row = Record<string, any>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileHash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
function heads(db: DatabaseSync, scope: MemoryScope): Row[] {
  return db.prepare("SELECT id,current_revision_id,status FROM local_memory_items WHERE tenant_id=? AND owner_user_id=? AND kind='experience' ORDER BY id")
    .all(scope.tenantId, scope.ownerUserId);
}
function unchangedHeads(db: DatabaseSync, scope: MemoryScope, expected: readonly Row[]): boolean {
  const current = new Map(heads(db, scope).map(row => [row.id, row]));
  // Unrelated append-only learning is concurrent work, not a conflicting edit.
  return expected.every(row => digest(current.get(row.id)) === digest(row));
}
function entries(db: DatabaseSync, scope: MemoryScope): Row[] {
  return db.prepare(`SELECT i.*,r.value_json,r.content_markdown,r.source_refs_json,r.activation_json FROM local_memory_items i
    JOIN local_memory_revisions r ON r.id=i.current_revision_id
    WHERE i.tenant_id=? AND i.owner_user_id=? AND i.kind='experience' AND i.status='active'`).all(scope.tenantId, scope.ownerUserId);
}
export interface ExperienceRebuildManifest {
  readonly version: 1;
  readonly learningContract: typeof REUSABLE_LEARNING_CONTRACT;
  readonly scope: MemoryScope;
  readonly memoryFile: string;
  readonly preparedAt: number;
  readonly inputHeads: Row[];
  readonly stagedHash: string;
  readonly sourceEvidence: { runId: string; terminalCommitRef: string; hash: string }[];
  readonly unavailableRuns: string[];
  readonly before: { id: string; revisionId: string; subtype: string; title: string }[];
  readonly after: { id: string; revisionId: string; subtype: string; title: string; activation: unknown; reuse: unknown }[];
}

/** Rebuild from canonical execution, never by paraphrasing an old Procedure.
 * All model calls and writes happen in a private SQLite copy until apply. */
export async function prepareExperienceRebuild(input: {
  memoryFile: string; directory: string; scope: MemoryScope;
  reader: MemorySettlementReader; model: MemorySettlementModel;
  progress?: (message: string) => void;
  resume?: boolean;
}): Promise<ExperienceRebuildManifest> {
  if (!input.resume) {
    await mkdir(dirname(input.directory), { recursive: true, mode: 0o700 });
    await mkdir(input.directory, { mode: 0o700 });
  }
  const snapshot = join(input.directory, "before.db"), staged = join(input.directory, "prepared.db");
  if (!input.resume) {
    const source = new DatabaseSync(input.memoryFile, { readOnly: true });
    try { await backup(source, snapshot); } finally { source.close(); }
  } else if (await lstat(join(input.directory, "manifest.json")).catch(() => undefined)) throw new Error("memory_rebuild_already_prepared");
  const frozen = new DatabaseSync(snapshot, { readOnly: true });
  let original: Row[], inputHeads: Row[];
  try {
    original = entries(frozen, input.scope); inputHeads = heads(frozen, input.scope);
    if (!input.resume) await backup(frozen, staged);
    else {
      const live = new DatabaseSync(input.memoryFile, { readOnly: true });
      try { if (!unchangedHeads(live, input.scope, inputHeads)) throw new Error("memory_rebuild_experiences_changed"); }
      finally { live.close(); }
      if (!(await lstat(staged)).isFile()) throw new Error("memory_rebuild_prepared_missing");
    }
  }
  finally { frozen.close(); }
  const oldDerived = original!.filter(row => ["experience.task_group", "experience.procedure"].includes(row.subtype));
  if (!oldDerived.length) throw new Error("memory_rebuild_no_experiences");
  const runs = new Map<string, { runId: string; terminalCommitRef: string }>();
  const episodes = new Map(original!.filter(row => row.subtype === "experience.episode").map(row => [row.canonical_key, row]));
  for (const row of oldDerived.filter(row => row.subtype === "experience.task_group")) {
    const value = JSON.parse(row.value_json);
    for (const key of value.supportingEpisodeIds ?? []) {
      const episode = episodes.get(key);
      const stored = episode && JSON.parse(episode.value_json).v2Episode;
      if (stored?.runId && stored.terminalCommitRef) runs.set(stored.runId, stored);
      else {
        const match = /^experience\.episode:([^:]+):(.+)$/u.exec(key);
        if (match) runs.set(match[1]!, { runId: match[1]!, terminalCommitRef: match[2]! });
      }
    }
  }
  // Include failed cases cited by the methods as well as selected successes.
  const citedRuns = new Set(oldDerived.flatMap(row => JSON.parse(row.source_refs_json).flatMap((ref: Row) => ref.runId ? [ref.runId] : [])));
  for (const row of episodes.values()) {
    const stored = JSON.parse(row.value_json).v2Episode;
    if (stored?.runId && citedRuns.has(stored.runId) && !runs.has(stored.runId)) runs.set(stored.runId, stored);
    const match = /^experience\.episode:([^:]+):(.+)$/u.exec(row.canonical_key);
    if (match && citedRuns.has(match[1]) && !runs.has(match[1]!)) runs.set(match[1]!, { runId: match[1]!, terminalCommitRef: match[2]! });
  }
  if (!runs.size) throw new Error("memory_rebuild_source_references_missing");
  const evidences: MemorySettlementEvidence[] = [], unavailableRuns: string[] = [];
  for (const { runId, terminalCommitRef } of runs.values()) {
    const evidence = await input.reader.read({ ...input.scope, runId, terminalCommitRef });
    if (!evidence) { unavailableRuns.push(runId); continue; }
    if (evidence.scope.tenantId !== input.scope.tenantId || evidence.scope.ownerUserId !== input.scope.ownerUserId || evidence.runId !== runId) throw new Error("memory_rebuild_source_scope_mismatch");
    evidences.push(evidence);
  }
  if (!evidences.length) throw new Error("memory_rebuild_canonical_evidence_missing");
  input.progress?.(`已读取 ${evidences.length} 个原始 Run；${unavailableRuns.length} 个来源不可用，记录为证据缺口。`);
  const database = await AppDatabase.open({ connection: new SqliteConnection(staged), schema: "none" });
  const now = Date.now();
  try {
    const store = new SqliteMemoryStore(database); await store.ready();
    // A fresh reconstruction may run again after an earlier migration. Do not
    // let its old conclusions stand in for the canonical evidence this time.
    for (const old of oldDerived) await database.prepare("UPDATE local_memory_revisions SET value_json=json_remove(value_json,'$.learningContract') WHERE id=?").run(old.current_revision_id);
    const model: MemorySettlementModel = { modelKey: input.model.modelKey, completeTimeoutMs: input.model.completeTimeoutMs,
      complete: async request => { input.progress?.(`正在按新范式提炼 ${request.runId}（${request.input.stage}）`); return input.model.complete(request); } };
    await settleV2Batch({ store, model, evidences, consolidate: true, now, jobs: evidences.map(evidence => ({
      ...input.scope, runId: evidence.runId, terminalCommitRef: evidence.terminalCommitRef,
      settlementJobId: `rebuild:${evidence.runId}`, status: "processing", attempts: 1, enqueuedAt: now, nextAttemptAt: now,
    })) });
    // Retain superseded bodies, source refs, historical projections and audit Episodes.
    for (const old of oldDerived) await database.prepare(`UPDATE local_memory_items SET status='superseded',updated_at=?
      WHERE id=? AND current_revision_id=?`).run(now, old.id, old.current_revision_id);
  } finally { await database.close(); }
  const prepared = new DatabaseSync(staged, { readOnly: true });
  let next: Row[];
  try { next = entries(prepared, input.scope).filter(row => row.subtype !== "experience.episode"); }
  finally { prepared.close(); }
  if (next!.some(row => JSON.parse(row.value_json).learningContract !== REUSABLE_LEARNING_CONTRACT)) throw new Error("memory_rebuild_legacy_output");
  const manifest: ExperienceRebuildManifest = {
    version: 1, learningContract: REUSABLE_LEARNING_CONTRACT, scope: input.scope, memoryFile: input.memoryFile,
    preparedAt: now, inputHeads: inputHeads!, stagedHash: await fileHash(staged),
    sourceEvidence: evidences.map(evidence => ({ runId: evidence.runId, terminalCommitRef: evidence.terminalCommitRef, hash: digest(evidence) })),
    unavailableRuns,
    before: oldDerived.map(row => ({ id: row.id, revisionId: row.current_revision_id, subtype: row.subtype, title: JSON.parse(row.value_json).taskGroup?.title ?? row.canonical_key })),
    after: next!.map(row => { const value = JSON.parse(row.value_json); return { id: row.id, revisionId: row.current_revision_id, subtype: row.subtype,
      title: value.taskGroup?.title, activation: JSON.parse(row.activation_json), reuse: value.taskGroup?.reuse }; }),
  };
  await writeFile(join(input.directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
  await writeFile(join(input.directory, "experiences.md"), next!.map(row => `${row.id}\n${row.content_markdown}`).join("\n\n---\n\n"), { mode: 0o600, flag: "wx" });
  return manifest;
}

/** A short optimistic transaction switches experience revisions only. Changes
 * to the evidence or selected heads invalidate the prepared replacement;
 * unrelated appended experiences remain in the live database. */
export async function applyExperienceRebuild(directory: string, reader: MemorySettlementReader): Promise<ExperienceRebuildManifest> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as ExperienceRebuildManifest;
  if (manifest.version !== 1 || manifest.learningContract !== REUSABLE_LEARNING_CONTRACT) throw new Error("memory_rebuild_manifest_invalid");
  const staged = join(directory, "prepared.db");
  if (await lstat(join(directory, "applied.json")).catch(() => undefined)) throw new Error("memory_rebuild_already_applied");
  if (await lstat(join(directory, "before-apply.db")).catch(() => undefined)) throw new Error("memory_rebuild_apply_backup_exists");
  if (await fileHash(staged) !== manifest.stagedHash) throw new Error("memory_rebuild_prepared_changed");
  for (const source of manifest.sourceEvidence) {
    const evidence = await reader.read({ ...manifest.scope, runId: source.runId, terminalCommitRef: source.terminalCommitRef });
    if (!evidence || digest(evidence) !== source.hash) throw new Error("memory_rebuild_evidence_changed");
  }
  const db = new DatabaseSync(manifest.memoryFile, { timeout: 5000 });
  try {
    await backup(db, join(directory, "before-apply.db"));
    db.prepare("ATTACH DATABASE ? AS prepared").run(staged);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!unchangedHeads(db, manifest.scope, manifest.inputHeads)) throw new Error("memory_rebuild_experiences_changed");
      const { tenantId, ownerUserId } = manifest.scope;
      db.prepare(`INSERT INTO local_memory_revisions SELECT r.* FROM prepared.local_memory_revisions r
        JOIN prepared.local_memory_items i ON i.id=r.memory_id WHERE i.tenant_id=? AND i.owner_user_id=? AND i.kind='experience'
        AND NOT EXISTS(SELECT 1 FROM local_memory_revisions old WHERE old.id=r.id)`).run(tenantId, ownerUserId);
      db.prepare(`INSERT INTO local_memory_items SELECT * FROM prepared.local_memory_items WHERE tenant_id=? AND owner_user_id=? AND kind='experience'
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,current_revision_id=excluded.current_revision_id,updated_at=excluded.updated_at`).run(tenantId, ownerUserId);
      db.prepare(`INSERT INTO local_memory_settlement_attempts SELECT * FROM prepared.local_memory_settlement_attempts a WHERE tenant_id=? AND owner_user_id=?
        AND NOT EXISTS(SELECT 1 FROM local_memory_settlement_attempts old WHERE old.id=a.id)`).run(tenantId, ownerUserId);
      db.prepare(`INSERT INTO local_memory_epochs(tenant_id,owner_user_id,epoch) VALUES(?,?,1)
        ON CONFLICT(tenant_id,owner_user_id) DO UPDATE SET epoch=epoch+1`).run(tenantId, ownerUserId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
  await writeFile(join(directory, "applied.json"), JSON.stringify({ appliedAt: Date.now(), learningContract: REUSABLE_LEARNING_CONTRACT,
    replaced: manifest.before.map(row => row.id), current: manifest.after.map(row => row.id), schema: SETTLEMENT_V2 }, null, 2), { mode: 0o600, flag: "wx" });
  return manifest;
}
