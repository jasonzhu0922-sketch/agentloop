import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase, RunService, SkillService } from "@zhujun/agentloop";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "../../agentloop/tests/runtime-test-helpers.ts";
import { createMemoryPlugin, InMemoryMemoryStore, SqliteMemoryStore, settleV2Batch, SETTLEMENT_V2, REUSABLE_LEARNING_CONTRACT, reconcileMemoryFeedback } from "../src/index.ts";
import type { MemorySettlementEvidence, MemorySettlementModel, MemoryStore } from "../src/types.ts";
import { accumulateKnowledge } from "../src/knowledge.ts";
import { comparisonFixture } from "./fixtures/knowledge-comparison.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
function evidence(runId: string, domain = "coding", grounded = true): MemorySettlementEvidence {
  return { scope: { ...scope, runId }, runId, terminalCommitRef: `outcome:${runId}`, terminalStatus: "completed",
    strategy: "Deliver a verified change", taskFingerprint: { taskKind: "execute", domain },
    quality: { terminalCommitted: true, assessmentApproved: true, laterCorrected: false, laterDisputed: false },
    observations: [{ id: "operation", kind: "action", stepOrder: 1, toolName: "resource.inspect", status: "succeeded", summary: "Inspect resource metadata", sourceRefs: [{ type: "action", runId, sourceId: "operation" }] },
      { id: "definition", kind: "action", stepOrder: 1, toolName: "resource.inspect", status: "observed", summary: "Selected resource definition",
        details: { grounding: "exact_result_selection", value: { check: "verify --input {{input}}", revision: "v1" } },
        sourceRefs: [{ type: "action", runId, sourceId: "inspect", ...(grounded ? { resultId: "result", pointer: "/metadata", sourceHash: "hash" } : { authority: "model_interpretation" as const }) }] }],
    sourceRefs: [{ type: "outcome", runId, sourceHash: `outcome:${runId}` }], occurredAt: 1000 };
}
function model(): MemorySettlementModel {
  return { modelKey: "fixture", complete: async ({ input }) => {
    const request = input as Record<string, any>;
    if (request.stage === "selection") return { content: JSON.stringify({ matches: request.candidates.map((row: any) => ({ id: row.id, relevance: 0.95 })) }) };
    const refs = Object.keys(request.sources);
    const actions = refs.filter(ref => /^episode_\d+_observation_1$/.test(ref));
    const definitions = refs.filter(ref => /^episode_\d+_observation_2$/.test(ref));
    const output = { schema: SETTLEMENT_V2, learningContract: REUSABLE_LEARNING_CONTRACT,
      executionReview: [{ finding: "The current resource definition and input checker were inspected", status: "observed", evidenceRefs: definitions }],
      reuse: { parameters: [{ name: "input", description: "Current input" }], verifiedScope: ["Inspected resource"], unverifiedScope: ["Other resource versions"] },
      title: "Verified resource workflow", goalSummary: "Deliver a verified change", keywords: ["resource", "verify"], appliesTo: ["Current resource supports verification"], exclusions: [], caseFacts: [],
      learningValue: { status: "actionable", novelty: "new", actionChange: "Inspect and verify current inputs", verification: "Checked resource contract" },
      classicPath: [], toolUsage: [], cautions: [], recheckRules: [], failureLessons: [],
      reusableKnowledge: [
        { standalone: true, exclusions: [], kind: "scoped_rule", rule: "Resource metadata defines the input verification command", trigger: "Need to verify input", action: "Read the resource verification entry",
          verification: "Recheck current resource metadata", conditions: ["Resource alpha version v1"], recheckRules: ["Re-read metadata if the resource version changes"],
          resourceContext: [{ key: "resourceId", value: "alpha" }, { key: "resourceVersion", value: "v1" }], evidenceRefs: definitions },
        { standalone: true, exclusions: [], kind: "method", rule: "Verify each current input before further processing", trigger: "A new input arrives", action: "Run the input check",
          operation: "verify --input {{input}}", verification: "The input check passes", conditions: ["Current resource provides an input checker"], recheckRules: [], evidenceRefs: actions },
      ], merge: { decision: request.candidateGroupIds.length ? "reinforce" : "new", ...(request.candidateGroupIds.length ? { targetGroupId: request.candidateGroupIds[0] } : {}), supportingEpisodeIds: request.episodeIds, conflicts: [] },
    };
    for (const rule of output.reusableKnowledge) Object.assign(rule, { evidenceAssessment: { status: "supported", rationale: "The selected observations support this scoped claim", evidenceRefs: rule.evidenceRefs, limitations: ["Recheck the current resource version before reuse"] } });
    return { content: JSON.stringify(comparisonFixture(request, output)) };
  } };
}
async function settle(store: MemoryStore, values: MemorySettlementEvidence[]) {
  return settleV2Batch({ store, evidences: values, model: model(), jobs: values.map(value => ({ ...scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef,
    settlementJobId: `job:${value.runId}`, enqueuedAt: 1000, status: "processing", attempts: 1, nextAttemptAt: 1000 })), consolidate: true, now: 1000 });
}
const recall = (store: MemoryStore) => createMemoryPlugin({ store, now: () => 4000, resolveRunScope: async runId => ({ ...scope, runId }) });
const query = { runId: "next", target: "execution" as const, stepContext: { goal: "resource verification", knowledgeOnly: true, resourceId: "alpha", resourceVersion: "v1" }, budget: { maxItems: 4, maxTokens: 2000 } };

for (const domain of ["coding", "documents", "research", "data_analysis"]) test(`${domain}: source-grounded cognition is usable independently of a candidate strategy`, async () => {
  const store = new InMemoryMemoryStore();
  await settle(store, [evidence("one", domain)]);
  const active = await store.active(scope);
  assert.equal(active.filter(entry => entry.item.subtype === "experience.procedure").length, 0);
  const knowledge = active.filter(entry => entry.item.subtype === "experience.knowledge");
  assert.equal(knowledge.length, 1);
  const projection = await recall(store).recall(query);
  assert.equal(projection?.target, "execution");
  if (projection?.target !== "execution") return;
  assert.equal(projection.knowledgeCards?.[0]?.layer, "environment");
  assert.equal(projection.knowledgeCards?.[0]?.verificationBasis, "source_observation");
  assert.deepEqual(projection.knowledgeCards?.[0]?.content.evidenceCaveats, ["Recheck the current resource version before reuse"]);
  assert.doesNotMatch(JSON.stringify(projection), /outcome:one|caseFacts|supportingEpisodeIds/);
  for (const stepContext of [{ goal: "resource verification", knowledgeOnly: true }, { ...query.stepContext, resourceVersion: "v2" }, { ...query.stepContext, resourceId: "beta" }]) {
    assert.equal(await recall(store).recall({ ...query, stepContext }), undefined, "missing/wrong resource selectors never satisfy remembered scope");
  }
  assert.equal(await recall(store).recall({ ...query, budget: { maxItems: 4, maxTokens: 1 } }), undefined, "a knowledge card is atomic under budget pressure");
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: strategies need independent execution; retrieval, feedback and interrupted publication retain unit boundaries`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
  t.after(() => db?.close());
  const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  await settle(store, [evidence("one"), evidence("two")]);
  const plugin = recall(store), projection = await plugin.recall({ ...query, stepContext: { ...query.stepContext, goal: "verify each input", knowledgeLayer: "strategy" } });
  assert.equal(projection?.target, "execution");
  if (projection?.target !== "execution") return;
  assert.equal(projection.knowledgeCards?.length, 1);
  assert.equal(projection.knowledgeCards![0]!.content.operation, "verify --input {{input}}");
  await reconcileMemoryFeedback(store, { ...evidence("one"), quality: { ...evidence("one").quality, laterDisputed: true } }, 3000);
  assert.equal(await plugin.recall({ ...query, stepContext: { ...query.stepContext, goal: "verify each input", knowledgeLayer: "strategy" } }), undefined);
  const next = await plugin.recall(query);
  assert.equal(next, undefined, "a retracted source requires a fresh model assessment; remaining receipt counts cannot silently renew the judgment");
  const foreign = createMemoryPlugin({ store, resolveRunScope: async runId => ({ ...scope, ownerUserId: "bob", runId }) });
  assert.equal(await foreign.recall(query), undefined);
});

test("an interpretation or complete-task success alone does not publish environment cognition", async () => {
  const store = new InMemoryMemoryStore();
  await settle(store, [evidence("one", "coding", false)]);
  assert.equal((await store.active(scope)).filter(entry => entry.item.subtype === "experience.knowledge").length, 0);
});

test("a failed task can establish a bounded source observation without proving a successful strategy", async () => {
  const store = new InMemoryMemoryStore(), base = evidence("failed");
  await settle(store, [{ ...base, terminalStatus: "failed", quality: { ...base.quality, assessmentApproved: false } }]);
  const projection = await recall(store).recall(query);
  assert.equal(projection?.target === "execution" && projection.knowledgeCards?.[0]?.layer, "environment");
  assert.equal(await recall(store).recall({ ...query, stepContext: { ...query.stepContext, knowledgeLayer: "strategy" } }), undefined);
});

function blockedEvidence(runId: string, domain = "coding", grounded = true): MemorySettlementEvidence {
  const base = evidence(runId, domain, grounded);
  return { ...base, terminalStatus: "failed", quality: { ...base.quality, assessmentApproved: false }, observations: [
    { ...base.observations![0]!, status: "failed", summary: "Required resource inspection failed", details: { executionObserved: true } },
    { ...base.observations![1]!, details: { grounding: "exact_result_selection", value: { status: "unavailable", code: "connection_failed" } } },
  ] };
}
function decisionModel(change: (learning: any) => void = () => {}): MemorySettlementModel {
  const base = model();
  return { ...base, complete: async args => {
    const reply = await base.complete(args);
    if ((args.input as any).stage === "selection") return reply;
    const learning = JSON.parse(reply.content), refs = Object.keys((args.input as any).sources).filter(ref => /^episode_\d+_observation_[12]$/.test(ref));
    learning.reuse.parameters = [];
    learning.reusableKnowledge = [{ standalone: true, exclusions: ["A valid empty result or a correctable request error", "An authorized alternative source is available"], kind: "decision_rule",
      rule: "Stop acquisition when the required resource is currently unavailable and no admissible continuation exists",
      trigger: "Current resource checks establish an unavailable prerequisite", action: "Check alternatives, then report the unmet goal and the prerequisite needed to resume",
      verification: "Current diagnostics support the block; no requested results are fabricated", conditions: ["Resource alpha v1 is required for this task", "A bounded current check confirms the unavailable prerequisite"],
      recheckRules: ["Recheck availability in each new task; a past incident never proves a current block"], resourceContext: [{ key: "resourceId", value: "alpha" }, { key: "resourceVersion", value: "v1" }],
      decisionPolicy: { action: "stop", alternatives: ["Check authorized alternative sources and any bounded action able to change the prerequisite"], resumeWhen: ["The required resource is available or an authorized alternative is provided"] }, evidenceRefs: refs }];
    change(learning);
    return { content: JSON.stringify(learning) };
  } };
}
async function settleDecision(store: MemoryStore, values: MemorySettlementEvidence[], proposal = decisionModel()) {
  return settleV2Batch({ store, evidences: values, model: proposal, jobs: values.map(value => ({ ...scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef,
    settlementJobId: `job:${value.runId}`, enqueuedAt: 1000, status: "processing", attempts: 1, nextAttemptAt: 1000 })), consolidate: true, now: 1000 });
}

for (const domain of ["coding", "documents", "research", "data_analysis"]) test(`${domain}: failed tasks yield scoped, explicitly tentative stop advice without proving successful methods`, async () => {
  const store = new InMemoryMemoryStore();
  await settleDecision(store, [blockedEvidence("blocked", domain)]);
  const plugin = recall(store), request = { ...query, stepContext: { ...query.stepContext, goal: "Stop acquisition unavailable resource", knowledgeLayer: "strategy" } };
  const projection = await plugin.recall(request);
  assert.equal(projection?.target, "execution");
  if (projection?.target !== "execution") return;
  assert.equal(projection.knowledgeCards?.length, 1);
  const card = projection.knowledgeCards![0]!;
  assert.equal(card.layer, "strategy");
  assert.equal(card.maturity, "candidate");
  assert.equal(card.verificationBasis, "execution_observation");
  assert.equal((card.content.decisionPolicy as any).action, "stop");
  assert.equal(card.requiresVerification, true);
  assert.equal((await store.active(scope)).some(entry => entry.item.subtype === "experience.procedure"), false);
  assert.equal(await plugin.recall({ ...request, target: "planner" }), undefined);
  assert.equal(await plugin.recall({ ...request, stepContext: { goal: request.stepContext.goal, knowledgeOnly: true } }), undefined);
  assert.equal(await plugin.recall({ ...request, stepContext: { ...request.stepContext, resourceId: "other" } }), undefined);
  await store.invalidateRun(scope, "blocked", { type: "user_feedback", runId: "blocked" }, 2000);
  assert.equal(await plugin.recall(request), undefined, "durable invalidation fences tentative advice before its publication is suspended");
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: repeated failure never promotes a decision; feedback retracts its observation support`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
  t.after(() => db?.close());
  const store: MemoryStore = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  await settleDecision(store, [blockedEvidence("one"), blockedEvidence("two")]);
  let cards = (await store.active(scope)).filter(entry => entry.item.subtype === "experience.knowledge");
  assert.equal(cards.length, 1);
  assert.equal((cards[0]!.revision.value.taskKnowledge as any).maturity, "candidate");
  assert.equal((cards[0]!.revision.value.knowledgeUnits as any[])[0].supports.length, 2);
  for (const runId of ["one", "two"]) {
    const value = blockedEvidence(runId);
    await reconcileMemoryFeedback(store, { ...value, quality: { ...value.quality, laterDisputed: true } }, 3000);
  }
  assert.equal(await recall(store).recall({ ...query, stepContext: { ...query.stepContext, goal: "Stop acquisition unavailable resource", knowledgeLayer: "strategy" } }), undefined);
});

test("decision proposals need exact current observations, explicit boundaries and alternatives", async () => {
  const store = new InMemoryMemoryStore();
  await settleDecision(store, [blockedEvidence("ungrounded", "coding", false)]);
  assert.equal((await store.active(scope)).filter(entry => entry.item.subtype === "experience.knowledge").length, 0);
  for (const alter of [(rule: any) => { delete rule.decisionPolicy; }, (rule: any) => { rule.exclusions = []; }, (rule: any) => { rule.decisionPolicy.alternatives = []; },
    (rule: any) => { rule.evidenceRefs = rule.evidenceRefs.filter((ref: string) => ref.endsWith("_2")); }]) {
    await assert.rejects(settleDecision(new InMemoryMemoryStore(), [blockedEvidence("invalid")], decisionModel(learning => alter(learning.reusableKnowledge[0]))), /decision_|array_invalid/);
  }
});

test("a model-rejected decision cannot enter execution recall as tentative advice", async () => {
  const store = new InMemoryMemoryStore();
  await settleDecision(store, [blockedEvidence("rejected")], decisionModel(learning => {
    const rule = learning.reusableKnowledge[0];
    rule.evidenceAssessment = { status: "contradicted", rationale: "The observations do not establish that alternatives are unavailable", evidenceRefs: rule.evidenceRefs,
      limitations: ["An admissible alternative may still exist"] };
  }));
  assert.equal((await store.active(scope)).some(entry => entry.item.subtype === "experience.knowledge"), false);
});

test("standalone knowledge identity ignores unrelated parent goals, inputs and exclusions", () => {
  const claim = { standalone: true, kind: "method", rule: "Check {{input}}", conditions: ["Checker available"], exclusions: [], evidenceRefs: ["operation"] };
  const group = { classicPath: [], reusableKnowledge: [claim], failureLessons: [], reuse: { parameters: [{ name: "input", description: "Current input" }] }, appliesTo: ["Parent A"], exclusions: [] };
  const other = { ...group, appliesTo: ["Parent B"], exclusions: ["Unrelated parent restriction"], reuse: { parameters: [...group.reuse.parameters, { name: "report_title", description: "Presentation title" }] } };
  const unit = accumulateKnowledge(group, {}, [])[0]!, repeated = accumulateKnowledge(other, {}, [])[0]!;
  assert.equal(unit.id, repeated.id);
  const narrowed = accumulateKnowledge({ ...other, reusableKnowledge: [{ ...claim, conditions: ["Checker v2 only"] }] }, {}, [])[0]!;
  assert.notEqual(narrowed.id, unit.id, "a material applicability change cannot inherit support by renaming");
});

test("interrupted independent publication resumes from the committed group without repeating model inference", async () => {
  const store = new InMemoryMemoryStore(), commit = store.commit.bind(store);
  let interrupted = false, modelCalls = 0;
  store.commit = async (...args) => {
    if (!interrupted && args[1].proposedSubtype === "experience.knowledge") { interrupted = true; throw new Error("simulated publication interruption"); }
    return commit(...args);
  };
  const base = model(), tracked: MemorySettlementModel = { ...base, complete: async args => { modelCalls++; return base.complete(args); } };
  const value = evidence("interrupted"), input = { store, evidences: [value], model: tracked, jobs: [{ ...scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef,
    settlementJobId: "job", enqueuedAt: 1000, status: "processing" as const, attempts: 1, nextAttemptAt: 1000 }], consolidate: true, now: 1000 };
  await assert.rejects(settleV2Batch(input), /publication interruption/);
  assert.equal(modelCalls, 1);
  await settleV2Batch(input);
  assert.equal(modelCalls, 1);
  assert.ok(await recall(store).recall(query));
});

test("an independent definition changed during relevance inference fences out its old publication", async () => {
  const store = new InMemoryMemoryStore(); await settle(store, [evidence("one")]);
  const plugin = createMemoryPlugin({ store, now: () => 4000, resolveRunScope: async runId => ({ ...scope, runId }), recallModel: {
    modelKey: "concurrent", complete: async ({ input }) => {
      const group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.independent_knowledge")!;
      await store.commit(scope, { schema: "agentloop.userMemoryCandidate/v1", id: "change", ...scope,
        proposedKind: group.item.kind, proposedSubtype: group.item.subtype, proposedCanonicalKey: group.item.canonicalKey,
        proposedValue: { ...group.revision.value, contradicted: true }, proposedContentMarkdown: group.revision.contentMarkdown,
        persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal", proposedExperienceMaturity: "pattern",
        activation: { mode: "explicit_only" }, applicationTargets: ["planner"], sourceRefs: group.revision.sourceRefs,
        confidence: 0.7, reason: "concurrent conflict", decision: "accepted", expectedCurrentRevisionId: group.revision.id,
      }, 3000);
      return { content: JSON.stringify({ matches: (input as any).candidates.map((row: any) => ({ id: row.id, relevanceScore: 1 })) }) };
    },
  } });
  assert.equal(await plugin.recall(query), undefined);
});

test("RunService admits on-demand recall and delivers the independently scoped card through a committed Tool Result", async t => {
  const store = new InMemoryMemoryStore(); await settle(store, [evidence("history")]);
  const db = new AppDatabase(":memory:"), workspaceRoot = await mkdtemp(join(tmpdir(), "agentloop-knowledge-"));
  t.after(async () => { await db.close(); await rm(workspaceRoot, { recursive: true, force: true }); });
  const memory = recall(store);
  let calls = 0;
  const runs = new RunService({ database: db, workspaceRoot, skills: new SkillService(db), memory,
    plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
    modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
      calls++;
      if (calls === 1) {
        assert.ok(request.tools.some(tool => tool.name === "recall_task_knowledge"));
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "recall", name: "recall_task_knowledge", arguments: {
          query: "resource verification", layer: "environment", resourceContext: [{ key: "resourceId", value: "alpha" }, { key: "resourceVersion", value: "v1" }],
        } }] };
      }
      assert.match(JSON.stringify(request.messages), /agentloop.taskKnowledgeRecall\/v1/);
      assert.match(JSON.stringify(request.messages), /source_observation/);
      return { content: "Resource metadata provides a verification entry; current applicability still needs checking.", finishReason: "stop", toolCalls: [] };
    } }),
  });
  const run = await runs.execute("alice", "Inspect the resource verification knowledge and explain its scope");
  assert.equal(run.status, "completed", run.error ?? run.output);
  assert.equal(calls, 2);
  const events = await runs.events("alice", run.id);
  assert.ok(events.some(event => event.type === "tool.result_committed" && event.data.toolName === "recall_task_knowledge" && event.data.operationStatus === "succeeded"));
  const projections = await store.projections(scope, run.id);
  assert.equal(projections.filter(item => item.target === "execution").length, 1);
});
