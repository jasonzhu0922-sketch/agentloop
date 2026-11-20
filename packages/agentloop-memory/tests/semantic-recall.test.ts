import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryPlugin } from "../src/plugin.ts";
import { InMemoryMemoryStore } from "../src/store.ts";
import type { MemoryCandidate, MemorySettlementModel } from "../src/types.ts";
import { RECALL_SCENARIOS, UNRELATED_RECALL_GOAL } from "./fixtures/recall-scenarios.ts";

const scope = { tenantId: "device", ownerUserId: "alice", runId: "current" };
const candidate = (key: string, title: string, extra: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  schema: "agentloop.userMemoryCandidate/v1", id: key, ...scope, proposedKind: "experience", proposedSubtype: "experience.procedure",
  proposedCanonicalKey: key, proposedExperienceMaturity: "procedure", authority: "verified_run", sensitivity: "normal",
  persistenceIntent: "future_oriented", activation: { mode: "task_match", taskKinds: ["lookup"], domains: ["source_acquisition"] },
  applicationTargets: ["planner"], sourceRefs: [{ type: "run", runId: "earlier" }], confidence: 0.9, reason: "verified", decision: "accepted",
  proposedValue: { learningContract: "agentloop.reusableLearning/v1", settlementPromptSchemaVersion: "agentloop.semanticSettlement/v2", settlementPattern: {
    title, goalSummary: title,
    classicPath: ["Inspect current task contracts", "Resolve required inputs separately", "Bind current parameters and execute the admitted workflow", "Verify current evidence before delivery"].map((objective, i) => ({
      order: i + 1, objective, conditions: ["Current inputs meet the workflow requirements"], verification: "Check current execution evidence", toolNames: ["workspace.read"], skillIds: ["workflow"],
    })),
    reuse: { parameters: [{ name: "subject", description: "Current task subject" }, { name: "input", description: "Current task input" }], verifiedScope: ["Previously verified execution environment"], unverifiedScope: ["Other environments require validation"] },
    recheckRules: ["Revalidate current contracts; never substitute historical answers for current evidence"],
  } }, proposedContentMarkdown: "AUDIT ONLY 38932", ...extra,
});

test("all application targets require positive topic evidence and reject uncertain conventions despite lexical overlap", async () => {
  const store = new InMemoryMemoryStore();
  const targets = ["planner", "response", "execution", "artifact", "human_loop"] as const;
  for (const [key, description, score] of [
    ["global", "Use the user's preferred form of address", 0.99],
    ["relevant", "Inspect generated document pages before delivery", 0.95],
    ["uncertain", "Use research for document solutions", 0.3],
    ["unrelated", "Spreadsheet metric definition", 0.05],
  ] as const) {
    await store.commit(scope, candidate(key, description, { proposedKind: "preference", proposedExperienceMaturity: undefined, proposedPreferenceEffect: "default",
      proposedSubtype: key, activation: { mode: "always" }, applicationTargets: targets,
      proposedValue: { score }, proposedContentMarkdown: description }), 1);
  }
  let calls = 0;
  const memory = createMemoryPlugin({ store, resolveRunScope: async () => scope, now: () => 10,
    recallModel: { modelKey: "local:test", complete: async ({ input }) => { calls++; return { content: JSON.stringify({ matches: (input as any).candidates.map((row: any) => ({
      id: row.id, relevanceScore: row.content.includes("form of address") ? 0.99 : row.content.includes("Inspect generated") ? 0.95 : row.content.includes("research") ? 0.3 : 0.05,
    })) }) }; } } });
  for (const target of targets) {
    let diagnostic: any;
    const projection = await memory.recall({ runId: "current", target, stepContext: { goal: "Prepare a document solutions report" },
      budget: { maxItems: 12, maxTokens: 2000 }, onDiagnostic: async value => { diagnostic = value; } });
    assert.ok(projection);
    const active = await store.active(scope);
    assert.deepEqual(new Set(projection.memoryRevisionIds), new Set(active.filter(row => ["global", "relevant"].includes(row.item.subtype)).map(row => row.revision.id)));
    assert.equal(diagnostic.semanticStatus, "succeeded");
    assert.deepEqual(diagnostic.budgetExcludedRevisionIds, [], "irrelevance is a filtering decision, not token starvation");
  }
  assert.equal(calls, 1, "the same topic judgments are reused across targets");
});

test("the same recall protocol separates document, debugging and spreadsheet methods, survives parameter changes, and rejects unrelated work", async () => {
  const store = new InMemoryMemoryStore();
  const methods = new Map<string, string>();
  for (const scenario of RECALL_SCENARIOS) {
    const base = candidate(scenario.id, scenario.title);
    const pattern = base.proposedValue.settlementPattern as any;
    const committed = await store.commit(scope, { ...base, activation: { mode: "always" }, proposedValue: { ...base.proposedValue, settlementPattern: {
      ...pattern, classicPath: scenario.steps.map((objective, index) => ({ order: index + 1, objective, verification: scenario.verification, conditions: ["Validate current task prerequisites"], toolNames: [], skillIds: [] })),
      reuse: { parameters: scenario.parameters, verifiedScope: ["Fixture method scope"], unverifiedScope: ["New tasks require current verification"] },
    } } }, 1);
    methods.set(scenario.id, committed.revision.id);
  }
  const memory = createMemoryPlugin({ store, resolveRunScope: async () => scope, now: () => 10, recallModel: { modelKey: "local:contract-test", complete: async ({ input }) => {
    const request = input as any;
    const scenario = RECALL_SCENARIOS.find(row => (row.goals as readonly string[]).includes(request.goal));
    return { content: JSON.stringify({ matches: request.candidates.map((row: any) => ({ id: row.id,
      relevanceScore: scenario && row.content.includes(scenario.title) ? 0.95 : 0,
    })) }) };
  } } });
  for (const scenario of RECALL_SCENARIOS) for (const goal of scenario.goals) {
    const p = await memory.recall({ runId: "current", target: "planner", stepContext: { goal }, budget: { maxItems: 12, maxTokens: 1200 } });
    assert.equal(p?.target, "planner"); if (p?.target !== "planner") continue;
    assert.deepEqual(p.memoryRevisionIds, [methods.get(scenario.id)]);
    assert.equal(p.planningPriors[0]!.suggestedSteps.length, scenario.steps.length);
    assert.deepEqual(p.planningPriors[0]!.reuse!.parameters, scenario.parameters);
    assert.equal(p.planningPriors[0]!.requiresVerification, true);
    assert.doesNotMatch(JSON.stringify(p), /AUDIT ONLY|38932/);
  }
  assert.equal(await memory.recall({ runId: "current", target: "planner", stepContext: { goal: UNRELATED_RECALL_GOAL }, budget: { maxItems: 12, maxTokens: 1200 } }), undefined);
});

test("Chinese goals recall English methods under 1200 tokens, reject unrelated defaults, and keep current-task verification", async () => {
  const store = new InMemoryMemoryStore();
  const method = await store.commit(scope, candidate("headcount", "Employee Headcount Query from Group Data Scenario"), 1);
  await store.commit(scope, candidate("unrelated", "Render presentation slide geometry"), 1);
  for (const key of ["cashflow", "weekly-report"]) await store.commit(scope, candidate(key, key, {
    proposedKind: "preference", proposedSubtype: key, proposedExperienceMaturity: undefined, proposedPreferenceEffect: "default",
    activation: { mode: "always" }, proposedValue: { format: "Topic-specific conventions ".repeat(100) },
    proposedContentMarkdown: key === "cashflow" ? "Cash flow metric definition" : "Management weekly report structure",
  }), 1);
  let calls = 0;
  const recallModel: MemorySettlementModel = { modelKey: "local:test", complete: async ({ input, systemPrompt }) => {
    calls++; assert.match(systemPrompt, /across languages/);
    assert.doesNotMatch(JSON.stringify(input), /38932|AUDIT ONLY/);
    const { candidates } = input as any;
    return { content: JSON.stringify({ matches: candidates.map((row: any) => ({ id: row.id, relevanceScore: row.content.includes("Employee Headcount") ? 0.95 : 0.05 })) }) };
  } };
  const memory = createMemoryPlugin({ store, resolveRunScope: async runId => runId === "foreign" ? { ...scope, ownerUserId: "bob" } : scope, recallModel, now: () => 10 });
  for (const goal of ["2025年3月第三家公司全公司和总部的在岗员工人数分别是多少？", "2025年4月另一家公司全公司和总部员工人数分别是多少？"]) {
    const projection = await memory.recall({ runId: "current", target: "planner", stepContext: { goal }, taskFingerprint: { taskKind: "lookup", domain: "source_acquisition" }, budget: { maxItems: 12, maxTokens: 1200 } });
    assert.equal(projection?.target, "planner");
    if (projection?.target !== "planner") return;
    assert.deepEqual(projection.memoryRevisionIds, [method.revision.id]);
    assert.equal(projection.planningPriors[0]!.suggestedSteps.length, 4);
    assert.equal(projection.planningPriors[0]!.requiresVerification, true);
    assert.match(projection.retrievalReasons[0]!, /semantic=0.95/);
    assert.doesNotMatch(JSON.stringify(projection), /38932|AUDIT ONLY/);
  }
  assert.equal(calls, 2);
  assert.equal(await memory.recall({ runId: "foreign", target: "planner", stepContext: { goal: "员工人数" }, taskFingerprint: { taskKind: "lookup", domain: "source_acquisition" }, budget: { maxItems: 12, maxTokens: 1200 } }), undefined);
  assert.equal(calls, 2, "another owner supplies no candidates to the model");
});

test("unavailable, malformed and low-confidence models cannot admit an English method by task fingerprint alone", async () => {
  for (const response of ["unavailable", "{}", '{"matches":[{"id":"candidate_1","relevanceScore":0.5}]}', '{"matches":[{"id":"invented","relevanceScore":1}]}']) {
    const store = new InMemoryMemoryStore(); await store.commit(scope, candidate("method", "Employee Headcount Query"), 1);
    const memory = createMemoryPlugin({ store, resolveRunScope: async () => scope, now: () => 10,
      recallModel: { modelKey: "local:test", complete: async () => { if (response === "unavailable") throw new Error("offline"); return { content: response }; } } });
    let diagnostic: any;
    assert.equal(await memory.recall({ runId: "current", target: "planner", stepContext: { goal: "员工人数" }, taskFingerprint: { taskKind: "lookup", domain: "source_acquisition" }, budget: { maxItems: 12, maxTokens: 1200 }, onDiagnostic: async value => { diagnostic = value; } }), undefined);
    assert.equal(diagnostic.semanticStatus, response === "unavailable" ? "unavailable" : response.includes('0.5') ? "succeeded" : "invalid_output");
    assert.deepEqual(diagnostic.projectedRevisionIds, []);
    assert.doesNotMatch(JSON.stringify(diagnostic), /AUDIT ONLY|38932|Employee Headcount/);
  }
});

test("feedback and revision replacement during semantic inference fence out the old recall before publication", async () => {
  for (const mutation of ["feedback", "revision"] as const) {
    const store = new InMemoryMemoryStore();
    const base = candidate("method", "Render a document and inspect its pages", { activation: { mode: "always" } });
    const method = { ...base, proposedValue: { ...base.proposedValue, knowledgeUnits: [{ id: "known-path", section: "classicPath", status: "verified", supports: [{ runId: "earlier", executionKey: "execution:earlier" }], evidence: [], content: [] }] } };
    const committed = await store.commit(scope, method, 1);
    const memory = createMemoryPlugin({ store, resolveRunScope: async () => scope, now: () => 10, recallModel: { modelKey: "local:test", complete: async ({ input }) => {
      if (mutation === "feedback") await store.invalidateRun(scope, "earlier", { type: "user_feedback", runId: "correction" }, 2);
      else await store.commit(scope, { ...method, id: "replacement", proposedValue: { ...method.proposedValue, replacement: true } }, 2);
      return { content: JSON.stringify({ matches: (input as any).candidates.map((row: any) => ({ id: row.id, relevanceScore: 1 })) }) };
    } } });
    let diagnostic: any;
    assert.equal(await memory.recall({ runId: "current", target: "planner", stepContext: { goal: "生成一份文档并检查分页" }, budget: { maxItems: 12, maxTokens: 1200 }, onDiagnostic: async value => { diagnostic = value; } }), undefined);
    assert.ok(diagnostic.eligibleRevisionIds.includes(committed.revision.id));
    assert.deepEqual(diagnostic.projectedRevisionIds, [], "a positive model judgment cannot restore revoked or replaced evidence");
  }
});

test("source-scoped methods never reach semantic recall outside their exact selectors", async () => {
  const store = new InMemoryMemoryStore(); await store.commit(scope, candidate("scoped", "Employee Headcount Query", { proposedApplicability: { conditions: ["Source revision v3"], exclusions: [], context: { catalogRevision: ["v3"] } } }), 1);
  let calls = 0;
  const memory = createMemoryPlugin({ store, resolveRunScope: async () => scope, now: () => 10, recallModel: { modelKey: "local:test", complete: async () => { calls++; throw new Error("should not call"); } } });
  assert.equal(await memory.recall({ runId: "current", target: "planner", stepContext: { goal: "员工人数", catalogRevision: "v4" }, taskFingerprint: { taskKind: "lookup", domain: "source_acquisition" }, budget: { maxItems: 12, maxTokens: 1200 } }), undefined);
  assert.equal(calls, 0);
});

test("explicit global interaction scope survives unrelated goals and model outages, while task conventions and facts remain relevance-bound", async () => {
  const store = new InMemoryMemoryStore();
  const global = await store.commit(scope, candidate("unseen.convention", "Use the user's chosen interaction convention", {
    proposedKind: "preference", proposedSubtype: "unseen.convention", proposedExperienceMaturity: undefined,
    proposedPreferenceEffect: "default", proposedValue: { convention: "A durable user interaction choice" },
    authority: "explicit_user", persistenceIntent: "explicit", activation: { mode: "always" }, applicationTargets: ["response", "human_loop"],
    proposedApplicability: { scope: "global_interaction", conditions: [], exclusions: [] },
    sourceRefs: [{type: "user_message", runId: "earlier", messageId: "choice"}],
  }), 1);
  await store.commit(scope, candidate("topic", "Default definition for document research", {
    proposedKind: "preference", proposedSubtype: "topic", proposedExperienceMaturity: undefined, proposedPreferenceEffect: "default",
    proposedValue: { convention: "Specific topic" }, activation: {mode: "always"}, applicationTargets: ["response", "human_loop"],
    proposedApplicability: {scope: "task", conditions: [], exclusions: []},
  }), 1);
  for (const mode of ["unavailable", "negative"] as const) {
    const memory = createMemoryPlugin({store, resolveRunScope: async () => scope, now: () => 10, recallModel: {
      modelKey: "local:test", complete: async ({input}) => {
        assert.equal((input as any).candidates.some((row: any) => row.content.includes("durable user interaction")), false);
        if (mode === "unavailable") throw new Error("offline");
        return {content: JSON.stringify({matches: (input as any).candidates.map((row: any) => ({id: row.id, relevanceScore: 0}))})};
      },
    }});
    for (const goal of ["Debug a failing service", "设计一个交互式作品集", "Prepare a travel itinerary"]) for (const target of ["response", "human_loop"] as const) {
      const projection = await memory.recall({runId: "current", target, stepContext: {goal}, budget: {maxItems: 8, maxTokens: 1500}});
      assert.deepEqual(projection?.memoryRevisionIds, [global.revision.id]);
    }
    assert.equal(await memory.recall({runId: "current", target: "planner", stepContext: {goal: "Debug a failing service"}, budget: {maxItems: 8, maxTokens: 1500}}), undefined);
  }
  await assert.rejects(store.commit(scope, candidate("bad.fact", "A user fact", {
    proposedKind: "fact", proposedExperienceMaturity: undefined, proposedApplicability: {scope: "global_interaction", conditions: [], exclusions: []},
  }), 1), /global_interaction_requires/);
});

test("global interaction scope still obeys exact context, expiry, owner and current revision fences", async () => {
  const store = new InMemoryMemoryStore();
  const choice = candidate("arbitrary.preference", "A global interaction convention in a configured channel", {
    proposedKind: "preference", proposedSubtype: "arbitrary.preference", proposedExperienceMaturity: undefined,
    proposedPreferenceEffect: "default", proposedValue: { convention: "Use an accessible interaction style" }, authority: "explicit_user",
    activation: {mode: "always"}, applicationTargets: ["response"], proposedApplicability: {scope: "global_interaction", conditions: [], exclusions: [], context: {channel: ["accessible"]}},
    sourceRefs: [{type: "user_setting", sourceId: "setting"}], expiresAt: 20,
  });
  await store.commit(scope, choice, 1);
  const memory = createMemoryPlugin({store, resolveRunScope: async id => id === "foreign" ? {...scope, ownerUserId: "bob"} : scope, now: () => 10});
  for (const [runId, channel] of [["current", "ordinary"], ["foreign", "accessible"]]) {
    assert.equal(await memory.recall({runId, target: "response", stepContext: {goal: "Unrelated work", channel}, budget: {maxItems: 8, maxTokens: 1500}}), undefined);
  }
  assert.ok(await memory.recall({runId: "current", target: "response", stepContext: {goal: "Unrelated work", channel: "accessible"}, budget: {maxItems: 8, maxTokens: 1500}}));
  const expired = createMemoryPlugin({store, resolveRunScope: async () => scope, now: () => 21});
  assert.equal(await expired.recall({runId: "current", target: "response", stepContext: {goal: "Unrelated work", channel: "accessible"}, budget: {maxItems: 8, maxTokens: 1500}}), undefined);
});
