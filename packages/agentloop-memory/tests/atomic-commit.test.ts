import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { InMemoryMemoryStore, SqliteMemoryStore } from "../src/index.ts";
import type { MemoryCandidate, MemoryStore } from "../src/types.ts";
const scope = { tenantId: "device", ownerUserId: "alice" };
function candidate(key: string, expected: string | null = null): MemoryCandidate {
  return { schema: "agentloop.userMemoryCandidate/v1", id: key, ...scope, proposedKind: "experience", proposedSubtype: "experience.independent_knowledge",
    proposedCanonicalKey: key, proposedValue: { key }, proposedContentMarkdown: key, proposedExperienceMaturity: "pattern",
    persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal", activation: { mode: "explicit_only" }, applicationTargets: ["execution"],
    sourceRefs: [{ type: "action", runId: "source" }], confidence: 0.7, reason: "test", decision: "accepted", expectedCurrentRevisionId: expected };
}
for (const backend of ["memory", "sqlite"] as const) test(`${backend}: CAS batch rolls back every revision and epoch, including an absent-key race`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined; t.after(() => db?.close());
  const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  const initial = await store.commit(scope, candidate("existing"), 1), epoch = await store.currentEpoch(scope);
  await assert.rejects(store.commitBatch(scope, [candidate("new"), candidate("existing")], 2), /revision_conflict/);
  assert.equal(await store.currentEpoch(scope), epoch);
  assert.deepEqual((await store.active(scope)).map(row => row.revision.id), [initial.revision.id]);
  const result = await store.commitBatch(scope, [candidate("new"), candidate("existing", initial.revision.id)], 3);
  assert.equal(result.length, 2); assert.equal(await store.currentEpoch(scope), epoch + 2);
  await assert.rejects(store.commitBatch(scope, [candidate("third"), candidate("existing", initial.revision.id)], 4), /revision_conflict/);
  assert.equal((await store.active(scope)).length, 2);
});
