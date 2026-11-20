import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase, type PlanningMemoryProjection } from "@zhujun/agentloop";
import { createMemoryPlugin, InMemoryMemoryStore, MemorySettlementWorker, REUSABLE_LEARNING_CONTRACT, reviewMemoryApplications, SqliteMemoryStore } from "../src/index.ts";
import { accumulateKnowledge } from "../src/knowledge.ts";
import type { MemorySettlementEvidence, MemorySettlementModel, MemoryStore } from "../src/types.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
function projection(runId = "current"): PlanningMemoryProjection {
  return {
    schema: "agentloop.memoryProjection/v1", id: `projection:${runId}`, runId, target: "planner", memoryEpoch: 1,
    memoryRevisionIds: ["revision:method"], retrievalReasons: ["experience"], contentHash: "hash", createdAt: 1, expiresAt: 10,
    relevantFacts: [], preferenceConstraints: [], planningPriors: [{
      schema: "agentloop.planningPrior/v1", id: "prior", source: "experience_procedure", applicability: "Current source supports the method",
      strategy: "Check actual input and output", suggestedSteps: [{ objective: "Check actual input and output", verification: "The current input satisfies the expected boundary" }],
      reusableKnowledge: [{ rule: "Use the matching current source", conditions: ["Current source has the required coverage"] }],
      knowledgeBindings: [{ knowledgeId: "knowledge:path", section: "classicPath" }, { knowledgeId: "knowledge:rule", section: "reusableKnowledge", index: 0 }],
      evidenceExpectations: [], warnings: [], confidence: 0.7, sourceRefs: ["revision:method"],
    }],
  };
}
function evidence(runId = "current"): MemorySettlementEvidence {
  return { scope: { ...scope, runId }, runId, terminalCommitRef: `outcome:${runId}`, terminalStatus: "completed",
    taskFingerprint: { taskKind: "analysis" }, quality: { terminalCommitted: true, assessmentApproved: true, laterCorrected: false, laterDisputed: false },
    observations: [{ id: "action", kind: "action", stepOrder: 1, toolName: "source.read", status: "succeeded", summary: "Used the matching current source and checked coverage",
      details: { memoryGuidance: [{ projectionId: `projection:${runId}`, memoryRevisionId: "revision:method", knowledgeId: "knowledge:path",
        sourceRef: { type: "event", runId, sourceId: `${runId}:handoff` } }] },
      sourceRefs: [{ type: "action", runId, sourceId: "action-receipt" }] },
    { id: "assessment", kind: "assessment", stepOrder: 1, relatedObservationIds: ["action"], status: "approved", summary: "Input and output boundary verified",
      sourceRefs: [{ type: "assessment", runId, sourceId: "assessment-receipt" }] }],
    sourceRefs: [{ type: "outcome", runId, sourceHash: `outcome:${runId}` }], occurredAt: 1000 };
}
function response(extra: Record<string, unknown> = {}) {
  return { schema: "agentloop.memoryApplicationReview/v1", applications: [
    { memoryId: "memory_1", adoption: "adopted", effect: "supported", reason: "The current action implemented the method and its step passed the relevant check", observationIds: ["action", "assessment"], ...extra },
    { memoryId: "memory_2", adoption: "unknown", effect: "unverified", reason: "The available summary does not establish whether this specific rule was applied", observationIds: [] },
  ] };
}
const model = (handler: (request: Record<string, any>) => unknown = () => response()): MemorySettlementModel => ({ modelKey: "local:review", complete: async ({ input }) => ({ content: JSON.stringify(handler(input)) }) });

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend}: per-knowledge application records bind immutable recall to current action and same-step acceptance`, async t => {
    const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
    t.after(() => db?.close());
    const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
    await store.recordProjection(scope, projection());
    const changed = projection(); (changed.planningPriors[0] as any).strategy = "overwritten snapshot";
    await store.recordProjection(scope, changed);
    const isolatedCopy = (await store.projections(scope, "current"))[0]!;
    (isolatedCopy as any).contentHash = "mutated outside store";
    assert.equal((await store.projections(scope, "current")).length, 1, "projection storage is idempotent");
    assert.equal((await store.projections(scope, "current"))[0]!.contentHash, "hash", "historical snapshots cannot be rewritten by reference or repeated ID");
    let calls = 0;
    const reviewer = model(input => {
      calls++;
      assert.equal(input.stage, "memory_application");
      assert.equal(input.knowledge.length, 2);
      assert.deepEqual(input.outputSchema.properties.applications.items.properties.observationIds.items.enum, ["action", "assessment"]);
      assert.equal(JSON.stringify(input).includes("action-receipt"), false, "the model receives aliases, not writable source references");
      return response();
    });
    await reviewMemoryApplications({ store, evidence: evidence(), model: reviewer, now: 1000 });
    const loaded = db ? new SqliteMemoryStore(db) : store;
    await reviewMemoryApplications({ store: loaded, evidence: evidence(), model: reviewer, now: 2000 });
    assert.equal(calls, 1, "unchanged canonical evidence reuses the accepted checkpoint");
    const reviews = await loaded.applicationReviews(scope, "current");
    assert.equal(reviews.length, 1);
    const [applied, unknown] = reviews[0]!.applications;
    assert.equal(applied!.knowledgeId, "knowledge:path");
    assert.equal(applied!.memoryRevisionId, "revision:method");
    assert.equal(applied!.projectionId, "projection:current");
    assert.deepEqual(applied!.stepOrders, [1]);
    assert.deepEqual(applied!.evidenceRefs.map(ref => ref.sourceId), ["action-receipt", "assessment-receipt"]);
    assert.equal(unknown!.adoption, "unknown");
    assert.equal(unknown!.effect, "unverified");
    assert.equal((await loaded.active(scope)).length, 0, "a review does not create or reinforce knowledge");
    assert.deepEqual(await loaded.applicationReviews({ ...scope, ownerUserId: "bob" }, "current"), []);
    assert.deepEqual(await loaded.applicationReviews({ ...scope, tenantId: "other" }, "current"), []);
    assert.deepEqual(await loaded.applicationReviews(scope, "other-run"), []);
    await reviewMemoryApplications({ store: loaded, evidence: { ...evidence(), quality: { ...evidence().quality, laterDisputed: true } }, model: model(() => response({ effect: "unverified" })), now: 3000 });
    assert.equal((await loaded.applicationReviews(scope, "current")).length, 2, "new feedback produces a new snapshot without rewriting the old review");
  });
}

for (const [name, value, output, code] of [
  ["recall and overall completion without actions", { ...evidence(), observations: [] }, response({ observationIds: [] }), "adoption_action_missing"],
  ["loaded Skill without execution", { ...evidence(), observations: [{ ...evidence().observations![0]!, toolName: "load_skill" }, evidence().observations![1]!] }, response(), "adoption_action_missing"],
  ["action without a method handoff", { ...evidence(), observations: [{ ...evidence().observations![0]!, details: {} }, evidence().observations![1]!] }, response(), "adoption_handoff_missing"],
  ["handoff of another knowledge unit", { ...evidence(), observations: [{ ...evidence().observations![0]!, details: { memoryGuidance: [{ projectionId: "projection:current", memoryRevisionId: "revision:method", knowledgeId: "other", sourceRef: { type: "event", runId: "current", sourceId: "handoff" } }] } }, evidence().observations![1]!] }, response(), "adoption_handoff_missing"],
  ["assessment from another step", { ...evidence(), observations: [evidence().observations![0]!, { ...evidence().observations![1]!, stepOrder: 2 }] }, response(), "effect_assessment_missing"],
  ["stale same-step assessment", { ...evidence(), observations: [evidence().observations![0]!, { ...evidence().observations![1]!, relatedObservationIds: ["previous-action"] }] }, response(), "effect_assessment_missing"],
  ["same-step assessment without an execution link", { ...evidence(), observations: [evidence().observations![0]!, { ...evidence().observations![1]!, relatedObservationIds: [] }] }, response(), "effect_assessment_missing"],
  ["action from another Run", { ...evidence(), observations: [{ ...evidence().observations![0]!, sourceRefs: [{ type: "action", runId: "other", sourceId: "receipt" }] }, evidence().observations![1]!] }, response(), "evidence_scope_invalid"],
  ["invented observation", evidence(), response({ observationIds: ["invented"] }), "observation_reference_invalid"],
  ["unsupported non-adoption", evidence(), response({ adoption: "not_adopted", effect: "unverified", observationIds: [] }), "non_adoption_evidence_missing"],
  ["effect without adoption", evidence(), response({ adoption: "unknown", observationIds: [] }), "effect_without_adoption"],
  ["later dispute", { ...evidence(), quality: { ...evidence().quality, laterDisputed: true } }, response(), "effect_disputed"],
] as const) {
  test(`rejects ${name} without converting a model claim into adoption or benefit`, async () => {
    const store = new InMemoryMemoryStore(); await store.recordProjection(scope, projection());
    await assert.rejects(reviewMemoryApplications({ store, evidence: value as MemorySettlementEvidence, model: model(() => output), now: 1000 }), new RegExp(code));
    const [review] = await store.applicationReviews(scope, "current");
    assert.equal(review!.status, "invalid_output");
    assert.deepEqual(review!.applications, []);
    assert.deepEqual(review!.errors, [code]);
  });
}

test("coverage is exact and unknown remains explicit when evidence is incomplete", async () => {
  const store = new InMemoryMemoryStore(); await store.recordProjection(scope, projection());
  for (const applications of [[], [response().applications[0]], [response().applications[0], response().applications[0]]]) {
    await assert.rejects(reviewMemoryApplications({ store, evidence: evidence(), model: model(() => ({ schema: response().schema, applications })), now: 1000 }), /coverage_invalid|knowledge_reference_invalid/);
  }
  await reviewMemoryApplications({ store, evidence: { ...evidence(), observations: [], coverage: { totalObservations: 20, retainedObservations: 0, omittedObservations: 20 } },
    model: model(() => ({ ...response(), applications: response().applications.map(row => ({ ...row, adoption: "unknown", effect: "unverified", observationIds: [] })) })), now: 2000 });
  const reviews = await store.applicationReviews(scope, "current");
  assert.ok(reviews.find(review => review.status === "accepted")!.applications.every(row => row.adoption === "unknown"));
});

test("execution knowledge cards use the same immutable identity and action-linked review as planning methods", async () => {
  const store = new InMemoryMemoryStore(), base = projection();
  const { planningPriors: _priors, relevantFacts: _facts, preferenceConstraints: _preferences, ...header } = base;
  await store.recordProjection(scope, { ...header, target: "execution", augmentations: [], knowledgeCards: [{
    memoryRevisionId: "revision:method", knowledgeId: "knowledge:path", layer: "strategy", content: { rule: "Check input" }, parameters: [],
    verificationBasis: "independent_executions", requiresVerification: true,
  }] });
  const value = evidence();
  const handoff = { projectionId: base.id, memoryRevisionId: "revision:method", knowledgeId: "knowledge:path", sourceRef: { type: "action", runId: "current", sourceId: "recall-receipt" } };
  const current = { ...value, observations: [{ ...value.observations![0]!, details: { memoryGuidance: [handoff] } }, value.observations![1]!] };
  const reviewer = model(() => ({ schema: "agentloop.memoryApplicationReview/v1", applications: [response().applications[0]] }));
  await reviewMemoryApplications({ store, evidence: current, model: reviewer, now: 1000 });
  assert.equal((await store.applicationReviews(scope, "current"))[0]!.applications[0]!.adoption, "adopted");
  await assert.rejects(reviewMemoryApplications({ store, evidence: { ...current, observations: [{ ...current.observations[0]!, toolName: "recall_task_knowledge" }, current.observations[1]!] }, model: reviewer, now: 2000 }), /adoption_action_missing/);
});

test("tentative stopping advice can be adopted through a current Runtime stop, without claiming benefit or completing the task", async () => {
  const store = new InMemoryMemoryStore(), base = projection();
  const { planningPriors: _priors, relevantFacts: _facts, preferenceConstraints: _preferences, ...header } = base;
  await store.recordProjection(scope, { ...header, target: "execution", augmentations: [], knowledgeCards: [{ memoryRevisionId: "revision:method", knowledgeId: "knowledge:path",
    layer: "strategy", content: { kind: "decision_rule", decisionPolicy: { action: "stop" } }, parameters: [], verificationBasis: "execution_observation", maturity: "candidate", requiresVerification: true }] });
  const value = evidence(), handoff = { projectionId: base.id, memoryRevisionId: "revision:method", knowledgeId: "knowledge:path",
    sourceRef: { type: "action", runId: "current", sourceId: "recall" } };
  const failure = { ...value.observations![0]!, status: "failed", details: { executionObserved: true } };
  const stop = { id: "stop", kind: "decision" as const, stepOrder: 1, status: "observed", summary: "Stopped the candidate loop after checking alternatives",
    relatedObservationIds: ["action"], details: { executionObserved: true, executionDecision: "stop", memoryGuidance: [handoff] },
    sourceRefs: [{ type: "event" as const, runId: "current", sourceId: "current:stop" }] };
  const current: MemorySettlementEvidence = { ...value, terminalStatus: "failed", quality: { ...value.quality, assessmentApproved: false }, observations: [failure, stop] };
  const reviewer = (effect = "unverified", observationIds = ["action", "stop"]) => model(input => {
    assert.equal(input.knowledge[0].maturity, "candidate");
    return { schema: "agentloop.memoryApplicationReview/v1", applications: [{ memoryId: "memory_1", adoption: "adopted", effect,
      reason: "Current unavailable prerequisite was checked, no authorized alternative could proceed, and Runtime stopped this loop", observationIds }] };
  });
  await reviewMemoryApplications({ store, evidence: current, model: reviewer(), now: 1000 });
  assert.equal((await store.applicationReviews(scope, "current"))[0]!.applications[0]!.adoption, "adopted");
  assert.equal((await store.applicationReviews(scope, "current"))[0]!.applications[0]!.effect, "unverified");
  await assert.rejects(reviewMemoryApplications({ store, evidence: current, model: { ...reviewer("supported"), modelKey: "wrong-effect" }, now: 2000 }), /candidate_decision_effect_unverified/);
  for (const observations of [[{ ...failure, details: { executionObserved: true, memoryGuidance: [handoff] } }],
    [failure, { ...stop, details: { executionObserved: true, executionDecision: "stop" } }], [failure, { ...stop, relatedObservationIds: [] }],
    [failure, { ...stop, stepOrder: 2 }], [failure, { ...stop, status: "interpreted" }]]) {
    const ids = observations.map(item => item.id);
    await assert.rejects(reviewMemoryApplications({ store, evidence: { ...current, observations }, model: reviewer("unverified", ids), now: 2000 }), /adoption_action_missing|adoption_handoff_missing/);
  }
});

test("larger recalls cover every knowledge unit in bounded batches and a durable invalidation rejects stale support", async () => {
  const store = new InMemoryMemoryStore(), snapshot = projection();
  const rules = Array.from({ length: 25 }, (_, i) => ({ rule: `Check boundary ${i}` }));
  (snapshot.planningPriors[0] as any).reusableKnowledge = rules;
  (snapshot.planningPriors[0] as any).knowledgeBindings = rules.map((_rule, index) => ({ knowledgeId: `knowledge:${index}`, section: "reusableKnowledge", index }));
  await store.recordProjection(scope, snapshot);
  const sizes: number[] = [];
  await reviewMemoryApplications({ store, evidence: evidence(), model: model(input => {
    sizes.push(input.knowledge.length);
    return { schema: "agentloop.memoryApplicationReview/v1", applications: input.knowledge.map((row: any) => ({ memoryId: row.memoryId,
      adoption: "unknown", effect: "unverified", reason: "No specific action can be established", observationIds: [] })) };
  }), now: 1 });
  assert.deepEqual(sizes, [12, 12, 1]);
  assert.equal(new Set((await store.applicationReviews(scope, "current")).flatMap(review => review.applications.map(row => row.knowledgeId))).size, 25);
  const stale = new InMemoryMemoryStore(); await stale.recordProjection(scope, projection());
  await stale.invalidateRun(scope, "current", { type: "user_feedback", runId: "later" }, 1);
  await assert.rejects(reviewMemoryApplications({ store: stale, evidence: evidence(), model: model(), now: 2 }), /effect_disputed/);
});

test("failed execution can establish attempted adoption and a counterexample; an undispatched failure cannot", async () => {
  const store = new InMemoryMemoryStore(); await store.recordProjection(scope, projection());
  const value = { ...evidence(), observations: [{ ...evidence().observations![0]!, status: "failed", details: { ...evidence().observations![0]!.details, executionObserved: true } },
    { ...evidence().observations![1]!, status: "rejected" }] };
  await reviewMemoryApplications({ store, evidence: value, model: model(() => response({ effect: "contradicted" })), now: 1000 });
  assert.equal((await store.applicationReviews(scope, "current"))[0]!.applications[0]!.effect, "contradicted");
  await assert.rejects(reviewMemoryApplications({ store, evidence: { ...value, observations: [{ ...value.observations[0]!, details: { executionObserved: false } }, value.observations[1]!] },
    model: model(() => response({ effect: "contradicted" })), now: 1000 }), /adoption_action_missing/);
});

test("no model call for absent or old identity-free snapshots; a non-cancellable model still has a deadline", async () => {
  const store = new InMemoryMemoryStore(); let calls = 0;
  await reviewMemoryApplications({ store, evidence: evidence(), model: model(() => { calls++; return response(); }), now: 1 });
  const old = projection(); delete (old.planningPriors[0] as any).knowledgeBindings;
  await store.recordProjection(scope, old);
  await reviewMemoryApplications({ store, evidence: evidence(), model: model(() => { calls++; return response(); }), now: 1 });
  assert.equal(calls, 0);
  await store.recordProjection(scope, { ...projection(), id: "new-projection" });
  await assert.rejects(reviewMemoryApplications({ store, evidence: evidence(), model: { modelKey: "local:hung", completeTimeoutMs: 5, complete: async () => new Promise(() => {}) }, now: 1 }), /model_unavailable/);
  assert.equal((await store.applicationReviews(scope, "current"))[0]!.status, "model_unavailable");
});

test("the settlement outbox retries failed review and persists accepted review alongside a no-learning result", async () => {
  const store = new InMemoryMemoryStore(); await store.recordProjection(scope, projection());
  let now = 1000, reviewCalls = 0;
  await store.enqueueSettlement({ scope, runId: "current", terminalCommitRef: evidence().terminalCommitRef, now });
  const worker = new MemorySettlementWorker({ store, reader: { read: async () => evidence() }, now: () => now, requireSettlementModel: true,
    settlementModel: model(input => {
      if (input.stage === "memory_application") {
        if (++reviewCalls === 1) return response({ observationIds: ["invented"] });
        return response();
      }
      return { schema: "agentloop.semanticSettlement/v2", learningContract: REUSABLE_LEARNING_CONTRACT,
        reuse: { parameters: [], verifiedScope: [], unverifiedScope: [] }, caseFacts: [],
        learningValue: { status: "insufficient", reason: "No new transferable knowledge" }, title: "", goalSummary: "", keywords: [], appliesTo: [], exclusions: [],
        classicPath: [], toolUsage: [], reusableKnowledge: [], failureLessons: [], cautions: [], recheckRules: [] };
    }) });
  assert.equal((await worker.runOnce()).status, "retrying");
  now = 100_000;
  const finished = await worker.runOnce();
  assert.equal(finished.status, "succeeded", finished.reason);
  assert.equal(reviewCalls, 2);
  assert.ok((await store.applicationReviews(scope, "current")).some(review => review.status === "accepted"));
});

test("projection retains each verified knowledge identity and excludes candidates without duplicating its content", async () => {
  const store = new InMemoryMemoryStore();
  const learning = { classicPath: [{ objective: "Check current source", toolNames: ["source.read"], evidenceRefs: ["a"] }],
    reusableKnowledge: [{ kind: "method", rule: "Check coverage", evidenceRefs: ["a"] }, { kind: "method", rule: "Unverified rule", evidenceRefs: ["missing"] }],
    failureLessons: [], appliesTo: [], exclusions: [] };
  for (const row of [learning.classicPath[0], learning.reusableKnowledge[0]]) Object.assign(row!, { evidenceAssessment: {
    status: "supported", rationale: "Current executions establish this claim", evidenceRefs: ["a"], limitations: [],
  } });
  const units = accumulateKnowledge(learning, { a: [{ type: "action", runId: "one" }, { type: "action", runId: "two" }] }, [
    { runId: "one", outcome: "verified_success" }, { runId: "two", outcome: "verified_success" },
  ]);
  await store.commit(scope, { schema: "agentloop.userMemoryCandidate/v1", id: "candidate", ...scope,
    proposedKind: "experience", proposedSubtype: "experience.procedure", proposedCanonicalKey: "method", proposedExperienceMaturity: "procedure",
    proposedValue: { learningContract: REUSABLE_LEARNING_CONTRACT, settlementPromptSchemaVersion: "agentloop.semanticSettlement/v2", taskGroup: learning, knowledgeUnits: units,
      settlementPattern: { classicPath: learning.classicPath, reusableKnowledge: [learning.reusableKnowledge[0]], goalSummary: "Check current source", title: "Check coverage" } },
    proposedContentMarkdown: "Check current source coverage", persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal",
    activation: { mode: "always" }, applicationTargets: ["planner"], sourceRefs: [], confidence: 0.7, reason: "verified", decision: "accepted" }, 1);
  const plugin = createMemoryPlugin({ store, resolveRunScope: async runId => ({ ...scope, runId }) });
  const recalled = await plugin.recall({ runId: "current", target: "planner", stepContext: { goal: "Check current source" }, budget: { maxItems: 5, maxTokens: 2000 } });
  assert.ok(recalled?.target === "planner");
  const bindings = recalled.planningPriors[0]!.knowledgeBindings!;
  assert.deepEqual(bindings.map(item => item.knowledgeId), units.filter(unit => unit.status === "verified").map(unit => unit.id));
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings.map(item => item.section), ["classicPath", "reusableKnowledge"]);
  assert.equal(bindings[1]!.index, 0);
  assert.equal(JSON.stringify(bindings).includes("Check coverage"), false);
});

test("a malformed review batch cannot suppress later knowledge reviews and retry reuses accepted checkpoints", async () => {
  const store = new InMemoryMemoryStore(), snapshot = projection();
  const rules = Array.from({ length: 25 }, (_, i) => ({ rule: `Check rule ${i}` }));
  (snapshot.planningPriors[0] as any).reusableKnowledge = rules;
  (snapshot.planningPriors[0] as any).knowledgeBindings = rules.map((_rule, index) => ({ knowledgeId: `rule:${index}`, section: "reusableKnowledge", index }));
  await store.recordProjection(scope, snapshot);
  let calls = 0;
  const reviewer = model(input => {
    if (++calls === 1) return { schema: "agentloop.memoryApplicationReview/v1", applications: [] };
    return { schema: "agentloop.memoryApplicationReview/v1", applications: input.knowledge.map((row: any) => ({ memoryId: row.memoryId,
      adoption: "unknown", effect: "unverified", reason: "No action establishes adoption", observationIds: [] })) };
  });
  await assert.rejects(reviewMemoryApplications({ store, evidence: evidence(), model: reviewer, now: 1 }), /coverage_invalid/);
  assert.equal(calls, 3);
  assert.equal((await store.applicationReviews(scope, "current")).filter(item => item.status === "accepted").length, 2);
  await reviewMemoryApplications({ store, evidence: evidence(), model: reviewer, now: 2 });
  assert.equal(calls, 4, "only the failed knowledge batch is retried");
});
