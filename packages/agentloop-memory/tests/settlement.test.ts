import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMemoryStore, MemorySettlementWorker as SettlementWorker, consolidateProcedures, createMemoryPlugin, experienceCandidateFromEvidence, renderTaskGroupMarkdown, searchTaskGroupCandidates } from "../src/index.ts";
import type { MemorySettlementEvidence, MemoryRunScope } from "../src/types.ts";

const scope: MemoryRunScope = { tenantId: "tenant-1", ownerUserId: "user-a", runId: "run-1" };

// These tests specify the historical v1 compatibility contract. Production defaults to v2.
class MemorySettlementWorker extends SettlementWorker {
  constructor(options: ConstructorParameters<typeof SettlementWorker>[0]) {
    super({ ...options, settlementPromptSchemaVersion: "agentloop.semanticSettlement/v1" });
  }
}

function evidence(overrides: Partial<MemorySettlementEvidence> = {}): MemorySettlementEvidence {
  return {
    scope,
    runId: scope.runId,
    terminalCommitRef: "outcome-1",
    terminalStatus: "completed",
    taskFingerprint: { taskKind: "report", domain: "sales", artifactKind: "xlsx" },
    strategy: "先读取来源，再生成并校验报表。",
    keyDecisions: ["使用来源表作为唯一输入"],
    reusableKnowledge: [{
      rule: "先固定来源口径再汇总",
      conditions: ["同类报表任务且存在结构化来源"],
      exclusions: [],
      trigger: "任务依赖外部来源数据",
      decision: "先校验来源范围和统计口径",
      rationale: "避免后续汇总建立在不完整输入上",
      action: "读取全部来源并记录口径后再生成报表",
      expectedEvidence: ["source_summary", "artifact_acceptance"],
    }],
    quality: {
      terminalCommitted: true,
      assessmentApproved: true,
      artifactVerified: true,
      laterCorrected: false,
      laterDisputed: false,
      evidenceCoverage: 0.9,
    },
    sourceRefs: [
      { type: "run", runId: scope.runId },
      { type: "outcome", runId: scope.runId, sourceHash: "outcome-1" },
    ],
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("completed outcome without Assessment is not promoted to a positive episode", () => {
  const candidate = experienceCandidateFromEvidence(evidence({ quality: { terminalCommitted: true, assessmentApproved: false, laterCorrected: false, laterDisputed: false } }));
  assert.equal(candidate, undefined);
});
test("a completed-but-caveated outcome can retain a failure lesson without becoming a success", () => {
  const candidate = experienceCandidateFromEvidence(evidence({
    quality: { terminalCommitted: true, assessmentApproved: false, laterCorrected: false, laterDisputed: false },
    failureLessons: ["交付前未补齐 artifact acceptance 证据。"],
  }));
  assert.equal(candidate?.proposedExperienceMaturity, "episode");
  const pattern = candidate?.proposedValue.settlementPattern as { outcome: string; failureLessons: readonly { lesson: string }[] };
  assert.equal(pattern.outcome, "failure");
  assert.equal(pattern.failureLessons[0]?.lesson.includes("artifact acceptance"), true);
});

test("verified success without actionable learning remains an episode and cannot form a procedure", async () => {
  const store = new InMemoryMemoryStore();
  for (const runId of ["run-no-learning-1", "run-no-learning-2"] as const) {
    const runScope = { ...scope, runId };
    await store.enqueueSettlement({ scope: runScope, runId, terminalCommitRef: `${runId}-outcome`, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({
        scope: runScope,
        runId,
        terminalCommitRef: `${runId}-outcome`,
        reusableKnowledge: [],
        failureLessons: [],
        cautions: ["注意验收"],
      }) },
      now: () => 1000,
      consolidate: true,
    });
    assert.equal((await worker.runOnce()).status, "succeeded");
  }
  const episodes = (await store.active(scope)).filter(({ item }) => item.subtype === "experience.episode");
  assert.equal(episodes.length, 2);
  assert.equal((episodes[0]?.revision.value.settlementPattern as { learningValue?: { status: string } }).learningValue?.status, "insufficient");
  assert.equal((await consolidateProcedures(store, scope, 2000)).every((item) => item.status === "skipped"), true);
  assert.equal((await store.active(scope)).some(({ item }) => item.subtype === "experience.procedure"), false);
});

test("worker settles a verified completed outcome once and is idempotent", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "outcome-1", now: 1000 });
  const worker = new MemorySettlementWorker({ store, reader: { read: async () => evidence() }, now: () => 1000 });
  const first = await worker.runOnce();
  const second = await worker.runOnce();
  assert.equal(first.status, "succeeded");
  assert.equal(first.reason, "episode_committed");
  assert.equal(second.status, "empty");
  const active = await store.active(scope);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.item.subtype, "experience.episode");
  assert.deepEqual(active[0]?.revision.applicationTargets, ["planner"]);
  assert.equal(active[0]?.revision.sourceRefs.some((ref) => ref.type === "outcome" && ref.sourceHash === "outcome-1"), true);
  const pattern = active[0]?.revision.value.settlementPattern as { schema?: string; phase?: string; outcome?: string; keySteps?: unknown[]; reusableKnowledge?: unknown[]; references?: unknown[] } | undefined;
  assert.equal(pattern?.schema, "agentloop.experienceSettlement/v1");
  assert.equal(pattern?.phase, "episode");
  assert.equal(pattern?.outcome, "verified_success");
  assert.equal(Array.isArray(pattern?.keySteps), true);
  assert.equal(Array.isArray(pattern?.reusableKnowledge), true);
  assert.equal(Array.isArray(pattern?.references), true);
});

test("local settlement model may generalize only admitted tools and preserves canonical verification", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "semantic-outcome", now: 1000 });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({
      terminalCommitRef: "semantic-outcome",
      planSkeleton: [{ objective: "获取并验证来源", toolNames: ["source.read"], requiredEvidenceKinds: ["source_summary"], producedEvidenceKinds: ["source_summary"] }],
    }) },
    settlementModel: {
      modelKey: "local:test-model",
      complete: async () => ({ content: JSON.stringify({
        schema: "agentloop.semanticSettlement/v1",
        learningValue: { status: "actionable", novelty: "reinforcement", transferability: "task_family", actionChange: "先验证来源", verification: "source_summary 已记录" },
        classicPath: [{ order: 1, objective: "先验证来源，再执行目标步骤", toolNames: ["source.read"] }],
        toolUsage: [{ toolName: "source.read", purpose: "读取来源" }],
        cautions: ["不要跳过来源验证"],
      }) }),
    },
    now: () => 1000,
  });
  assert.equal((await worker.runOnce()).status, "succeeded");
  const revision = (await store.active(scope))[0]?.revision;
  const pattern = revision?.value.settlementPattern as { classicPath: readonly { objective: string; requiredEvidenceKinds: readonly string[] }[]; cautions: readonly string[] };
  assert.equal(pattern.classicPath[0]?.objective, "先验证来源，再执行目标步骤");
  assert.deepEqual(pattern.classicPath[0]?.requiredEvidenceKinds, ["source_summary"]);
  assert.deepEqual(pattern.cautions, ["不要跳过来源验证"]);
  assert.equal(revision?.value.settlementModelKey, "local:test-model");
  assert.equal(revision?.value.settlementValidationResult, "accepted");
});

test("invalid semantic tool output falls back to deterministic settlement", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "semantic-invalid", now: 1000 });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ terminalCommitRef: "semantic-invalid", planSkeleton: [{ objective: "读取来源", toolNames: ["source.read"], requiredEvidenceKinds: [], producedEvidenceKinds: [] }] }) },
    settlementModel: { modelKey: "local:test-model", complete: async () => ({ content: JSON.stringify({ schema: "agentloop.semanticSettlement/v1", toolUsage: [{ toolName: "invented.tool" }] }) }) },
    now: () => 1000,
  });
  assert.equal((await worker.runOnce()).status, "succeeded");
  const revision = (await store.active(scope))[0]?.revision;
  assert.equal(revision?.value.settlementValidationResult, "rejected");
  assert.deepEqual((revision?.value.settlementPattern as { toolUsage: readonly { toolName: string }[] }).toolUsage.map((item) => item.toolName), ["source.read"]);
});

test("semantic model can explicitly reject a generic reminder as insufficient learning", async () => {
  const store = new InMemoryMemoryStore();
  for (const runId of ["run-semantic-no-learning-1", "run-semantic-no-learning-2"] as const) {
    const runScope = { ...scope, runId };
    await store.enqueueSettlement({ scope: runScope, runId, terminalCommitRef: `${runId}-outcome`, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({ scope: runScope, runId, terminalCommitRef: `${runId}-outcome`, reusableKnowledge: [] }) },
      settlementModel: {
        modelKey: "local:test-model",
        complete: async () => ({ content: JSON.stringify({
          schema: "agentloop.semanticSettlement/v1",
          learningValue: { status: "insufficient", novelty: "none", transferability: "unknown" },
          cautions: ["注意验收"],
        }) }),
      },
      consolidate: true,
      now: () => 1000,
    });
    assert.equal((await worker.runOnce()).status, "succeeded");
  }
  const active = await store.active(scope);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.procedure").length, 0);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.episode").length, 2);
  assert.equal((active[0]?.revision.value.settlementPattern as { learningValue?: { status: string }; reusableKnowledge?: unknown[] }).learningValue?.status, "insufficient");
  assert.deepEqual((active[0]?.revision.value.settlementPattern as { reusableKnowledge?: unknown[] }).reusableKnowledge, []);
});

test("strict settlement keeps an episode but retries instead of creating a procedure when the model is unavailable", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "strict-unavailable", now: 1000 });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ terminalCommitRef: "strict-unavailable" }) },
    requireSettlementModel: true,
    consolidate: true,
    now: () => 1000,
    maxAttempts: 2,
  });
  const first = await worker.runOnce();
  assert.equal(first.status, "retrying");
  assert.equal(first.reason, "settlement_model_required");
  const active = await store.active(scope);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.episode").length, 1);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.procedure").length, 0);
});

test("strict settlement rejects invalid model output without deterministic long-term fallback", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "strict-invalid", now: 1000 });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ terminalCommitRef: "strict-invalid", planSkeleton: [{ objective: "读取来源", toolNames: ["source.read"], requiredEvidenceKinds: [], producedEvidenceKinds: [] }] }) },
    settlementModel: { modelKey: "local:test-model", complete: async () => ({ content: JSON.stringify({ schema: "agentloop.semanticSettlement/v1", toolUsage: [{ toolName: "invented.tool" }] }) }) },
    requireSettlementModel: true,
    consolidate: true,
    now: () => 1000,
  });
  const result = await worker.runOnce();
  assert.equal(result.status, "retrying");
  assert.equal(result.reason, "semantic_model_invalid_output:learning_value_missing_or_invalid");
  const active = await store.active(scope);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.episode").length, 1);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.procedure").length, 0);
});

test("strict settlement diagnoses a model-invented tool without accepting it", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "strict-unadmitted-tool", now: 1000 });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ terminalCommitRef: "strict-unadmitted-tool", planSkeleton: [{ objective: "读取来源", toolNames: ["source.read"], requiredEvidenceKinds: [], producedEvidenceKinds: [] }] }) },
    settlementModel: { modelKey: "local:test-model", complete: async () => ({ content: JSON.stringify({
      schema: "agentloop.semanticSettlement/v1",
      learningValue: { status: "insufficient", novelty: "none", transferability: "unknown" },
      toolUsage: [{ toolName: "invented.tool" }],
    }) }) },
    requireSettlementModel: true,
    now: () => 1000,
  });
  const result = await worker.runOnce();
  assert.equal(result.status, "retrying");
  assert.equal(result.reason, "semantic_model_invalid_output:tool_usage_tool_not_admitted");
  const active = await store.active(scope);
  assert.equal(active.filter(({ item }) => item.subtype === "experience.procedure").length, 0);
});

test("authorized historical replay claims only listed Runs and excludes other Run memories from model input", async () => {
  const store = new InMemoryMemoryStore();
  const unrelatedScope = { ...scope, runId: "run-unrelated-history" };
  await store.enqueueSettlement({ scope: unrelatedScope, runId: unrelatedScope.runId, terminalCommitRef: "unrelated-outcome", now: 1000 });
  const unrelatedWorker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ scope: unrelatedScope, runId: unrelatedScope.runId, terminalCommitRef: "unrelated-outcome" }) },
    now: () => 1000,
  });
  assert.equal((await unrelatedWorker.runOnce()).status, "succeeded");

  const targetRunId = "run-authorized-history";
  const targetScope = { ...scope, runId: targetRunId };
  await store.enqueueSettlement({ scope: targetScope, runId: targetRunId, terminalCommitRef: "authorized-outcome", now: 1000 });
  let submittedInput: Readonly<Record<string, unknown>> | undefined;
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({
      scope: targetScope,
      runId: targetRunId,
      terminalCommitRef: "authorized-outcome",
      strategy: "Plan from Sensitive Place A to Sensitive Place B",
      planSkeleton: [{ objective: "Navigate from Sensitive Place A to Sensitive Place B", role: "fact_acquisition", toolNames: ["source.read"], requiredEvidenceKinds: ["source_summary"], producedEvidenceKinds: ["source_summary"] }],
    }) },
    allowedRunIds: [targetRunId],
    settlementModel: {
      modelKey: "local:test-model",
      complete: async ({ input }) => {
        submittedInput = input;
        return { content: JSON.stringify({
          schema: "agentloop.semanticSettlement/v1",
          learningValue: { status: "insufficient", novelty: "none", transferability: "unknown" },
        }) };
      },
    },
    requireSettlementModel: true,
    now: () => 1000,
  });
  assert.equal((await worker.runOnce()).status, "succeeded");
  assert.deepEqual(submittedInput?.similarEpisodes, []);
  assert.deepEqual(submittedInput?.similarTaskGroups, []);
  assert.equal(JSON.stringify(submittedInput).includes("Sensitive Place"), false);
  assert.equal((await worker.runOnce()).status, "empty");
});

test("strict settlement rejects actionable metadata without executable knowledge", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "strict-no-knowledge", now: 1000 });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ terminalCommitRef: "strict-no-knowledge", reusableKnowledge: [], failureLessons: [] }) },
    settlementModel: {
      modelKey: "local:test-model",
      complete: async () => ({ content: JSON.stringify({
        schema: "agentloop.semanticSettlement/v1",
        learningValue: {
          status: "actionable",
          novelty: "new",
          transferability: "task_family",
          actionChange: "先执行一个检查",
          verification: "检查结果存在",
        },
      }) }),
    },
    requireSettlementModel: true,
    consolidate: true,
    now: () => 1000,
  });
  const result = await worker.runOnce();
  assert.equal(result.status, "retrying");
  assert.equal(result.reason, "semantic_model_missing_actionable_knowledge");
  assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.episode").length, 1);
  assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.procedure").length, 0);
});

test("settlement preserves a generalized path and tools without promoting the concrete goal", () => {
  const candidate = experienceCandidateFromEvidence(evidence({
    strategy: "为宝信软件生成员工画像 HTML 报告",
    planSkeleton: [
      {
        objective: "获取并验证来源数据",
        role: "fact_acquisition",
        toolNames: ["hr-report-data"],
        requiredEvidenceKinds: ["source_summary", "explicit_caveats"],
        producedEvidenceKinds: ["source_summary"],
        cautions: ["记录来源月份、口径和行数"],
      },
      {
        objective: "生成并验收目标格式交付物",
        role: "produce",
        toolNames: ["workspace_artifact_write", "artifact_acceptance"],
        requiredEvidenceKinds: ["artifact_path", "artifact_non_empty", "artifact_openable"],
        producedEvidenceKinds: ["artifact_acceptance"],
      },
    ],
  }));
  const pattern = candidate?.proposedValue.settlementPattern as { classicPath: readonly { objective: string }[]; toolUsage: readonly { toolName: string }[]; cautions: readonly string[]; reusableKnowledge: readonly { rule: string }[] };
  assert.deepEqual(pattern.classicPath.map((step) => step.objective), ["获取并验证来源数据", "生成并验收目标格式交付物"]);
  assert.deepEqual(pattern.toolUsage.map((tool) => tool.toolName), ["hr-report-data", "workspace_artifact_write", "artifact_acceptance"]);
  assert.deepEqual(pattern.cautions, ["记录来源月份、口径和行数"]);
  assert.equal(pattern.reusableKnowledge.some((item) => item.rule.includes("宝信软件")), false);
});

test("failed outcome settles only when a failure lesson is present", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope: { ...scope, runId: "run-failed" }, runId: "run-failed", terminalCommitRef: "outcome-failed", now: 1000 });
  const failedEvidence = evidence({
    scope: { ...scope, runId: "run-failed" },
    runId: "run-failed",
    terminalCommitRef: "outcome-failed",
    terminalStatus: "failed",
    quality: { terminalCommitted: true, assessmentApproved: false, laterCorrected: false, laterDisputed: false },
    failureLessons: ["输入文件缺少必需列，必须在规划阶段先检查列名。"],
  });
  const worker = new MemorySettlementWorker({ store, reader: { read: async () => failedEvidence }, now: () => 1000 });
  assert.equal((await worker.runOnce()).status, "succeeded");
  const active = await store.active(scope);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.revision.value.terminalStatus, "failed");
});

test("missing evidence retries and then enters dead letter", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "unavailable", now: 1000 });
  let now = 1000;
  const worker = new MemorySettlementWorker({ store, reader: { read: async () => undefined }, now: () => now, maxAttempts: 2 });
  assert.equal((await worker.runOnce()).status, "retrying");
  now = 2000;
  assert.equal((await worker.runOnce()).status, "dead_letter");
  now = 4000;
  assert.equal((await worker.runOnce()).status, "empty");
});

test("two independent episodes consolidate into one planner-only procedure", async () => {
  const store = new InMemoryMemoryStore();
  const firstScope = scope;
  const secondScope = { ...scope, runId: "run-2" };
  for (const [runScope, runId, ref] of [[firstScope, "run-1", "outcome-1"], [secondScope, "run-2", "outcome-2"]] as const) {
    await store.enqueueSettlement({ scope: runScope, runId, terminalCommitRef: ref, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({ scope: runScope, runId, terminalCommitRef: ref }) },
      now: () => 1000,
    });
    assert.equal((await worker.runOnce()).status, "succeeded");
  }
  const result = await consolidateProcedures(store, scope, 2000);
  assert.equal(result[0]?.status, "created");
  const again = await consolidateProcedures(store, scope, 3000);
  assert.equal(again[0]?.reason, "procedure_already_exists");
  const active = await store.active(scope);
  const procedures = active.filter(({ item }) => item.subtype === "experience.procedure");
  assert.equal(procedures.length, 1);
  assert.deepEqual(procedures[0]?.revision.applicationTargets, ["planner"]);
});

test("a third independent success revises the procedure with the new evidence", async () => {
  const store = new InMemoryMemoryStore();
  for (const runId of ["run-1", "run-2", "run-3"] as const) {
    const runScope = { ...scope, runId };
    await store.enqueueSettlement({ scope: runScope, runId, terminalCommitRef: `${runId}-outcome`, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({ scope: runScope, runId, terminalCommitRef: `${runId}-outcome` }) },
      now: () => 1000,
      consolidate: true,
    });
    assert.equal((await worker.runOnce()).status, "succeeded");
  }
  const procedure = (await store.active(scope)).find(({ item }) => item.subtype === "experience.procedure");
  assert.equal(procedure?.revision.value.reliability && (procedure.revision.value.reliability as { successfulEpisodes: number }).successfulEpisodes, 3);
  assert.equal(procedure?.revision.confidence, 0.95);
  assert.equal((procedure?.revision.value.supportingEpisodeRevisionIds as string[]).length, 3);
  const revisions = (await store.active(scope)).filter(({ item }) => item.subtype === "experience.procedure");
  assert.equal(revisions.length, 1);
  assert.equal(procedure?.revision.revision, 2);
});

test("one episode is retained as evidence but cannot become a reusable procedure", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "outcome-single", now: 1000 });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ terminalCommitRef: "outcome-single" }) },
    now: () => 1000,
    consolidate: true,
  });
  assert.equal((await worker.runOnce()).reason, "episode_committed");
  const result = await consolidateProcedures(store, scope, 2000);
  assert.equal(result[0]?.reason, "requires_two_independent_episodes");
  assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.procedure").length, 0);
});

test("similar task fingerprints cluster when two stable dimensions match", async () => {
  const store = new InMemoryMemoryStore();
  const runs = [
    { runId: "run-similar-1", terminalCommitRef: "outcome-similar-1", artifactKind: "xlsx" },
    { runId: "run-similar-2", terminalCommitRef: "outcome-similar-2", artifactKind: "csv" },
  ] as const;
  for (const run of runs) {
    const runScope = { ...scope, runId: run.runId };
    await store.enqueueSettlement({ scope: runScope, runId: run.runId, terminalCommitRef: run.terminalCommitRef, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({
        scope: runScope,
        runId: run.runId,
        terminalCommitRef: run.terminalCommitRef,
        taskFingerprint: { taskKind: "report", domain: "sales", artifactKind: run.artifactKind },
      }) },
      now: () => 1000,
    });
    assert.equal((await worker.runOnce()).reason, "episode_committed");
  }
  const result = await consolidateProcedures(store, scope, 2000);
  assert.equal(result[0]?.status, "created");
  const procedure = (await store.active(scope)).find(({ item }) => item.subtype === "experience.procedure");
  const pattern = procedure?.revision.value.settlementPattern as { phase?: string; outcome?: string } | undefined;
  assert.equal(pattern?.phase, "procedure");
  assert.equal(pattern?.outcome, "verified_success");
  const memory = createMemoryPlugin({
    store,
    resolveRunScope: async (runId) => ({ tenantId: scope.tenantId, ownerUserId: scope.ownerUserId, runId }),
  });
  const projection = await memory.recall({
    runId: "run-similar-2",
    target: "planner",
    taskFingerprint: { taskKind: "report", domain: "sales", artifactKind: "csv" },
    budget: { maxItems: 10, maxTokens: 1200 },
  });
  assert.equal(projection, undefined, "historical v1 procedures remain auditable but require v2 re-extraction before recall");
  if (projection && "planningPriors" in projection) {
    const prior = projection.planningPriors[0];
    assert.equal(Array.isArray(prior.classicPath), true);
    assert.equal(Array.isArray(prior.toolUsage), true);
    assert.equal(Array.isArray(prior.cautions), true);
  }
});

test("different task kinds do not merge just because domain and artifact match", async () => {
  const store = new InMemoryMemoryStore();
  const runs = [
    { runId: "run-report", terminalCommitRef: "outcome-report", taskKind: "report" },
    { runId: "run-transform", terminalCommitRef: "outcome-transform", taskKind: "transform_artifact" },
  ] as const;
  for (const run of runs) {
    const runScope = { ...scope, runId: run.runId };
    await store.enqueueSettlement({ scope: runScope, runId: run.runId, terminalCommitRef: run.terminalCommitRef, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({
        scope: runScope,
        runId: run.runId,
        terminalCommitRef: run.terminalCommitRef,
        taskFingerprint: { taskKind: run.taskKind, domain: "sales", artifactKind: "xlsx" },
      }) },
      now: () => 1000,
      consolidate: true,
    });
    assert.equal((await worker.runOnce()).status, "succeeded");
  }
  assert.equal((await store.active(scope)).filter(({ item }) => item.subtype === "experience.procedure").length, 0);
});

test("a shared canonical capability plus another matching dimension can reconcile variant plan operation labels", async () => {
  const store = new InMemoryMemoryStore();
  const runs = [
    { runId: "run-route-composite", terminalCommitRef: "outcome-route-composite", taskKind: "composite" },
    { runId: "run-route-lookup", terminalCommitRef: "outcome-route-lookup", taskKind: "lookup" },
  ] as const;
  for (const run of runs) {
    const runScope = { ...scope, runId: run.runId };
    await store.enqueueSettlement({ scope: runScope, runId: run.runId, terminalCommitRef: run.terminalCommitRef, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({
        scope: runScope,
        runId: run.runId,
        terminalCommitRef: run.terminalCommitRef,
        taskFingerprint: { taskKind: run.taskKind, domain: "source_acquisition", artifactKind: "none", capabilityIds: ["spatial_planning.route"] },
      }) },
      now: () => 1000,
      consolidate: true,
    });
    assert.equal((await worker.runOnce()).status, "succeeded");
  }
  const procedures = (await store.active(scope)).filter(({ item }) => item.subtype === "experience.procedure");
  assert.equal(procedures.length, 1);
  const pattern = procedures[0]?.revision.value.settlementPattern as { applicability: { taskFingerprint: Record<string, unknown> } };
  assert.deepEqual(pattern.applicability.taskFingerprint.capabilityIds, ["spatial_planning.route"]);
});

test("Task Group search is user-scoped, goal-family scoped, and renders v0.5 boundaries", async () => {
  const store = new InMemoryMemoryStore();
  const runs = ["search-report-a", "search-report-b"] as const;
  for (const runId of runs) {
    const runScope = { ...scope, runId };
    await store.enqueueSettlement({ scope: runScope, runId, terminalCommitRef: `${runId}-outcome`, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({
        scope: runScope,
        runId,
        terminalCommitRef: `${runId}-outcome`,
        taskFingerprint: { taskKind: "report", domain: "sales", artifactKind: "xlsx" },
      }) },
      now: () => 1000,
    });
    assert.equal((await worker.runOnce()).status, "succeeded");
  }
  assert.equal((await consolidateProcedures(store, scope, 2000))[0]?.status, "created");
  const sameFamily = await searchTaskGroupCandidates(store, scope, {
    taskFingerprint: { taskKind: "report", domain: "sales", artifactKind: "csv" },
    query: ["report"],
  });
  assert.equal(sameFamily.length, 1);
  const otherFamily = await searchTaskGroupCandidates(store, scope, {
    taskFingerprint: { taskKind: "transform_artifact", domain: "sales", artifactKind: "xlsx" },
  });
  assert.equal(otherFamily.length, 0);
  const otherUser = await searchTaskGroupCandidates(store, { tenantId: scope.tenantId, ownerUserId: "user-b" }, {
    taskFingerprint: { taskKind: "report", domain: "sales", artifactKind: "xlsx" },
  });
  assert.equal(otherUser.length, 0);
  const pattern = (sameFamily[0]?.revision.value.settlementPattern ?? {}) as Parameters<typeof renderTaskGroupMarkdown>[0];
  const markdown = renderTaskGroupMarkdown({
    ...pattern,
    conflicts: ["同一场景存在两种未验证口径"],
    generalizationWarnings: ["不要把具体项目名称泛化为适用条件"],
  });
  assert.match(markdown, /conflicts:/u);
  assert.match(markdown, /泛化边界/u);

  const procedure = sameFamily[0]!;
  await store.commit(scope, {
    schema: "agentloop.userMemoryCandidate/v1",
    id: "conflicted-procedure",
    tenantId: scope.tenantId,
    ownerUserId: scope.ownerUserId,
    proposedKind: "experience",
    proposedSubtype: "experience.procedure",
    proposedCanonicalKey: procedure.item.canonicalKey,
    proposedValue: {
      ...procedure.revision.value,
      settlementPattern: { ...pattern, phase: "procedure", conflicts: ["未解决的口径冲突"] },
    },
    proposedContentMarkdown: markdown,
    persistenceIntent: "future_oriented",
    authority: "verified_run",
    sensitivity: "normal",
    proposedExperienceMaturity: "procedure",
    activation: { mode: "task_match", taskKinds: ["report"], domains: ["sales"] },
    applicationTargets: ["planner"],
    sourceRefs: procedure.revision.sourceRefs,
    confidence: procedure.revision.confidence,
    reason: "conflict_detected",
    decision: "accepted",
  }, 3000);
  const conflictedProjection = await createMemoryPlugin({
    store,
    resolveRunScope: async (runId) => ({ tenantId: scope.tenantId, ownerUserId: scope.ownerUserId, runId }),
  }).recall({
    runId: "search-report-a",
    target: "planner",
    taskFingerprint: { taskKind: "report", domain: "sales", artifactKind: "xlsx" },
    budget: { maxItems: 10, maxTokens: 2000 },
  });
  assert.equal(conflictedProjection && "planningPriors" in conflictedProjection ? conflictedProjection.planningPriors.length : 0, 0);
});

test("a failed lesson cannot promote a procedure with one successful episode", async () => {
  const store = new InMemoryMemoryStore();
  const successScope = { ...scope, runId: "run-success" };
  const failedScope = { ...scope, runId: "run-failed-similar" };
  await store.enqueueSettlement({ scope: successScope, runId: successScope.runId, terminalCommitRef: "outcome-success", now: 1000 });
  await store.enqueueSettlement({ scope: failedScope, runId: failedScope.runId, terminalCommitRef: "outcome-failed-similar", now: 1000 });
  const successWorker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ scope: successScope, runId: successScope.runId, terminalCommitRef: "outcome-success" }) },
    now: () => 1000,
  });
  const failedWorker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({
      scope: failedScope,
      runId: failedScope.runId,
      terminalCommitRef: "outcome-failed-similar",
      terminalStatus: "failed",
      quality: { terminalCommitted: true, assessmentApproved: false, laterCorrected: false, laterDisputed: false },
      failureLessons: ["先校验输入字段。"],
    }) },
    now: () => 1000,
  });
  assert.equal((await successWorker.runOnce()).status, "succeeded");
  assert.equal((await failedWorker.runOnce()).status, "succeeded");
  assert.equal((await consolidateProcedures(store, scope, 2000)).every((item) => item.status === "skipped"), true);
});

test("a related failure enriches procedure warnings without counting as a success", async () => {
  const store = new InMemoryMemoryStore();
  const runs = [
    { runId: "run-success-a", ref: "outcome-success-a", status: "completed" as const },
    { runId: "run-failure-a", ref: "outcome-failure-a", status: "failed" as const },
    { runId: "run-success-b", ref: "outcome-success-b", status: "completed" as const },
  ];
  for (const run of runs) {
    const runScope = { ...scope, runId: run.runId };
    await store.enqueueSettlement({ scope: runScope, runId: run.runId, terminalCommitRef: run.ref, now: 1000 });
    const worker = new MemorySettlementWorker({
      store,
      reader: { read: async () => evidence({
        scope: runScope,
        runId: run.runId,
        terminalCommitRef: run.ref,
        terminalStatus: run.status,
        ...(run.status === "failed" ? {
          failureLessons: ["交付前必须补齐验收证据。"],
          failureRemediations: [{
            lesson: "交付前必须补齐验收证据。",
            doDifferently: "在交付前执行 artifact acceptance",
            trigger: "生成了目标交付物",
            symptom: "交付记录缺少验收结果",
            rootCause: "交付步骤未绑定验收动作",
            causeStatus: "confirmed" as const,
            nextAction: "交付前执行 artifact acceptance",
            verification: "验收记录包含可打开和非空证据",
            applicability: ["同类交付任务"],
          }],
        } : {}),
        quality: run.status === "completed"
          ? evidence().quality
          : { terminalCommitted: true, assessmentApproved: false, laterCorrected: false, laterDisputed: false },
      }) },
      now: () => 1000,
      consolidate: true,
    });
    assert.equal((await worker.runOnce()).status, "succeeded");
  }
  const procedure = (await store.active(scope)).find(({ item }) => item.subtype === "experience.procedure");
  assert.equal((procedure?.revision.value.reliability as { successfulEpisodes: number }).successfulEpisodes, 2);
  assert.equal((procedure?.revision.value.reliability as { failedEpisodes: number }).failedEpisodes, 1);
  const pattern = procedure?.revision.value.settlementPattern as { failureLessons: readonly { lesson: string }[] };
  assert.equal(pattern.failureLessons.some((lesson) => lesson.lesson.includes("补齐验收证据")), true);
});

test("scope mismatch from a reader is rejected and retried", async () => {
  const store = new InMemoryMemoryStore();
  await store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: "outcome-1", now: 1000 });
  const worker = new MemorySettlementWorker({
    store,
    reader: { read: async () => evidence({ scope: { ...scope, ownerUserId: "user-b" } }) },
    now: () => 1000,
  });
  const result = await worker.runOnce();
  assert.equal(result.status, "retrying");
  assert.match(result.reason ?? "", /scope_mismatch/);
  assert.equal((await store.active(scope)).length, 0);
});
