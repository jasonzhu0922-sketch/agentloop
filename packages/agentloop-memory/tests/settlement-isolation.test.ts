import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase, type PlanningMemoryProjection } from "@zhujun/agentloop";
import { InMemoryMemoryStore, SqliteMemoryStore, MemorySettlementWorker, SETTLEMENT_V2, REUSABLE_LEARNING_CONTRACT } from "../src/index.ts";
import type { MemorySettlementEvidence, MemorySettlementModel, MemoryStore } from "../src/types.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
function evidence(runId: string, domain: string): MemorySettlementEvidence {
  return { scope: { ...scope, runId }, runId, terminalCommitRef: `outcome:${runId}`, terminalStatus: "completed",
    strategy: domain === "code" ? "Reproduce a bug and verify its repair" : "Render a document and inspect every page",
    taskFingerprint: { taskKind: "execute", domain },
    planSkeleton: [{ objective: "Execute and verify the current workflow", toolNames: ["workflow.execute"], skillIds: [] }],
    observations: [{ id: "action", kind: "action", stepOrder: 1, toolName: "workflow.execute", status: "succeeded", summary: "Executed and verified the current workflow",
      sourceRefs: [{ type: "action", runId, sourceId: "action" }] }],
    quality: { terminalCommitted: true, assessmentApproved: true, laterCorrected: false, laterDisputed: false },
    sourceRefs: [{ type: "outcome", runId, sourceHash: `outcome:${runId}` }], occurredAt: 1000 };
}
function projection(runId: string): PlanningMemoryProjection {
  return { schema: "agentloop.memoryProjection/v1", id: `projection:${runId}`, runId, target: "planner", memoryEpoch: 1,
    memoryRevisionIds: ["method"], retrievalReasons: [], contentHash: "hash", createdAt: 1, expiresAt: 10,
    relevantFacts: [], preferenceConstraints: [], planningPriors: [{ schema: "agentloop.planningPrior/v1", id: "prior", source: "experience_procedure",
      applicability: "Check the current workflow", strategy: "Check the current workflow", suggestedSteps: [{ objective: "Check the current workflow" }],
      evidenceExpectations: [], warnings: [], confidence: 0.7, sourceRefs: ["method"], knowledgeBindings: [{ knowledgeId: "path", section: "classicPath" }] }] };
}
function learning(input: Record<string, any>, invalid: boolean) {
  const refs = Object.keys(input.sources).filter(ref => /^episode_\d+_observation_1$/.test(ref));
  return { schema: SETTLEMENT_V2, learningContract: REUSABLE_LEARNING_CONTRACT,
    executionReview: [{ finding: "The workflow ran and its result was verified", status: "observed", evidenceRefs: refs }],
    reuse: { parameters: [], verifiedScope: ["Current workflow and verification"], unverifiedScope: ["Other environments"] }, caseFacts: [],
    learningValue: { status: "actionable", novelty: "new", actionChange: "Execute the current workflow and verify the result", verification: "Current result has passed the check" },
    title: "Execute and verify a workflow", goalSummary: "Execute the workflow and check current evidence", keywords: [], appliesTo: ["The current workflow is available"], exclusions: [],
    classicPath: [{ objective: "Execute the workflow and verify the current result", toolNames: [invalid ? "invented.tool" : "workflow.execute"], skillIds: [], conditions: [], verification: "Current result is verified", evidenceRefs: refs,
      evidenceAssessment: { status: "supported", rationale: "The current operation and verification support this workflow", evidenceRefs: refs, limitations: [] } }],
    toolUsage: [], reusableKnowledge: [], failureLessons: [], cautions: [], recheckRules: [],
    merge: { decision: "new", supportingEpisodeIds: input.episodeIds, conflicts: [] } };
}

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: a rejected family cannot lose later Episodes, successful families, or application reviews`, async t => {
    const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
    t.after(() => db?.close());
    const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
    const values = [evidence("bad", "code"), evidence("good1", "documents"), evidence("good2", "documents")];
    let fusionCalls = 0, reviewCalls = 0;
    const settlementModel: MemorySettlementModel = { modelKey: "local:test", complete: async ({ input }) => {
      const request = input as Record<string, any>;
      if (request.stage === "memory_application") {
        reviewCalls++;
        return { content: JSON.stringify({ schema: "agentloop.memoryApplicationReview/v1", applications: request.knowledge.map((item: any) => ({ memoryId: item.memoryId,
          adoption: "unknown", effect: "unverified", reason: "There is no explicit method handoff in this historical execution", observationIds: [] })) }) };
      }
      assert.equal(request.stage, "fusion"); fusionCalls++;
      // This check happens INSIDE the first model call, before any later family.
      assert.equal((await store.active(scope)).filter(entry => entry.item.subtype === "experience.episode").length, 3);
      return { content: JSON.stringify(learning(request, request.episodes[0].fingerprint.domain === "code")) };
    } };
    for (const value of values) {
      await store.recordProjection(scope, projection(value.runId));
      await store.enqueueSettlement({ scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now: 1000 });
    }
    const worker = new MemorySettlementWorker({ store, reader: { read: async ({ runId }) => values.find(value => value.runId === runId) },
      settlementModel, requireSettlementModel: true, consolidate: true, experienceBatchSize: 3, maxBatchWaitMs: 0, now: () => 1000 });
    const result = await worker.runOnce();
    assert.equal(result.status, "dead_letter");
    assert.match(result.reason!, /tool_not_admitted/);
    assert.equal(result.outcomes!.filter(item => item.status === "succeeded").length, 2);
    assert.equal(fusionCalls, 3); assert.equal(reviewCalls, 3);
    assert.equal((await store.settlementJobs(scope, "bad"))[0]!.status, "dead_letter");
    for (const runId of ["good1", "good2"]) assert.equal((await store.settlementJobs(scope, runId))[0]!.status, "succeeded");
    for (const value of values) assert.equal((await store.applicationReviews(scope, value.runId))[0]!.status, "accepted");
    const active = await store.active(scope);
    assert.equal(active.filter(entry => entry.item.subtype === "experience.procedure").length, 1);
    assert.deepEqual((active.find(entry => entry.item.subtype === "experience.task_group")!.revision.value.successfulRunIds as string[]).toSorted(), ["good1", "good2"]);
    // Replay only the successful family. Its durable fusion/review checkpoints
    // prevent another model call and prevent duplicate support.
    for (const runId of ["good1", "good2"]) await store.replaySettlement(scope, runId, 1000);
    assert.equal((await worker.runOnce()).status, "succeeded");
    assert.equal(fusionCalls, 3); assert.equal(reviewCalls, 3);
  });
}

test("a failed grouping bucket leaves its audit evidence and does not block another task family", async () => {
  const store = new InMemoryMemoryStore();
  const values = [evidence("broken-a", "code"), { ...evidence("broken-b", "code"), strategy: "A different repair goal" }, evidence("document", "documents")];
  for (const value of values) await store.enqueueSettlement({ scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now: 1 });
  const worker = new MemorySettlementWorker({ store, reader: { read: async ({ runId }) => values.find(value => value.runId === runId) },
    settlementModel: { modelKey: "local:test", complete: async ({ input }) => {
      const request = input as any;
      return { content: request.stage === "grouping" ? "{}" : JSON.stringify(learning(request, false)) };
    } }, consolidate: true, experienceBatchSize: 3, now: () => 1000 });
  const result = await worker.runOnce();
  assert.equal((await store.settlementJobs(scope, "document"))[0]!.status, "succeeded");
  assert.equal(result.outcomes!.filter(item => item.status === "dead_letter").length, 2);
  assert.equal((await store.active(scope)).filter(entry => entry.item.subtype === "experience.episode").length, 3);
});

test("a retryable review keeps its retry budget when the same job's fusion is permanently rejected", async () => {
  const store = new InMemoryMemoryStore(), value = evidence("both-fail", "code");
  await store.recordProjection(scope, projection(value.runId));
  await store.enqueueSettlement({ scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now: 1 });
  let now = 1000, reviewCalls = 0;
  const worker = new MemorySettlementWorker({ store, reader: { read: async () => value }, now: () => now,
    consolidate: true, experienceBatchSize: 10, maxBatchWaitMs: 0,
    settlementModel: { modelKey: "local:test", complete: async ({ input }) => {
      const request = input as any;
      if (request.stage === "memory_application") {
        if (++reviewCalls === 1) throw new Error("temporarily_offline");
        return { content: JSON.stringify({ schema: "agentloop.memoryApplicationReview/v1", applications: request.knowledge.map((row: any) => ({ memoryId: row.memoryId,
          adoption: "unknown", effect: "unverified", reason: "No matching handoff", observationIds: [] })) }) };
      }
      return { content: JSON.stringify(learning(request, true)) };
    } } });
  assert.equal((await worker.runOnce()).status, "retrying");
  now = 100_000;
  assert.equal((await worker.runOnce()).status, "dead_letter", "fusion remains rejected after review recovers");
  assert.equal(reviewCalls, 2);
  assert.ok((await store.applicationReviews(scope, value.runId)).some(review => review.status === "accepted"));
  assert.equal((await store.active(scope)).filter(row => row.item.subtype === "experience.episode").length, 1);
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: an accepted no-learning checkpoint survives a separate review failure and worker recreation`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
  t.after(() => db?.close());
  const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  const value = evidence("review-retry", "code");
  await store.recordProjection(scope, projection(value.runId));
  await store.enqueueSettlement({ scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now: 1 });
  let now = 1000, fusionCalls = 0, reviewCalls = 0;
  const model: MemorySettlementModel = { modelKey: "local:checkpoint", complete: async ({ input }) => {
    const request = input as any;
    if (request.stage === "memory_application") {
      if (++reviewCalls === 1) return { content: "malformed review" };
      return { content: JSON.stringify({ schema: "agentloop.memoryApplicationReview/v1", applications: request.knowledge.map((row: any) => ({ memoryId: row.memoryId,
        adoption: "unknown", effect: "unverified", reason: "No checked current adoption", observationIds: [] })) }) };
    }
    fusionCalls++;
    const output = learning(request, false);
    return { content: JSON.stringify({ ...output, classicPath: [], learningValue: { status: "insufficient", reason: "No independently reusable change" },
      merge: { decision: "no_learning", supportingEpisodeIds: [], conflicts: [] } }) };
  } };
  const worker = () => new MemorySettlementWorker({ store, reader: { read: async () => value }, now: () => now, consolidate: true,
    experienceBatchSize: 10, maxBatchWaitMs: 0, settlementModel: model });
  assert.equal((await worker().runOnce()).status, "retrying");
  now = 100_000;
  assert.equal((await worker().runOnce()).status, "succeeded");
  assert.equal(fusionCalls, 1, "a separate review failure cannot force another accepted fusion");
  assert.equal(reviewCalls, 2);
  const accepted = (await store.settlementAttempts(scope, value.runId)).filter(row => row.stage === "fusion" && row.status === "accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.learningInputHash?.length, 64);
  assert.equal((accepted[0]!.learning as any).merge.decision, "no_learning");
  const failures = (await store.settlementAttempts(scope, value.runId)).filter(row => row.stage === "settlement");
  assert.equal(failures.length, 1, "a successful retry must preserve the first worker failure");
  assert.equal(failures[0]!.errors[0]!.code, "memory_application_review:json_invalid");
});

test("a validated correction survives interruption before the group commit without overwriting request hashes", async () => {
  const store = new InMemoryMemoryStore(), value = evidence("commit-retry", "code"), commitBatch = store.commitBatch.bind(store);
  await store.enqueueSettlement({ scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now: 1 });
  let now = 1000, calls = 0, interrupted = false;
  store.commitBatch = async (...args) => {
    if (!interrupted && args[1].some(candidate => candidate.proposedSubtype === "experience.task_group")) { interrupted = true; throw new Error("publication unavailable"); }
    return commitBatch(...args);
  };
  const worker = new MemorySettlementWorker({ store, reader: { read: async () => value }, now: () => now, consolidate: true,
    experienceBatchSize: 10, maxBatchWaitMs: 0, settlementModel: { modelKey: "local:checkpoint", complete: async ({ input }) => {
      const request = input as any, output = learning(request, false); calls++;
      if (calls === 1) output.reuse.verifiedScope = [];
      return { content: JSON.stringify(output) };
    } } });
  assert.equal((await worker.runOnce()).status, "retrying");
  now = 100_000;
  assert.equal((await worker.runOnce()).status, "succeeded");
  assert.equal(calls, 2, "retry reuses the accepted correction even though the group was never committed");
  const attempts = await store.settlementAttempts(scope, value.runId);
  assert.notEqual(attempts[0]!.inputHash, attempts[1]!.inputHash, "correction request retains its own audit hash");
  assert.ok(attempts[1]!.learning);
});
