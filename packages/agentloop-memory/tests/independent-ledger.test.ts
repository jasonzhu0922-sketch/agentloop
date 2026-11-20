import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { InMemoryMemoryStore, SqliteMemoryStore } from "../src/index.ts";
import { commitKnowledgeCase, INDEPENDENT_KNOWLEDGE } from "../src/independent-knowledge.ts";
import type { MemoryCandidate, MemoryStore } from "../src/types.ts";
const scope = { tenantId: "device", ownerUserId: "alice" };
function operation(store: MemoryStore, key: string, admitted: any[] = [], decision = "support", word = "Inspect current input") {
  const refs = [{ type: "action" as const, runId: key, sourceId: "inspect" }];
  const group: MemoryCandidate = { schema: "agentloop.userMemoryCandidate/v1", id: key, ...scope, proposedKind: "experience", proposedSubtype: "experience.task_group",
    proposedCanonicalKey: key, proposedValue: { knowledgeUnits: [] }, proposedContentMarkdown: key, proposedExperienceMaturity: "pattern",
    persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal", activation: { mode: "explicit_only" }, applicationTargets: ["planner"],
    sourceRefs: refs, confidence: 0.7, reason: "test", decision: "accepted", expectedCurrentRevisionId: null };
  const learning = { classicPath: [], failureLessons: [], reuse: { parameters: [] }, appliesTo: [], exclusions: [],
    reusableKnowledge: [{ standalone: true, kind: "method", rule: word, conditions: ["Current input is available"], exclusions: [], evidenceRefs: ["operation"],
      evidenceAssessment: { status: "supported", rationale: "The current operation inspected this input", limitations: [], evidenceRefs: ["operation"] } }],
    knowledgeRelations: admitted.length ? [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: admitted[0].knowledgeId, decision, rationale: "Same scoped method" }] : [] };
  return commitKnowledgeCase({ store, scope, group, learning, admitted, sources: { operation: refs },
    episodes: [{ runId: key, executionKey: `run:${key}`, evidenceHash: key, outcome: "verified_success", independent: true }], now: 1000 });
}
const ledger = async (store: MemoryStore) => (await store.active(scope)).filter(row => row.item.subtype === INDEPENDENT_KNOWLEDGE);
const inventory = (row: any) => [{ knowledgeId: row.revision.value.knowledgeUnit.id, definitionVersion: row.revision.value.definitionVersion }];
for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: concurrent support retains both executions; stale definition comparison cannot commit a case`, async t => {
    const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined; t.after(() => db?.close());
    const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
    await operation(store, "first"); const initial = (await ledger(store))[0]!, admitted = inventory(initial);
    await Promise.all([operation(store, "second", admitted), operation(store, "third", admitted)]);
    let records = await ledger(store); assert.equal(records.length, 1);
    assert.deepEqual(new Set((records[0]!.revision.value.knowledgeUnit as any).supports.map((row: any) => row.runId)), new Set(["first", "second", "third"]));
    await operation(store, "revision", admitted, "revise");
    records = await ledger(store); assert.equal(records[0]!.revision.value.definitionVersion, 2);
    assert.deepEqual((records[0]!.revision.value.knowledgeUnit as any).supports.map((row: any) => row.runId), ["revision"], "even a same-text revision starts validation again");
    const epoch = await store.currentEpoch(scope);
    await assert.rejects(operation(store, "stale", admitted), /independent_knowledge_definition_conflict/);
    assert.equal(await store.currentEpoch(scope), epoch);
    assert.equal((await store.active(scope)).some(row => row.item.canonicalKey === "stale"), false);
  });
  test(`${backend}: an unassociated claim cannot overwrite or implicitly support an occupied identity`, async t => {
    const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined; t.after(() => db?.close());
    const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
    await operation(store, "first"); const initial = (await ledger(store))[0]!;
    await operation(store, "revision", inventory(initial), "revise", "Inspect a changed contract");
    await operation(store, "unassociated");
    const records = await ledger(store); assert.equal(records.length, 2);
    const original = records.find(row => row.item.id === initial.item.id)!;
    assert.equal((original.revision.value.knowledgeUnit as any).content.rule, "Inspect a changed contract");
    assert.deepEqual((original.revision.value.knowledgeUnit as any).supports.map((row: any) => row.runId), ["revision"]);
    assert.equal(new Set(records.map(row => (row.revision.value.knowledgeUnit as any).id)).size, 2);
  });
}

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: canonical source invalidation is applied before new cross-case support`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined; t.after(() => db?.close());
  const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  await operation(store, "first"); const initial = (await ledger(store))[0]!;
  await store.invalidateRun(scope, "first", { type: "user_feedback", runId: "first" }, 1100);
  await operation(store, "second", inventory(initial));
  const current = (await ledger(store))[0]!.revision.value.knowledgeUnit as any;
  assert.deepEqual(current.supports.map((row: any) => row.runId), ["second"]);
  assert.equal(current.status, "candidate", "a fresh assessment cannot validate a method by counting a revoked execution");
});
