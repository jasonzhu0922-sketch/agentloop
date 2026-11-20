import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase } from "@zhujun/agentloop";
import { SqliteMemoryStore, REUSABLE_LEARNING_CONTRACT, type MemoryCandidate, type MemorySettlementEvidence, type MemorySettlementModel } from "@zhujun/agentloop-memory";
import { applyExperienceRebuild, prepareExperienceRebuild } from "../src/memory/rebuild-experiences.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
const evidence = (runId: string): MemorySettlementEvidence => ({
  scope: { ...scope, runId }, runId, terminalCommitRef: `outcome:${runId}`, terminalStatus: "completed",
  strategy: "分析指定主体和期间的经营趋势", taskFingerprint: { taskKind: "analysis", domain: "data_analysis", artifactKind: "none" },
  planSkeleton: [{ objective: "核对主体和期间后取数", toolNames: ["source.read"], skillIds: ["discovered:analysis"] }],
  observations: [{ id: "read", kind: "action", toolName: "source.read", status: "succeeded", summary: "核对主体和期间后读取数据，结论与结果一致", sourceRefs: [{ type: "action", runId, sourceId: "read" }] }],
  quality: { terminalCommitted: true, assessmentApproved: true, laterCorrected: false, laterDisputed: false },
  sourceRefs: [{ type: "outcome", runId, sourceHash: `outcome:${runId}` }], occurredAt: 1,
});
const model: MemorySettlementModel = { modelKey: "local:test", complete: async ({ input }) => {
  const episodes = input.episodes as Record<string, any>[];
  const refs = episodes.flatMap(row => row.observations[0].evidenceRefs);
  return { content: JSON.stringify({ schema: "agentloop.semanticSettlement/v2", learningContract: REUSABLE_LEARNING_CONTRACT,
    executionReview: [{ finding: "独立执行核对了当前主体和期间，并读取及验证对应数据", status: "observed", evidenceRefs: refs }],
    reuse: { parameters: [{ name: "subject", description: "当前任务指定主体" }, { name: "period", description: "当前任务指定期间" }], verifiedScope: ["已执行来源中的趋势查询"], unverifiedScope: ["其他来源需要重新核对"] },
    caseFacts: [{ statement: "某次历史任务二月为负值", context: ["原始任务限定期间"], evidenceRefs: refs }],
    learningValue: { status: "actionable", novelty: "new", actionChange: "按当前参数取数和验证", verification: "对象期间与结果一致" },
    title: "按当前主体和期间分析趋势", goalSummary: "查询并验证当前任务的数据趋势", keywords: ["趋势", "查询"], appliesTo: ["可定位实体和期间的数据源"], exclusions: ["来源口径不匹配时需重查"],
    classicPath: [{ objective: "核对 {{subject}} 与 {{period}} 后取数", toolNames: ["source.read"], skillIds: ["discovered:analysis"], conditions: ["已授权来源"], verification: "当前结果完整且计算可复算", evidenceRefs: refs,
      evidenceAssessment: { status: "supported", rationale: "每个引用均包含独立执行的范围核对和读取验证", limitations: [] } }],
    toolUsage: [{ toolName: "source.read", purpose: "按当前参数读取", evidenceRefs: refs }], reusableKnowledge: [], failureLessons: [], cautions: [], recheckRules: ["来源变化重新核对"],
    merge: { decision: "new", supportingEpisodeIds: input.episodeIds, conflicts: [] },
  }) };
} };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-rebuild-")), file = join(directory, "memory.db");
  const db = new AppDatabase(file), store = new SqliteMemoryStore(db); await store.ready();
  const base: MemoryCandidate = { schema: "agentloop.userMemoryCandidate/v1", id: "old-group", ...scope, proposedKind: "experience",
    proposedSubtype: "experience.task_group", proposedCanonicalKey: "old-group", proposedExperienceMaturity: "pattern",
    proposedValue: { taskGroup: { title: "特定主体的历史趋势" }, supportingEpisodeIds: ["experience.episode:one:outcome:one", "experience.episode:two:outcome:two"] },
    proposedContentMarkdown: "二月为负，其余为正", persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal",
    activation: { mode: "explicit_only" }, applicationTargets: ["planner"], sourceRefs: ["one", "two"].map(runId => ({ type: "outcome" as const, runId })), confidence: 0.7, reason: "old", decision: "accepted" };
  await store.commit(scope, base, 1);
  await store.commit(scope, { ...base, id: "old-procedure", proposedSubtype: "experience.procedure", proposedCanonicalKey: "old-procedure", proposedExperienceMaturity: "procedure" }, 1);
  const foreign = { tenantId: "device", ownerUserId: "bob" };
  await store.commit(foreign, { ...base, ...foreign, id: "bob-group" }, 1);
  await store.commit(scope, { ...base, id: "preference", proposedKind: "preference", proposedSubtype: "writing.language", proposedCanonicalKey: "writing.language", proposedExperienceMaturity: undefined,
    proposedPreferenceEffect: "default", proposedValue: { language: "中文" }, authority: "explicit_user", persistenceIntent: "explicit", sourceRefs: [{ type: "user_message", runId: "one" }] }, 1);
  await db.close();
  let changed = false;
  const reader = { read: async ({ runId }: { runId: string }) => ({ ...evidence(runId), ...(changed ? { strategy: "后续任务已纠正" } : {}) }) };
  return { directory, file, base, reader, changeEvidence: () => { changed = true; } };
}

test("rebuild stages canonical evidence then atomically replaces only the selected account's experiences", async () => {
  const f = await fixture(), prepared = join(f.directory, "prepared");
  const before = new DatabaseSync(f.file, { readOnly: true });
  const oldRows = before.prepare("SELECT * FROM local_memory_items ORDER BY id").all(); before.close();
  const manifest = await prepareExperienceRebuild({ memoryFile: f.file, directory: prepared, scope, reader: f.reader, model });
  const pending = new DatabaseSync(f.file, { readOnly: true });
  assert.deepEqual(pending.prepare("SELECT * FROM local_memory_items ORDER BY id").all(), oldRows, "preparation never mutates live memory"); pending.close();
  assert.equal(manifest.before.length, 2); assert.equal(manifest.after.length, 2);
  await applyExperienceRebuild(prepared, f.reader);
  const current = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.equal(current.prepare("SELECT count(*) AS n FROM local_memory_items WHERE owner_user_id='alice' AND status='superseded'").get()!.n, 2);
    assert.equal(current.prepare("SELECT count(*) AS n FROM local_memory_items WHERE owner_user_id='bob' AND status='active'").get()!.n, 1);
    assert.equal(current.prepare("SELECT count(*) AS n FROM local_memory_items WHERE kind='preference' AND status='active'").get()!.n, 1);
    assert.equal(current.prepare("SELECT count(*) AS n FROM local_memory_revisions WHERE content_markdown='二月为负，其余为正'").get()!.n, 4);
    const row = current.prepare("SELECT r.value_json FROM local_memory_items i JOIN local_memory_revisions r ON r.id=i.current_revision_id WHERE i.owner_user_id='alice' AND i.subtype='experience.procedure' AND i.status='active'").get()!;
    const value = JSON.parse(row.value_json as string);
    assert.equal(value.learningContract, REUSABLE_LEARNING_CONTRACT);
    assert.doesNotMatch(JSON.stringify(value.settlementPattern), /二月为负/);
    assert.match(JSON.stringify(value.taskGroup.caseFacts), /二月为负/);
    assert.equal(JSON.parse(await readFile(join(prepared, "applied.json"), "utf8")).replaced.length, 2);
  } finally { current.close(); }
});

test("rebuild rejects changed canonical evidence and concurrent experience writes without partially switching memory", async () => {
  for (const conflict of ["evidence", "experience"] as const) {
    const f = await fixture(), prepared = join(f.directory, "prepared");
    await prepareExperienceRebuild({ memoryFile: f.file, directory: prepared, scope, reader: f.reader, model });
    if (conflict === "evidence") f.changeEvidence();
    else {
      const db = new AppDatabase(f.file), store = new SqliteMemoryStore(db);
      await store.commit(scope, { ...f.base, id: "concurrent", proposedContentMarkdown: "新经验修订" }, 2); await db.close();
    }
    await assert.rejects(applyExperienceRebuild(prepared, f.reader), /memory_rebuild_(evidence|experiences)_changed/);
    const db = new DatabaseSync(f.file, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS n FROM local_memory_items WHERE status='superseded'").get()!.n, 0); db.close();
  }
});

test("an interrupted rebuild resumes its private copy without overwriting the original backup", async () => {
  const f = await fixture(), directory = join(f.directory, "interrupted");
  await assert.rejects(prepareExperienceRebuild({ memoryFile: f.file, directory, scope, reader: f.reader,
    model: { modelKey: "local:unavailable", complete: async () => { throw new Error("unavailable"); } } }), /model_unavailable/);
  const original = await readFile(join(directory, "before.db"));
  const result = await prepareExperienceRebuild({ memoryFile: f.file, directory, scope, reader: f.reader, model, resume: true });
  assert.equal(result.after.length, 2);
  assert.deepEqual(await readFile(join(directory, "before.db")), original);
  await applyExperienceRebuild(directory, f.reader);
  await assert.rejects(applyExperienceRebuild(directory, f.reader), /memory_rebuild_already_applied/);
});

test("concurrent appended experiences remain intact while the selected old versions are replaced", async () => {
  const f = await fixture(), directory = join(f.directory, "prepared");
  await prepareExperienceRebuild({ memoryFile: f.file, directory, scope, reader: f.reader, model });
  const db = new AppDatabase(f.file), store = new SqliteMemoryStore(db);
  const added = await store.commit(scope, { ...f.base, id: "new-unrelated", proposedCanonicalKey: "new-unrelated", proposedContentMarkdown: "维护期间产生的新经验" }, 2);
  await db.close();
  await applyExperienceRebuild(directory, f.reader);
  const live = new DatabaseSync(f.file, { readOnly: true });
  try { assert.equal(live.prepare("SELECT current_revision_id FROM local_memory_items WHERE id=?").get(added.item.id)!.current_revision_id, added.revision.id); }
  finally { live.close(); }
});
