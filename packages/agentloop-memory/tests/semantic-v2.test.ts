import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import { createMemoryPlugin, InMemoryMemoryStore, MemorySettlementWorker, SqliteMemoryStore, SETTLEMENT_V2, settleV2Batch, REUSABLE_LEARNING_CONTRACT } from "../src/index.ts";
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
    learningContract: REUSABLE_LEARNING_CONTRACT,
    reuse: { parameters: [{ name: "subject", description: "当前任务指定的组织" }, { name: "period", description: "当前任务指定的报表期间" }], verifiedScope: ["存在组织与月份汇总报表的已执行人事分析"], unverifiedScope: ["其他数据源需要核对字段和汇总规则"] },
    caseFacts: [],
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
    if (value.stage === "grouping") {
      const groups = new Map<string, string[]>();
      for (const item of value.cases) groups.set(item.goal, [...(groups.get(item.goal) ?? []), item.id]);
      return { content: JSON.stringify({ schema: "agentloop.experienceFamilies/v1", groups: [...groups.values()].map(caseIds => ({ caseIds, rationale: "Fixture cases share a mechanism" })) }) };
    }
    const output = learning(value.stage === "fusion" ? "episode_1_observation_1" : "observation_1");
    if (value.stage === "fusion") {
      const observed = Object.keys(value.sources).filter(ref => /^episode_\d+_observation_1$/.test(ref));
      const refs = observed.length ? observed : Object.keys(value.sources).filter(ref => /^episode_\d+_step_1$/.test(ref));
      output.classicPath[0].evidenceRefs = refs;
      output.toolUsage[0].evidenceRefs = refs;
    }
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
      output.toolUsage[0].evidenceRefs = ["step_1"];
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
  const plugin = createMemoryPlugin({ store, resolveRunScope: async (runId) => ({ ...scope, runId }) });
  const projection = await plugin.recall({ runId: "fresh", target: "planner", taskFingerprint: evidence("fresh").taskFingerprint, budget: { maxItems: 6, maxTokens: 2000 } });
  assert.equal(projection?.target, "planner");
  if (projection?.target === "planner") assert.deepEqual(projection.planningPriors[0]?.skillSuggestions, ["discovered:hr-data"]);
});

async function settleBatch(store: MemoryStore, values: MemorySettlementEvidence[], settlementModel = model()) {
  return settleV2Batch({ store, evidences: values, jobs: values.map(value => ({
    ...scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef,
    settlementJobId: `job:${value.runId}`, status: "processing" as const, attempts: 1, nextAttemptAt: 1000, enqueuedAt: 1000,
  })), model: settlementModel, consolidate: true, now: 1000 });
}

test("parameterized methods survive changing case answers while case facts never become planner requirements", async () => {
  const store = new InMemoryMemoryStore();
  const reusable = model((input, output) => {
    output.classicPath[0].objective = "按 {{subject}} 和 {{period}} 查询并核对汇总口径";
    output.classicPath[0].verification = "返回对象和期间与当前任务一致；汇总可复算；结论来自当前结果";
    output.caseFacts = [{ statement: input.episodeIds.includes("experience.episode:one:outcome:one") ? "历史案例中二月为负值" : "另一案例中各月均为正值", context: ["仅属于原始案例，不能预测当前答案"], evidenceRefs: output.classicPath[0].evidenceRefs }];
    output.reusableKnowledge = [{ kind: "scoped_rule", rule: "该来源的 M42 映射到月度实际值", trigger: "当前来源与指标定义匹配时",
      action: "核实 M42 定义后再选用", verification: "当前元数据确认定义一致", conditions: ["相同来源与定义版本"], recheckRules: ["来源、字段或版本改变时重新定位"], evidenceRefs: output.classicPath[0].evidenceRefs }];
  });
  await settleBatch(store, [evidence("one"), evidence("two")], reusable);
  await settleBatch(store, [evidence("three"), evidence("four")], reusable);
  const active = await store.active(scope);
  const group = active.find(({ item }) => item.subtype === "experience.task_group")!;
  assert.equal((group.revision.value.knowledgeUnits as any[]).find(unit => unit.section === "classicPath").supports.length, 4);
  const plugin = createMemoryPlugin({ store, resolveRunScope: async runId => ({ ...scope, runId }) });
  const projection = await plugin.recall({ runId: "new-subject-period", target: "planner", taskFingerprint: evidence("fresh").taskFingerprint, budget: { maxItems: 12, maxTokens: 4000 } });
  assert.equal(projection?.target, "planner");
  if (projection?.target !== "planner") return;
  const prior = projection.planningPriors[0]!;
  assert.match(JSON.stringify(prior.suggestedSteps), /\{\{subject\}\}.*\{\{period\}\}/);
  assert.deepEqual(prior.reuse?.parameters.map(parameter => parameter.name), ["subject", "period"]);
  assert.doesNotMatch(JSON.stringify(projection), /二月为负值|各月均为正值|caseFacts/);
  assert.doesNotMatch(prior.strategy, /M42/, "source-specific rules must retain their conditions, not become an unconditional strategy");
  assert.deepEqual(prior.reusableKnowledge?.[0]?.conditions, ["相同来源与定义版本"]);
  assert.deepEqual(prior.reusableKnowledge?.[0]?.recheckRules, ["来源、字段或版本改变时重新定位"]);
  assert.equal(await plugin.recall({ runId: "historical-answer-only", target: "planner", taskFingerprint: evidence("fresh").taskFingerprint,
    stepContext: { goal: "二月为负值" }, budget: { maxItems: 12, maxTokens: 4000 } }), undefined, "case facts must not select a method for an unrelated new goal");
});

test("scoped mappings without boundaries and undeclared method parameters are rejected", async () => {
  for (const invalid of ["scope", "parameter", "case-source"]) {
    const store = new InMemoryMemoryStore();
    const result = await settle(store, invalid, model((_input, output) => {
      if (invalid === "scope") output.reusableKnowledge = [{ kind: "scoped_rule", rule: "Use M42", trigger: "lookup", action: "query", verification: "check output", conditions: [], recheckRules: [], evidenceRefs: ["observation_1"] }];
      if (invalid === "parameter") output.classicPath[0].objective = "读取 {{undeclared_subject}}";
      if (invalid === "case-source") output.caseFacts = [{ statement: "历史数值", context: ["原始任务"], evidenceRefs: ["invented-source"] }];
    }));
    assert.notEqual(result.status, "succeeded");
    assert.equal((await store.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), false);
  }
});

test("no-learning may omit descriptive text while actionable methods still require it", async () => {
  const empty = (actionable: boolean) => model((_input, output) => {
    output.title = ""; output.goalSummary = "";
    if (!actionable) { output.learningValue = { status: "insufficient", reason: "只有重复观测，没有新的方法" }; output.classicPath = []; output.toolUsage = []; }
  });
  const audit = new InMemoryMemoryStore();
  assert.equal((await settle(audit, "no-learning", empty(false))).status, "succeeded");
  assert.equal((await audit.active(scope)).some(({ item }) => item.subtype === "experience.task_group"), false);
  assert.notEqual((await settle(new InMemoryMemoryStore(), "actionable", empty(true))).status, "succeeded");
});

test("support reconciliation cannot silently certify legacy learning under the new abstraction contract", async () => {
  const store = new InMemoryMemoryStore();
  await settleBatch(store, [evidence("one"), evidence("two")]);
  const entries = (await store.active(scope)).filter(({ item }) => item.subtype !== "experience.episode");
  for (const { item, revision } of entries) {
    const { learningContract: _contract, ...oldValue } = revision.value;
    const { learningContract: _learningContract, reuse: _reuse, caseFacts: _facts, ...oldLearning } = oldValue.taskGroup as Record<string, unknown>;
    await store.commit(scope, { schema: "agentloop.userMemoryCandidate/v1", id: `legacy:${item.id}`, ...scope,
      proposedKind: "experience", proposedSubtype: item.subtype, proposedCanonicalKey: item.canonicalKey,
      proposedValue: { ...oldValue, taskGroup: oldLearning }, proposedContentMarkdown: revision.contentMarkdown,
      proposedExperienceMaturity: revision.experienceMaturity, activation: revision.activation, applicationTargets: revision.applicationTargets,
      persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal", confidence: 0.7, sourceRefs: revision.sourceRefs, reason: "legacy_fixture", decision: "accepted" }, 1);
  }
  const legacy = (await store.active(scope)).filter(({ item }) => item.subtype !== "experience.episode");
  await settle(store, "one", model((_input, output) => { output.learningValue = { status: "insufficient", reason: "只有重复证据" }; output.classicPath = []; output.toolUsage = []; }));
  const after = await store.active(scope);
  for (const entry of legacy) assert.equal(after.find(({ item }) => item.id === entry.item.id)!.revision.id, entry.revision.id);
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: batch publication accumulates independent support, preserves reinforcement and suspends conflicts`, async () => {
  const database = kind === "sqlite" ? new AppDatabase(":memory:") : undefined;
  const store = database ? new SqliteMemoryStore(database) : new InMemoryMemoryStore();
  const plugin = createMemoryPlugin({ store, resolveRunScope: async runId => ({ ...scope, runId }) });
  const recall = () => plugin.recall({ runId: "fresh", target: "planner", taskFingerprint: evidence("fresh").taskFingerprint, budget: { maxItems: 6, maxTokens: 2000 } });
  const currentOnly = model((input, output) => {
    output.merge.supportingEpisodeIds = [input.currentEpisodeId];
    output.classicPath[0].evidenceRefs = [`episode_${input.episodeIds.length}_observation_1`];
    output.toolUsage[0].evidenceRefs = [`episode_${input.episodeIds.length}_observation_1`];

  });
  try {
    await settleBatch(store, [evidence("ignored-a"), evidence("one")], currentOnly);
    assert.equal(await recall(), undefined);
    await settleBatch(store, [evidence("ignored-b"), evidence("two")], currentOnly);
    const active = await store.active(scope);
    const group = active.find(({ item }) => item.subtype === "experience.task_group")!;
    assert.deepEqual(group.revision.value.successfulRunIds, ["one", "two"]);
    assert.equal((group.revision.value.supportingEpisodeRevisionIds as string[]).length, 2);
    assert.equal((group.revision.value.taskGroup as any).classicPath[0].objective, learning().classicPath[0].objective);
    const projection = await recall();
    assert.equal(projection?.target, "planner");
    if (projection?.target === "planner") assert.equal(projection.planningPriors.length, 1);
    const otherUser = createMemoryPlugin({ store, resolveRunScope: async runId => ({ ...scope, ownerUserId: "bob", runId }) });
    assert.equal(await otherUser.recall({ runId: "fresh", target: "planner", taskFingerprint: evidence("fresh").taskFingerprint, budget: { maxItems: 6, maxTokens: 2000 } }), undefined);
    await settleBatch(store, [evidence("three"), evidence("four")], model((_input, output) => {
      output.merge.decision = "contradict"; output.merge.conflicts = ["同类来源出现不同汇总口径"];
    }));
    assert.equal(await recall(), undefined);
    await settleBatch(store, [evidence("five"), evidence("six")]);
    assert.equal(await recall(), undefined, "reinforcement cannot silently clear an unresolved conflict");
  } finally { await database?.close(); }
});

test("batch replay retries publication after a committed group without repeating fusion or duplicating support", async () => {
  const store = new InMemoryMemoryStore();
  const values = [evidence("one"), evidence("two")];
  let calls = 0, fail = true;
  const localModel = model(() => { calls += 1; });
  const commit = store.commit.bind(store);
  store.commit = async (...args) => {
    if (fail && args[1].proposedSubtype === "experience.procedure") throw new Error("publication_interrupted");
    return commit(...args);
  };
  await assert.rejects(settleBatch(store, values, localModel), /publication_interrupted/);
  fail = false;
  assert.equal((await settleBatch(store, values, localModel)).reason, "already_fused");
  assert.equal((await settleBatch(store, values, localModel)).reason, "already_fused");
  assert.equal(calls, 1);
  const active = await store.active(scope);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.procedure").length, 1);
  assert.deepEqual(active.find(({ item }) => item.subtype === "experience.task_group")!.revision.value.successfulRunIds, ["one", "two"]);
});

test("replay finds a completed batch outside the bounded fusion candidate window", async () => {
  const store = new InMemoryMemoryStore();
  let calls = 0;
  const separate = model((_input, output) => { calls++; output.merge.decision = "new"; delete output.merge.targetGroupId; });
  const cases = Array.from({ length: 6 }, (_, i) => ({ ...evidence(`family-${i}`), strategy: `独立任务族 ${i}` }));
  for (const value of cases) await settleBatch(store, [value], separate);
  assert.equal(calls, 6);
  await settleBatch(store, [cases[5]!], separate);
  assert.equal(calls, 6, "replay checkpoints must not be truncated with retrieval candidates");
});

test("multiple commits of one Run and unverified cases cannot publish a batch procedure", async () => {
  const store = new InMemoryMemoryStore();
  await settleBatch(store, [evidence("same"), { ...evidence("same"), terminalCommitRef: "outcome:same:recommit" }]);
  assert.equal((await store.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), false);
  await settleBatch(store, [evidence("failed"), evidence("disputed")].map(value => ({ ...value, quality: { ...value.quality, laterDisputed: true } })));
  assert.equal((await store.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), false);
});

test("a batch containing a previously fused last case still learns its new cases", async () => {
  const store = new InMemoryMemoryStore();
  let calls = 0;
  const localModel = model(() => { calls += 1; });
  await settleBatch(store, [evidence("one"), evidence("two")], localModel);
  await settleBatch(store, [evidence("three"), evidence("two")], localModel);
  assert.equal(calls, 2);
  assert.deepEqual((await store.active(scope)).find(({ item }) => item.subtype === "experience.task_group")!.revision.value.successfulRunIds, ["one", "two", "three"]);
});

test("batch fusion receives sanitized execution and acceptance evidence rather than placeholder learning", async () => {
  const store = new InMemoryMemoryStore();
  const values = ["one", "two"].map(runId => ({ ...evidence(runId), observations: [{
    id: "a", kind: "action" as const, toolName: "source.read", status: "succeeded",
    summary: "读取星河科技有限公司的数据；先 describe-catalog，再按组织代码查最新月份；password=private-value",
    sourceRefs: [{ type: "action" as const, runId, sourceId: "a" }],
  }, { id: "qa", kind: "assessment" as const, status: "approved", summary: "组织范围和报表月份核对一致", sourceRefs: [{ type: "assessment" as const, runId }] }] }));
  await settleBatch(store, values, model((input, output) => {
    assert.equal(JSON.stringify(input).includes("等待批量案例归纳"), false);
    assert.equal(JSON.stringify(input).includes("星河科技有限公司"), false);
    assert.equal(JSON.stringify(input).includes("private-value"), false);
    assert.match(input.episodes[0].observations[0].summary, /describe-catalog/);
    assert.equal(input.episodes[0].verification.assessmentApproved, true);
    assert.equal(input.episodes[0].observations[1].status, "approved");
    const ref = input.episodes[0].observations[0].evidenceRefs[0];
    assert.ok(ref in input.sources);
    output.classicPath[0].evidenceRefs = input.episodes.flatMap((episode: any) => episode.observations[0].evidenceRefs);
  }));
  assert.equal((await store.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), true);
});

test("batch input budgeting retains its current case and removes references to omitted evidence", async () => {
  const store = new InMemoryMemoryStore();
  const values = Array.from({ length: 10 }, (_, index) => ({ ...evidence(`run-${index}`), observations: Array.from({length:24}, (_item, i) => ({
    id: `a-${i}`, kind: "action" as const, toolName: "source.read", status: "succeeded", summary: "具体执行方法及验证结果".repeat(60), sourceRefs: [{type:"action" as const, runId:`run-${index}`}],
  })) }));
  await settleBatch(store, values, model((input) => {
    assert.ok(input.episodeIds.includes(input.currentEpisodeId));
    assert.ok(input.episodes.length < 10);
    assert.equal(input.episodes.at(-1).id, input.currentEpisodeId);
    assert.equal(Object.keys(input.sources).some(key => key.startsWith("episode_9_")), false);
    assert.ok(JSON.stringify(input).length <= 60_000);
  }));
});

test("a mature group's new rule needs its own independent evidence", async () => {
  const store = new InMemoryMemoryStore();
  await settleBatch(store, [evidence("one"), evidence("two")]);
  const rule = { kind: "method", rule: "核对来源版本后再执行", trigger: "来源发生变化", action: "重新读取版本并核对字段", verification: "版本和字段一致", conditions: ["来源可读取版本"], recheckRules: [], evidenceRefs: [] as string[] };
  const refine = model((input, output) => {
    output.merge.decision = "refine";
    output.reusableKnowledge = [{ ...rule, evidenceRefs: [input.episodes[0].observations[0].evidenceRefs[0]] }];
  });
  await settleBatch(store, [evidence("three")], refine);
  let active = await store.active(scope);
  let group = active.find(({ item }) => item.subtype === "experience.task_group")!;
  assert.equal((group.revision.value.knowledgeUnits as any[]).find(unit => unit.section === "reusableKnowledge").status, "candidate");
  let procedure = active.find(({ item }) => item.subtype === "experience.procedure")!;
  assert.deepEqual((procedure.revision.value.settlementPattern as any).reusableKnowledge, []);
  await settleBatch(store, [evidence("four")], refine);
  active = await store.active(scope);
  procedure = active.find(({ item }) => item.subtype === "experience.procedure")!;
  assert.equal((procedure.revision.value.settlementPattern as any).reusableKnowledge[0].rule, rule.rule);
});

test("repeated inherited Results and plan-only evidence cannot independently verify a method", async () => {
  const inherited = new InMemoryMemoryStore();
  await settleBatch(inherited, [evidence("one"), evidence("two")].map(value => ({ ...value,
    dependencies: [{ kind: "prior_result", id: "same-result", sourceRunId: "original", sourceRefs: value.sourceRefs }],
  })));
  assert.equal((await inherited.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), false);
  const planned = new InMemoryMemoryStore();
  await settleBatch(planned, [evidence("one"), evidence("two")], model((input, output) => {
    output.classicPath[0].evidenceRefs = Object.keys(input.sources).filter(key => key.endsWith("_step_1"));
  }));
  assert.equal((await planned.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), false);
});

test("a complete path needs each step verified in each supporting execution", async () => {
  const store = new InMemoryMemoryStore();
  await settleBatch(store, [evidence("one"), evidence("two")], model((_input, output) => {
    const first = { ...output.classicPath[0], evidenceRefs: ["episode_1_observation_1"] };
    output.classicPath = [first, { ...first, objective: "核对交付结果", evidenceRefs: ["episode_2_observation_1"] }];
  }));
  assert.equal((await store.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), false);
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: changed evidence retracts support even when the model finds no new learning`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
  t.after(() => db?.close());
  const store = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  const values = [evidence("one"), evidence("two")];
  await settleBatch(store, values);
  const before = (await store.active(scope)).find(({ item }) => item.subtype === "experience.episode" && item.canonicalKey?.includes("episode:one:"))!;
  let calls = 0;
  const noLearning = model((_input, output) => {
    calls++;
    output.learningValue = { status: "insufficient", reason: "后续反馈否定了原验证" };
    output.classicPath = []; output.toolUsage = []; output.merge.decision = "no_learning";
  });
  const corrected = values.map(value => value.runId === "one" ? { ...value, quality: { ...value.quality, laterCorrected: true } } : value);
  await settleBatch(store, corrected, noLearning);
  const active = await store.active(scope);
  assert.notEqual(active.find(({ item }) => item.id === before.item.id)!.revision.id, before.revision.id);
  assert.equal(active.find(({ item }) => item.subtype === "experience.procedure")!.revision.activation.mode, "explicit_only");
  const plugin = createMemoryPlugin({ store, resolveRunScope: async runId => ({ ...scope, runId }) });
  assert.equal(await plugin.recall({ runId: "fresh", target: "planner", taskFingerprint: values[0]!.taskFingerprint, budget: { maxItems: 6, maxTokens: 2000 } }), undefined);
  assert.equal(calls, 1);
});

test("mixed goals sharing task labels and tools are settled separately with aligned replay IDs", async () => {
  const store = new InMemoryMemoryStore();
  const values = [evidence("writing"), evidence("research"), evidence("writing-again")].map((value, i) => ({ ...value,
    taskFingerprint: { taskKind: "composite", artifactKind: "html" }, strategy: i === 1 ? "Research competing technical mechanisms" : "Write a quarterly management report",
  }));
  let calls = 0;
  const separate = model((_input, output) => { calls++; output.merge.decision = "new"; delete output.merge.targetGroupId; });
  const first = await settleBatch(store, values, separate);
  assert.equal(calls, 2);
  assert.equal(first.reason, "multiple_goal_groups_settled");
  assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.task_group").length, 2);
  const replay = await settleBatch(store, values, separate);
  assert.deepEqual(replay.episodeRevisionIds, first.episodeRevisionIds);
  assert.equal(calls, 2);
});

test("semantic families compare independent cases across changed subjects and periods before publishing a method", async () => {
  const store = new InMemoryMemoryStore();
  const values = [evidence("subject-one"), evidence("subject-two")].map((value, index) => ({ ...value,
    strategy: index ? "分析乙主体2026年第一季度的指标趋势" : "分析甲主体2025年上半年的指标趋势" }));
  let partitions = 0, fusions = 0;
  const fusion = model((input, output) => {
    assert.equal(input.stage, "fusion"); assert.equal(input.episodes.length, 2); fusions++;
    output.classicPath[0].objective = "核对 {{subject}} 和 {{period}} 后查询指标并分析趋势";
  });
  const grouped: MemorySettlementModel = { modelKey: "local:grouped", complete: async request => {
    const input = request.input as Record<string, any>;
    if (input.stage !== "grouping") return fusion.complete(request);
    partitions++;
    assert.notEqual(input.cases[0].goal, input.cases[1].goal);
    return { content: JSON.stringify({ schema: "agentloop.experienceFamilies/v1", groups: [{ caseIds: input.cases.map((value: any) => value.id), rationale: "主体和期间变化，查询与验证机制相同" }] }) };
  } };
  await settleBatch(store, values, grouped);
  assert.equal(partitions, 1); assert.equal(fusions, 1);
  const active = await store.active(scope);
  const procedure = active.find(({ item }) => item.subtype === "experience.procedure")!;
  assert.equal(procedure.revision.activation.mode, "task_match");
  assert.equal((procedure.revision.value.knowledgeUnits as any[])[0].supports.length, 2);
  await settleBatch(store, values, grouped);
  assert.equal(partitions, 1, "validated family assignments are stable replay checkpoints");
  assert.equal(fusions, 1);
});

test("batch support may come from relevant new cases without forcing the arbitrary last case", async () => {
  const store = new InMemoryMemoryStore();
  await settleBatch(store, [evidence("one"), evidence("two"), { ...evidence("last-failed"), terminalStatus: "failed" }], model((input, output) => {
    output.merge.supportingEpisodeIds = input.episodeIds.slice(0, 2);
    output.classicPath[0].evidenceRefs = ["episode_1_observation_1", "episode_2_observation_1"];
    output.toolUsage[0].evidenceRefs = output.classicPath[0].evidenceRefs;
  }));
  const procedure = (await store.active(scope)).find(({ item }) => item.subtype === "experience.procedure")!;
  assert.equal(procedure.revision.activation.mode, "task_match");
  assert.deepEqual((procedure.revision.value.knowledgeUnits as any[])[0].supports.map((support: any) => support.runId), ["one", "two"]);
});

test("family partitioning rejects missing, duplicated or invented cases instead of losing an execution", async () => {
  for (const ids of [["case_0"], ["case_0", "case_0"], ["case_0", "invented"]]) {
    const store = new InMemoryMemoryStore();
    await assert.rejects(settleBatch(store, [evidence("one"), { ...evidence("two"), strategy: "不同参数的任务" }], {
      modelKey: "local:invalid-partition", complete: async () => ({ content: JSON.stringify({ schema: "agentloop.experienceFamilies/v1", groups: [{ caseIds: ids, rationale: "invalid fixture" }] }) }),
    }), /settlement_v2:grouping/);
    assert.equal((await store.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), false);
  }
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: partial batches flush at a bounded age without spending attempts while waiting`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
  t.after(() => db?.close());
  const store = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  const value = evidence("partial");
  let now = 1000;
  const worker = new MemorySettlementWorker({ store, reader: { read: async () => value }, settlementModel: model(),
    requireSettlementModel: true, consolidate: true, experienceBatchSize: 10, maxBatchWaitMs: 100, now: () => now });
  await store.enqueueSettlement({ scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now });
  for (let i = 0; i < 5; i++) assert.equal((await worker.runOnce()).reason, "waiting_for_experience_batch");
  now = 1100;
  assert.equal((await worker.runOnce()).status, "succeeded");
  const jobs = await store.settlementJobs(scope, value.runId);
  assert.equal(jobs[0]!.attempts, 1);
  assert.equal(jobs[0]!.status, "succeeded");
});

test("confirmed causes require causal evidence; single-task fusion preserves that evidence", async () => {
  const withLesson = model((input, output) => {
    const ref = Object.keys(input.sources).find(key => key.endsWith("observation_1"))!;
    output.failureLessons = [{ trigger: "字段版本变化", symptom: "字段读取失败", rootCause: "版本切换后字段已重命名", causeStatus: "confirmed",
      nextAction: "读取当前版本字段定义", verification: "对照版本和实际字段确认", applicability: ["字段定义可核对"], evidenceRefs: [ref] }];
  });
  await assert.rejects(settleBatch(new InMemoryMemoryStore(), [evidence("unconfirmed")], withLesson), /causal_verification_required/);
  const value = evidence("confirmed");
  const result = await settle(new InMemoryMemoryStore(), value.runId, withLesson, { observations: value.observations!.map(item => ({ ...item, details: { causalVerification: true } })) });
  assert.equal(result.status, "succeeded", result.reason);
});

test("canonical correction suspends a single-task procedure before an unavailable model is called", async () => {
  const store = new InMemoryMemoryStore();
  await settle(store, "one");
  await settle(store, "two");
  await store.replaySettlement(scope, "one", 1000);
  const result = await settle(store, "one", { modelKey: "unavailable", complete: async () => { throw new Error("offline"); } },
    { quality: { ...evidence("one").quality, laterDisputed: true } });
  assert.equal(result.status, "retrying");
  assert.equal((await store.active(scope)).find(({ item }) => item.subtype === "experience.procedure")!.revision.activation.mode, "explicit_only");
});

test("changed successful evidence retracts old claim support until the method is verified again", async () => {
  const store = new InMemoryMemoryStore();
  await settleBatch(store, [evidence("one"), evidence("two")]);
  await settleBatch(store, [{ ...evidence("one"), observations: [] }], model((_input, output) => {
    output.learningValue = { status: "insufficient", reason: "已无执行证据" }; output.classicPath = []; output.toolUsage = []; output.merge.decision = "no_learning";
  }));
  assert.equal((await store.active(scope)).find(({ item }) => item.subtype === "experience.procedure")!.revision.activation.mode, "explicit_only");
});

test("batch Episodes persist bounded HIL evidence even when no procedure is learned", async () => {
  const store = new InMemoryMemoryStore();
  const value = evidence("decision");
  await settleBatch(store, [{ ...value, observations: [{ id: "choice", kind: "decision", status: "user_confirmed", summary: "选择本次使用的模板",
    details: { question: "选择本次模板", candidates: [{ id: "a", label: "模板 A" }, { id: "b", label: "模板 B" }],
      selectedOptions: [{ id: "b", identityRefs: ["template:b"], password: "private-value" }], persistenceIntent: "task_only" },
    sourceRefs: [{ type: "event", runId: value.runId, sourceId: "decision:1" }] }] }], model((_input, output) => {
    output.learningValue = { status: "insufficient", reason: "仅有本次选择" }; output.classicPath = []; output.toolUsage = []; output.merge.decision = "no_learning";
  }));
  const active = await store.active(scope);
  assert.equal(active.length, 1);
  const audit = active[0]!.revision.value.evidenceAudit as any;
  assert.equal(audit.observations[0].details.persistenceIntent, "task_only");
  assert.deepEqual(audit.observations[0].details.selectedOptions[0].identityRefs, ["template:b"]);
  assert.equal(audit.observations[0].sourceRefs[0].sourceId, "decision:1");
  assert.equal(JSON.stringify(audit).includes("private-value"), false);
});

for (const backend of ["memory", "sqlite"] as const) test(`${backend}: retry backoff and unauthorized queues cannot starve an eligible partial batch`, async t => {
  const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
  t.after(() => db?.close());
  const store = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
  const other = { ...scope, ownerUserId: "bob" };
  for (const runId of ["blocked-1", "blocked-2"]) await store.enqueueSettlement({ scope: other, runId, terminalCommitRef: `outcome:${runId}`, now: 1000 });
  const claimed = await store.claimSettlementBatch({ scope: other, now: 1000, maxAttempts: 3, limit: 2 });
  for (const job of claimed) await store.finishSettlement({ job, outcome: "failed", now: 1000, maxAttempts: 3 });
  const value = evidence("ready");
  await store.enqueueSettlement({ scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now: 1000 });
  const candidates = await store.settlementBatchCandidates({ minimum: 1, maxAttempts: 3, now: 1100 });
  assert.deepEqual(candidates.map(item => item.scope.ownerUserId), ["alice"]);
  const worker = new MemorySettlementWorker({ store, reader: { read: async () => value }, settlementModel: model(),
    requireSettlementModel: true, consolidate: true, experienceBatchSize: 10, maxBatchWaitMs: 100, now: () => 2100, allowedRunIds: ["ready"] });
  assert.equal((await worker.runOnce()).status, "succeeded");
  assert.equal((await store.settlementJobs(other, "blocked-1"))[0]!.attempts, 1);
});

test("settlement honors the provider completion deadline instead of cancelling at sixty seconds", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new InMemoryMemoryStore();
  const base = model();
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const operation = settleBatch(store, [evidence("one"), evidence("two")], {
    ...base, completeTimeoutMs: 120_000, complete: async input => {
      signal = input.signal;
      await pending;
      return base.complete(input);
    },
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  context.mock.timers.tick(60_001);
  assert.equal(signal?.aborted, false);
  release();
  assert.equal((await operation).reason, "task_group_updated");
});

test("batch publication retains action provenance and namespaces earlier group evidence during refinement", async () => {
  const store = new InMemoryMemoryStore();
  await settleBatch(store, [evidence("one"), evidence("two")], model((input, output) => {
    output.classicPath[0].evidenceRefs = input.episodes[0].observations[0].evidenceRefs;
  }));
  let group = (await store.active(scope)).find(({ item }) => item.subtype === "experience.task_group")!;
  assert.ok(group.revision.sourceRefs.some(ref => ref.type === "action" && ref.runId === "one"));
  await settleBatch(store, [evidence("three"), evidence("four")], model((input, output) => {
    const ref = input.similarTaskGroups[0].learning.classicPath[0].evidenceRefs[0];
    assert.match(ref, /^group_1_episode_1_observation_1$/);
    assert.ok(ref in input.sources);
    output.merge.decision = "refine";
    output.classicPath[0].evidenceRefs = [ref];
  }));
  group = (await store.active(scope)).find(({ item }) => item.subtype === "experience.task_group")!;
  const sources = group.revision.value.knowledgeSources as Record<string, any[]>;
  assert.equal(sources.group_1_episode_1_observation_1[0].runId, "one");
});

test("fusion schema exposes only admitted sources, canonical Skills and existing group choices", async () => {
  const base = model();
  await settleBatch(new InMemoryMemoryStore(), [evidence("one"), evidence("two")], {
    ...base, complete: async request => {
      const schema = JSON.parse(request.systemPrompt.split("\n")[2]!);
      assert.deepEqual(schema.properties.merge.properties.decision.enum, ["new", "no_learning"]);
      assert.equal("targetGroupId" in schema.properties.merge.properties, false);
      assert.deepEqual(schema.properties.classicPath.items.properties.skillIds.items.enum, ["discovered:hr-data"]);
      assert.deepEqual(schema.properties.classicPath.items.properties.evidenceRefs.items.enum, Object.keys(request.input.sources as object));
      return base.complete(request);
    },
  });
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: deleted Run is discarded without consuming other batch attempts`, async () => {
  const database = kind === "sqlite" ? new AppDatabase(":memory:") : undefined;
  const store = database ? new SqliteMemoryStore(database) : new InMemoryMemoryStore();
  try {
    const values = ["good-a", "deleted", "good-b", "good-c"].map(evidence);
    for (const value of values.slice(0, 3)) await store.enqueueSettlement({ scope: value.scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now: 1000 });
    const worker = new MemorySettlementWorker({ store, experienceBatchSize: 3, now: () => 1000, settlementModel: model(),
      reader: { read: async ({ runId }) => runId === "deleted" ? undefined : values.find(value => value.runId === runId), isDeleted: async ({ runId }) => runId === "deleted" } });
    assert.equal((await worker.runOnce()).reason, "deleted_run_discarded");
    assert.equal((await store.settlementBatchCandidates({ minimum: 1, maxAttempts: 3, now: 1000 }))[0]?.count, 2);
    await store.enqueueSettlement({ scope, runId: values[3]!.runId, terminalCommitRef: values[3]!.terminalCommitRef, now: 1000 });
    const result = await worker.runOnce();
    assert.equal(result.status, "succeeded", result.reason);
    assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.episode").length, 3);
  } finally { await database?.close(); }
});

test("unconfirmed missing evidence is retried separately and does not consume other jobs", async () => {
  const store = new InMemoryMemoryStore();
  const values = ["good", "unknown", "other"].map(evidence);
  for (const value of values) await store.enqueueSettlement({ scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, now: 1000 });
  const worker = new MemorySettlementWorker({ store, experienceBatchSize: 3, now: () => 1000,
    reader: { read: async ({ runId }) => runId === "unknown" ? undefined : values.find(value => value.runId === runId), isDeleted: async () => false } });
  assert.match((await worker.runOnce()).reason!, /settlement_evidence_not_available:unknown/);
  const jobs = await store.claimSettlementBatch({ scope, now: 1000, maxAttempts: 3, limit: 3 });
  assert.deepEqual(jobs.map(job => [job.runId, job.attempts]), [["good", 1], ["other", 1]]);
  for (const job of jobs) await store.releaseSettlement(job);
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
    assert.match(String(projection.planningPriors[0]!.suggestedSteps[0]!.objective), /组织代码和最新报表月份/);
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
