import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { createMemoryPlugin, InMemoryMemoryStore, MemorySettlementWorker, SqliteMemoryStore, SETTLEMENT_V2 } from "../src/index.ts";
import type { MemorySettlementEvidence, MemorySettlementModel, MemoryStore } from "../src/types.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
function evidence(runId: string): MemorySettlementEvidence {
  return {
    scope: { ...scope, runId }, runId, terminalCommitRef: `outcome:${runId}`, terminalStatus: "completed",
    strategy: "查询分析测试企业的员工画像；先确定组织代码和最新报表月份，再计算分布并生成 HTML",
    taskFingerprint: { taskKind: "composite", domain: "data_analysis", artifactKind: "html" },
    planSkeleton: [{ objective: "确定组织代码和最新报表月份，读取汇总行；不得混用明细与汇总口径", skillIds: ["discovered:hr-data"], toolNames: ["source.read"] }],
    observations: [{ id: "a", kind: "action", toolName: "source.read", status: "succeeded", summary: "先 describe-catalog，再按组织代码查询最新月份，取得汇总行", sourceRefs: [{ type: "action", runId, sourceId: "a" }] }],
    quality: { terminalCommitted: true, assessmentApproved: true, artifactVerified: true, laterCorrected: false, laterDisputed: false },
    sourceRefs: [{ type: "outcome", runId, sourceHash: `outcome:${runId}` }], occurredAt: 1000,
  };
}
function learning(ref = "step_1"): Record<string, any> {
  return {
    schema: SETTLEMENT_V2,
    learningValue: { status: "actionable", novelty: "new", actionChange: "先固定组织范围和最新月份，再汇总八个维度", verification: "范围和月份一致，各维度与总人数核对" },
    title: "从人事汇总报表生成员工画像", goalSummary: "获取人事汇总数据并生成 HTML 员工画像", keywords: ["员工画像", "汇总口径"],
    appliesTo: ["数据源提供按组织和月份汇总的人事报表"], exclusions: ["不能把明细行与汇总行相加"],
    classicPath: [{ objective: "先确定组织代码和最新报表月份，再计算八个维度并生成 HTML", toolNames: ["source.read"], skillIds: ["discovered:hr-data"], conditions: ["存在可用汇总报表"], verification: "确认组织和月份一致，再核对汇总值", evidenceRefs: [ref] }],
    toolUsage: [{ toolName: "source.read", purpose: "读取指定组织和月份的汇总行", evidenceRefs: [ref] }],
    reusableKnowledge: [], failureLessons: [], cautions: ["分母必须使用相同组织和月份的在岗人数"], recheckRules: ["报表字段变化时重新确认口径"],
  };
}
function model(handler?: (input: Record<string, any>, output: Record<string, any>) => void): MemorySettlementModel {
  return { modelKey: "local:test", complete: async ({ input }) => {
    const value = input as Record<string, any>;
    const output = learning(value.stage === "fusion" ? "episode_1_step_1" : "step_1");
    if (value.stage === "fusion") output.merge = { decision: value.candidateGroupIds.length ? "reinforce" : "new", ...(value.candidateGroupIds.length ? { targetGroupId: value.candidateGroupIds[0] } : {}), supportingEpisodeIds: value.episodeIds, conflicts: [] };
    handler?.(value, output);
    return { content: JSON.stringify(output), usage: { inputTokens: 100, outputTokens: 50 } };
  } };
}
async function settle(store: MemoryStore, runId: string, settlementModel = model(), override: Partial<MemorySettlementEvidence> = {}) {
  const value = { ...evidence(runId), ...override };
  await store.enqueueSettlement({ scope: value.scope, runId, terminalCommitRef: value.terminalCommitRef, now: 1000 });
  return new MemorySettlementWorker({ store, reader: { read: async () => value }, settlementModel, requireSettlementModel: true, consolidate: true, now: () => 1000, allowedRunIds: undefined }).runOnce();
}

test("v2 preserves semantic evidence and accepts a concrete path without inventing a knowledge rule", async () => {
  const store = new InMemoryMemoryStore();
  const result = await settle(store, "one", model((input) => {
    if (input.stage === "extraction") {
      assert.match(input.goal, /组织代码和最新报表月份/);
      assert.match(input.steps[0].objective, /不得混用明细与汇总口径/);
      assert.match(input.observations[0].summary, /describe-catalog/);
      assert.equal(JSON.stringify(input).includes("测试企业"), false);
    }
  }));
  assert.equal(result.status, "succeeded", result.reason);
  const active = await store.active(scope);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.task_group").length, 1);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.procedure").length, 0);
});

test("v2 redacts entities introduced only by observations and assessments", async () => {
  const store = new InMemoryMemoryStore();
  const base = evidence("observation-entity");
  const value = { ...base, observations: [{
    id: "a", kind: "action", toolName: "source.read", status: "succeeded",
    summary: "读取星河科技有限公司的人事汇总报表并确认组织范围",
    sourceRefs: [{ type: "action", runId: base.runId, sourceId: "a" }],
  }, {
    id: "assessment", kind: "assessment", status: "approved",
    summary: "星河科技有限公司的组织代码与月份已核对",
    sourceRefs: [{ type: "assessment", runId: base.runId, sourceId: "assessment" }],
  }] };
  const result = await settle(store, value.runId, model((input) => {
    assert.equal(JSON.stringify(input).includes("星河科技有限公司"), false);
  }), value);
  assert.equal(result.status, "succeeded", result.reason);
});

test("v2 admits a plan-bound tool when execution evidence is absent without calling it observed", async () => {
  const store = new InMemoryMemoryStore();
  const base = evidence("planned-tool");
  const value = {
    ...base,
    observations: [],
    planSkeleton: [{ objective: "读取已准入的数据源", skillIds: ["discovered:hr-data"], plannedToolNames: ["source.read"] }],
  };
  let sawPlanned = false;
  const result = await settle(store, value.runId, model((input, output) => {
    if (input.stage === "extraction") {
      sawPlanned = input.plannedTools.includes("source.read") && !input.observedTools.includes("source.read");
      output.classicPath[0].evidenceRefs = ["step_1"];
    }
  }), value);
  assert.equal(result.status, "succeeded", result.reason);
  assert.equal(sawPlanned, true);
});

test("experience cases wait for the configured batch size and use one fusion call", async () => {
  const store = new InMemoryMemoryStore();
  const values = ["batch-one", "batch-two", "batch-three"].map((runId) => evidence(runId));
  let modelCalls = 0;
  const settlementModel = model((input) => { modelCalls += 1; assert.equal(input.stage, "fusion"); assert.equal(input.episodeIds.length, 3); });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async ({ runId }) => values.find((value) => value.runId === runId) },
    settlementModel,
    requireSettlementModel: true,
    consolidate: true,
    experienceBatchSize: 3,
    now: () => 1000,
  });
  await store.enqueueSettlement({ scope: values[0]!.scope, runId: values[0]!.runId, terminalCommitRef: values[0]!.terminalCommitRef, now: 1000 });
  assert.equal((await worker.runOnce()).reason, "waiting_for_experience_batch");
  await store.enqueueSettlement({ scope: values[1]!.scope, runId: values[1]!.runId, terminalCommitRef: values[1]!.terminalCommitRef, now: 1000 });
  assert.equal((await worker.runOnce()).reason, "waiting_for_experience_batch");
  await store.enqueueSettlement({ scope: values[2]!.scope, runId: values[2]!.runId, terminalCommitRef: values[2]!.terminalCommitRef, now: 1000 });
  const result = await worker.runOnce();
  assert.equal(result.status, "succeeded", result.reason);
  assert.equal(modelCalls, 1);
  assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.task_group").length, 1);
});

test("concurrent Task Group fusion cannot silently overwrite a newer revision", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const store = new SqliteMemoryStore(database);
    const base = {
      schema: "agentloop.userMemoryCandidate/v1" as const,
      id: "candidate-base",
      ...scope,
      proposedKind: "experience" as const,
      proposedSubtype: "experience.task_group",
      proposedCanonicalKey: "task-group:employee-profile",
      proposedValue: { taskFingerprint: evidence("base").taskFingerprint, successfulRunIds: ["one"], taskGroup: learning() },
      proposedContentMarkdown: "可复用的员工画像任务组。",
      persistenceIntent: "future_oriented" as const,
      authority: "verified_run" as const,
      sensitivity: "normal" as const,
      proposedExperienceMaturity: "pattern" as const,
      activation: { mode: "explicit_only" as const },
      applicationTargets: ["planner"] as const,
      sourceRefs: [{ type: "run" as const, runId: "one" }],
      confidence: 0.7,
      reason: "test",
      decision: "accepted" as const,
    };
    const first = await store.commit(scope, base, 1000);
    const update = (id: string, runId: string) => ({ ...base, id, proposedValue: { ...base.proposedValue, successfulRunIds: ["one", runId] }, expectedCurrentRevisionId: first.revision.id });
    const results = await Promise.allSettled([store.commit(scope, update("candidate-two", "two"), 1001), store.commit(scope, update("candidate-three", "three"), 1002)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && String(result.reason).includes("task_group_revision_conflict")).length, 1);
  } finally { await database.close(); }
});

test("two successful executions produce a Planner prior; third reinforces one group without rewriting the method", async () => {
  const store = new InMemoryMemoryStore();
  for (const id of ["one", "two", "three"]) {
    const result = await settle(store, id);
    assert.equal(result.status, "succeeded", result.reason);
  }
  const active = await store.active(scope);
  const groups = active.filter(({ item }) => item.subtype === "experience.task_group");
  assert.equal(groups.length, 1);
  assert.equal((groups[0]!.revision.value.successfulEpisodeIds as string[]).length, 3);
  assert.equal((groups[0]!.revision.value.taskGroup as any).classicPath[0].objective, learning().classicPath[0].objective);
  const plugin = createMemoryPlugin({ store, resolveRunScope: async (runId) => ({ ...scope, runId }) });
  const projection = await plugin.recall({ runId: "fresh", target: "planner", taskFingerprint: evidence("fresh").taskFingerprint, budget: { maxItems: 6, maxTokens: 2000 } });
  assert.equal(projection?.target, "planner");
  if (projection?.target === "planner") {
    assert.equal(projection.planningPriors.length, 1);
    assert.match(projection.planningPriors[0]!.strategy, /组织代码和最新报表月份/);
    assert.deepEqual(projection.planningPriors[0]!.skillSuggestions, ["discovered:hr-data"]);
  }
  const otherUser = createMemoryPlugin({ store, resolveRunScope: async (runId) => ({ ...scope, ownerUserId: "bob", runId }) });
  assert.equal(await otherUser.recall({ runId: "fresh", target: "planner", taskFingerprint: evidence("fresh").taskFingerprint, budget: { maxItems: 6, maxTokens: 2000 } }), undefined);
});

test("v2 corrects one structural error with field diagnostics, records hashes and never stores the raw response", async () => {
  const store = new InMemoryMemoryStore();
  let calls = 0;
  const result = await settle(store, "one", model((input, output) => {
    if (input.stage !== "extraction") return;
    if (++calls === 1) delete output.learningValue.verification;
    else assert.equal(input.correction.errors[0].path, "$.learningValue.verification");
  }));
  assert.equal(result.status, "succeeded", result.reason);
  const attempts = await store.settlementAttempts(scope, "one");
  assert.equal(attempts[0]!.status, "invalid_output");
  assert.equal(attempts[1]!.status, "accepted");
  assert.equal(attempts[0]!.outputHash?.length, 64);
  assert.equal(JSON.stringify(attempts).includes("rawOutput"), false);
});

test("invented sources are rejected and the audit episode remains available", async () => {
  const store = new InMemoryMemoryStore();
  const result = await settle(store, "one", model((_input, output) => { output.classicPath[0].evidenceRefs = ["invented"]; }));
  assert.equal(result.status, "dead_letter");
  assert.match(result.reason!, /source_not_admitted/);
  assert.equal((await store.active(scope)).length, 1);
});

test("insufficient is a normal terminal result, not a model error", async () => {
  const store = new InMemoryMemoryStore();
  const result = await settle(store, "one", model((_input, output) => {
    output.learningValue = { status: "insufficient", reason: "只有任务描述，没有具体方法" };
    output.classicPath = []; output.toolUsage = [];
  }));
  assert.equal(result.status, "succeeded");
  assert.equal(result.reason, "no_learning");
  assert.equal((await store.settlementAttempts(scope, "one")).length, 1);
  assert.equal((await store.active(scope)).some(({ item }) => item.subtype === "experience.task_group"), false);
});

test("fusion failure resumes from its persisted extraction checkpoint and replay does not duplicate support", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const store = new SqliteMemoryStore(database);
    let fail = true;
    const localModel = model((input, output) => { if (fail && input.stage === "fusion") output.classicPath[0].evidenceRefs = ["invented"]; });
    assert.equal((await settle(store, "one", localModel)).status, "dead_letter");
    const extractionCount = (await store.settlementAttempts(scope, "one")).filter((attempt) => attempt.stage === "extraction").length;
    fail = false;
    await store.replaySettlement(scope, "one", 1000);
    assert.equal((await settle(store, "one", localModel)).status, "succeeded");
    assert.equal((await store.settlementAttempts(scope, "one")).filter((attempt) => attempt.stage === "extraction").length, extractionCount);
    await store.replaySettlement(scope, "one", 1000);
    assert.equal((await settle(store, "one", localModel)).reason, "already_fused");
    assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.task_group").length, 1);
    assert.deepEqual(await store.settlementAttempts({ ...scope, ownerUserId: "bob" }, "one"), []);
  } finally { await database.close(); }
});

test("same tools cannot bypass a conflicting task kind or domain", async () => {
  const store = new InMemoryMemoryStore();
  await settle(store, "one");
  const result = await settle(store, "two", model((input) => {
    if (input.stage === "fusion") { assert.equal(input.episodes.length, 1); assert.equal(input.candidateGroupIds.length, 0); }
  }), { taskFingerprint: { taskKind: "lookup", domain: "api_discovery" } });
  assert.equal(result.status, "succeeded", result.reason);
  assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.task_group").length, 2);
});

test("conflicting evidence suspends the existing procedure", async () => {
  const store = new InMemoryMemoryStore();
  await settle(store, "one"); await settle(store, "two");
  const result = await settle(store, "three", model((input, output) => {
    if (input.stage === "fusion") { output.merge.decision = "contradict"; output.merge.conflicts = ["相同来源下发现汇总口径不一致，须复查"]; }
  }));
  assert.equal(result.reason, "conflict_recorded");
  const plugin = createMemoryPlugin({ store, resolveRunScope: async (runId) => ({ ...scope, runId }) });
  assert.equal(await plugin.recall({ runId: "fresh", target: "planner", taskFingerprint: evidence("fresh").taskFingerprint, budget: { maxItems: 6, maxTokens: 2000 } }), undefined);
});
