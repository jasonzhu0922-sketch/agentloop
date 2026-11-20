import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { createMemoryPlugin, InMemoryMemoryStore, SqliteMemoryStore, settleV2Batch, SETTLEMENT_V2, REUSABLE_LEARNING_CONTRACT } from "../src/index.ts";
import type { MemorySettlementEvidence, MemorySettlementModel, MemoryStore } from "../src/types.ts";
import { settleV2 } from "../src/semantic-v2.ts";
import { comparisonFixture } from "./fixtures/knowledge-comparison.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
function evidence(runId: string, domain: string): MemorySettlementEvidence {
  return { scope: { ...scope, runId }, runId, terminalCommitRef: `outcome:${runId}`, terminalStatus: "completed",
    strategy: "Inspect the current resource contract before processing", taskFingerprint: { taskKind: "execute", domain },
    taskRequest: { text: "Process the current input under its contract", authority: "user_request", complete: true },
    observations: [{ id: "operation", kind: "action", toolName: "resource.inspect", status: "succeeded", summary: "Inspected current contract and verified the input",
      sourceRefs: [{ type: "action", runId, sourceId: "inspect" }] }],
    quality: { terminalCommitted: true, assessmentApproved: true, laterCorrected: false, laterDisputed: false },
    sourceRefs: [{ type: "outcome", runId, sourceHash: `outcome:${runId}` }], occurredAt: 1 };
}
function proposal(input: any, decision = "support"): any {
  const refs = Object.keys(input.sources).filter(ref => /^(?:episode_\d+_)?observation_1$/u.test(ref));
  const old = input.similarTaskGroups?.[0], oldUnit = input.independentKnowledge?.[0] ?? old?.knowledge?.find((unit: any) => unit.section === "reusableKnowledge");
  return { schema: SETTLEMENT_V2, learningContract: REUSABLE_LEARNING_CONTRACT,
    executionReview: [{ finding: "The current operation inspected and checked the resource contract", status: "observed", evidenceRefs: refs }],
    reuse: { parameters: [], verifiedScope: ["The inspected contract"], unverifiedScope: ["Other contracts"] }, caseFacts: [],
    title: "Inspect current resource contract", goalSummary: "Inspect the current resource contract before processing", keywords: ["resource", "contract", "inspect"],
    appliesTo: ["The current resource provides a contract"], exclusions: [],
    learningValue: { status: "actionable", novelty: old ? "reinforcement" : "new", actionChange: "Check the current contract before processing", verification: "Current input conforms to its contract" },
    classicPath: [], toolUsage: [], failureLessons: [], cautions: [], recheckRules: [],
    reusableKnowledge: [{ standalone: true, kind: "method", rule: old ? "Read the specification before working on the new input" : "Inspect the current resource contract before processing",
      trigger: "A new input arrives", action: "Inspect the current contract", verification: "Current input conforms to the contract", operation: "inspect --current-contract",
      conditions: ["A current authorized contract is available"], exclusions: ["No current contract is available"], recheckRules: [], evidenceRefs: refs,
      evidenceAssessment: { status: decision === "contradict" ? "contradicted" : "supported", rationale: "The current action directly exercises this method", evidenceRefs: refs, limitations: [] } }],
    ...(oldUnit ? { knowledgeRelations: [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: oldUnit.knowledgeId, decision, rationale: "Compare the same method using current execution evidence" }] } : {}),
    ...(input.stage === "fusion" ? { merge: { decision: old ? decision === "support" ? "reinforce" : "refine" : "new", ...(old ? { targetGroupId: old.id } : {}), supportingEpisodeIds: input.episodeIds, conflicts: [] } } : {}) };
}
async function settle(store: MemoryStore, runId: string, domain: string, decision = "support", invalidTarget = false, overrides: Partial<MemorySettlementEvidence> = {}, single = false) {
  const value = { ...evidence(runId, domain), ...overrides };
  const model: MemorySettlementModel = { modelKey: "fixture:continuity", complete: async ({ input }) => {
    const request = input as any;
    if (request.stage === "selection") return { content: JSON.stringify({ matches: request.candidates.map((row: any) => ({ id: row.id, relevance: 0.99 })) }) };
    if (request.episodes?.[0]?.taskRequest) assert.equal(request.episodes[0].taskRequest.authority, "user_request");
    const output = proposal(request, decision === "additional" ? "support" : decision);
    if (decision === "additional") {
      output.reusableKnowledge[0].rule = "Inspect output encoding separately from the resource contract";
      output.reusableKnowledge[0].action = "Check output encoding";
      output.knowledgeRelations = [];
      if (output.merge) output.merge.decision = "refine";
    }
    if (invalidTarget && output.knowledgeRelations?.length) output.knowledgeRelations[0].targetKnowledgeId = "unadmitted-knowledge";
    return { content: JSON.stringify(comparisonFixture(request, output)) };
  } };
  const job = { ...scope, runId, terminalCommitRef: value.terminalCommitRef,
    settlementJobId: `job:${runId}`, enqueuedAt: 1, status: "processing" as const, attempts: 1, nextAttemptAt: 1 };
  return single ? settleV2({ store, model, evidence: value, job, consolidate: true, now: 1000 })
    : settleV2Batch({ store, model, evidences: [value], jobs: [job], consolidate: true, now: 1000 });
}
for (const backend of ["memory", "sqlite"] as const) for (const domain of ["documents", "coding", "external_api", "data_analysis"]) {
  test(`${backend}/${domain}: paraphrased support publishes a subtask method and revised or contradicted knowledge stops recall`, async t => {
    const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined; t.after(() => db?.close());
    const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
    await settle(store, "one", domain);
    assert.equal((await store.active(scope)).filter(entry => entry.item.subtype === "experience.knowledge").length, 0);
    await settle(store, "two", domain);
    const active = await store.active(scope), card = active.find(entry => entry.item.subtype === "experience.knowledge")!;
    assert.ok(card, "a supported independent subtask does not need a complete classic path");
    const units = card.revision.value.knowledgeUnits as any[];
    assert.deepEqual(units[0].supports.map((support: any) => support.runId), ["one", "two"]);
    const group = active.find(entry => entry.item.subtype === "experience.task_group")!;
    assert.equal((group.revision.value.taskGroup as any).classicPath.length, 0);
    const plugin = createMemoryPlugin({ store, now: () => 2000, resolveRunScope: async runId => ({ ...scope, runId }) });
    const query = { runId: "next", target: "execution" as const, stepContext: { goal: "Inspect current resource contract", knowledgeOnly: true }, budget: { maxItems: 4, maxTokens: 1600 } };
    const recalled = await plugin.recall(query);
    assert.equal(recalled?.target === "execution" && recalled.knowledgeCards?.[0]?.knowledgeId, units[0].id);
    await settle(store, "three", domain, "revise");
    assert.equal(await plugin.recall(query), undefined, "the revised method requires fresh independent support");
    await settle(store, "four", domain);
    const revised = await plugin.recall(query);
    assert.equal(revised?.target === "execution" && revised.knowledgeCards?.[0]?.knowledgeId, units[0].id, "revision preserves identity");
    await settle(store, "five", domain, "contradict");
    assert.equal(await plugin.recall(query), undefined, "counterevidence retracts this knowledge without a group-wide success claim");
  });
}
test("a model cannot select a knowledge identity outside the admitted inventories", async () => {
  const store = new InMemoryMemoryStore();
  await settle(store, "one", "coding");
  await assert.rejects(settle(store, "two", "coding", "support", true), /knowledge_not_admitted/u);
});

test("adding an independent candidate does not suspend a previously verified independent method", async () => {
  const store = new InMemoryMemoryStore();
  await settle(store, "one", "documents"); await settle(store, "two", "documents");
  const old = (await store.active(scope)).find(entry => entry.item.subtype === "experience.knowledge")!;
  const oldId = (old.revision.value.taskKnowledge as any).knowledgeId;
  await settle(store, "three", "documents", "additional");
  const plugin = createMemoryPlugin({ store, now: () => 2000, resolveRunScope: async runId => ({ ...scope, runId }) });
  const recall = await plugin.recall({ runId: "next", target: "execution", stepContext: { goal: "Inspect current resource contract", knowledgeOnly: true }, budget: { maxItems: 4, maxTokens: 1600 } });
  assert.equal(recall?.target === "execution" && recall.knowledgeCards?.[0]?.knowledgeId, oldId);
  assert.equal(recall?.target === "execution" && recall.knowledgeCards?.[0]?.memoryRevisionId, old.revision.id, "an unrelated group change does not republish unchanged knowledge");
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: different task families accumulate one independent method, revisions cannot be revived by old cases`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined; t.after(() => db?.close());
  const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  await settle(store, "document", "documents");
  await settle(store, "code", "coding");
  const active = await store.active(scope), ledgers = active.filter(row => row.item.subtype === "experience.independent_knowledge");
  assert.equal(active.filter(row => row.item.subtype === "experience.task_group").length, 2, "task families remain separate");
  assert.equal(ledgers.length, 1, "the model can match an independent method across task families");
  const unit = ledgers[0]!.revision.value.knowledgeUnit as any;
  assert.deepEqual(unit.supports.map((row: any) => row.runId), ["document", "code"]);
  const cards = active.filter(row => row.item.subtype === "experience.knowledge");
  assert.equal(cards.length, 1); assert.equal(cards[0]!.item.canonicalKey, `experience.knowledge:${unit.id}`);
  assert.equal((ledgers[0]!.revision.value.caseGroupKeys as string[]).length, 2);
  const comparison = (await store.settlementAttempts(scope, "code")).find(row => row.comparison)!.comparison as any;
  assert.equal(comparison.merge.decision, "new"); assert.equal(comparison.knowledgeRelations[0].decision, "support");
  const plugin = createMemoryPlugin({ store, now: () => 2000, resolveRunScope: async runId => ({ ...scope, runId }) });
  const query = { runId: "next", target: "execution" as const, stepContext: { goal: "Inspect current resource contract", knowledgeOnly: true }, budget: { maxItems: 4, maxTokens: 1600 } };
  assert.equal((await plugin.recall(query))?.target, "execution");
  await settle(store, "code", "coding");
  assert.equal(((await store.active(scope)).find(row => row.item.subtype === "experience.independent_knowledge")!.revision.value.knowledgeUnit as any).supports.length, 2, "replay does not add independent support");
  await settle(store, "inherited", "external_api", "support", false, { dependencies: [{ kind: "prior_result", sourceRunId: "code" }] as any });
  assert.equal(((await store.active(scope)).find(row => row.item.subtype === "experience.independent_knowledge")!.revision.value.knowledgeUnit as any).supports.length, 2, "inherited results cannot add support");
  await settle(store, "revision", "research", "revise");
  assert.equal(await plugin.recall(query), undefined);
  await settle(store, "document", "documents");
  assert.equal(await plugin.recall(query), undefined, "an old group's publication checkpoint cannot revive the pre-revision definition");
  await settle(store, "fresh", "external_api");
  const renewed = await plugin.recall(query);
  assert.equal(renewed?.target === "execution" && renewed.knowledgeCards?.[0]?.knowledgeId, unit.id);
  await settle(store, "counter", "another_domain", "contradict");
  assert.equal(await plugin.recall(query), undefined);
  await assert.rejects(settle(store, "stale-support", "third_domain"), /knowledge_revision_required/);
  await settle(store, "document", "documents");
  assert.equal(await plugin.recall(query), undefined, "old cases cannot remove a contradiction");
});

test("an unrelated group revision during recall does not retract independent knowledge", async () => {
  const store = new InMemoryMemoryStore(); await settle(store, "one", "documents"); await settle(store, "two", "coding");
  const plugin = createMemoryPlugin({ store, now: () => 2000, resolveRunScope: async runId => ({ ...scope, runId }), recallModel: {
    modelKey: "concurrent-group", complete: async ({ input }) => {
      const group = (await store.active(scope)).find(row => row.item.subtype === "experience.task_group")!;
      await store.commit(scope, { schema: "agentloop.userMemoryCandidate/v1", id: "group-change", ...scope,
        proposedKind: "experience", proposedSubtype: group.item.subtype, proposedCanonicalKey: group.item.canonicalKey,
        proposedValue: { ...group.revision.value, conflicted: true }, proposedContentMarkdown: "Case changed", persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal",
        proposedExperienceMaturity: "pattern", activation: { mode: "explicit_only" }, applicationTargets: ["planner"], sourceRefs: group.revision.sourceRefs,
        confidence: 0.7, reason: "case revision", decision: "accepted", expectedCurrentRevisionId: group.revision.id }, 1500);
      return { content: JSON.stringify({ matches: (input as any).candidates.map((row: any) => ({ id: row.id, relevanceScore: 1 })) }) };
    },
  } });
  assert.equal((await plugin.recall({ runId: "next", target: "execution", stepContext: { goal: "Inspect current resource contract", knowledgeOnly: true }, budget: { maxItems: 4, maxTokens: 1600 } }))?.target, "execution");
});

test("publication interrupted after a ledger revision fences the old card; replay resumes without another inference", async () => {
  const store = new InMemoryMemoryStore(); await settle(store, "one", "documents"); await settle(store, "two", "coding");
  const plugin = createMemoryPlugin({ store, now: () => 2000, resolveRunScope: async runId => ({ ...scope, runId }) });
  const query = { runId: "next", target: "execution" as const, stepContext: { goal: "Inspect current resource contract", knowledgeOnly: true }, budget: { maxItems: 4, maxTokens: 1600 } };
  assert.ok(await plugin.recall(query));
  const original = store.commit.bind(store); let interrupted = false;
  store.commit = async (...args) => {
    if (!interrupted && args[1].proposedSubtype === "experience.knowledge") { interrupted = true; throw new Error("publication interrupted"); }
    return original(...args);
  };
  await assert.rejects(settle(store, "revision", "research", "revise"), /publication interrupted/);
  assert.equal(await plugin.recall(query), undefined, "the old card is rejected even before its suspension write succeeds");
  const before = (await store.settlementAttempts(scope, "revision")).length;
  await settle(store, "revision", "research", "revise");
  assert.equal((await store.settlementAttempts(scope, "revision")).length, before);
  const ledger = (await store.active(scope)).find(row => row.item.subtype === "experience.independent_knowledge")!;
  assert.equal((ledger.revision.value.knowledgeUnit as any).supports.length, 1);
  assert.equal(await plugin.recall(query), undefined);
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: single-job settlement uses the same cross-family independent ledger`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined; t.after(() => db?.close());
  const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  await settle(store, "single-document", "documents", "support", false, {}, true);
  await settle(store, "single-code", "coding", "support", false, {}, true);
  const active = await store.active(scope), ledgers = active.filter(row => row.item.subtype === "experience.independent_knowledge");
  assert.equal(active.filter(row => row.item.subtype === "experience.task_group").length, 2);
  assert.equal(ledgers.length, 1);
  assert.equal((ledgers[0]!.revision.value.knowledgeUnit as any).supports.length, 2);
  assert.equal(active.filter(row => row.item.subtype === "experience.knowledge").length, 1);
});
