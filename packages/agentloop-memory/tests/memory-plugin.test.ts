import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "@zhujun/agentloop";
import { createLocalMemoryPlugin, createMemoryPlugin } from "../src/plugin.ts";
import { InMemoryMemoryStore } from "../src/store.ts";
import type { MemoryCandidate, MemoryRunScope } from "../src/types.ts";
import type { MemoryIntentCandidate } from "@zhujun/agentloop";

const scopes: Record<string, MemoryRunScope> = {
  runA: { runId: "runA", tenantId: "tenant-1", ownerUserId: "user-a" },
  runA2: { runId: "runA2", tenantId: "tenant-1", ownerUserId: "user-a", conversationId: "another-conversation" },
  runB: { runId: "runB", tenantId: "tenant-1", ownerUserId: "user-b" },
};

function plugin(options: Partial<Parameters<typeof createMemoryPlugin>[0]> = {}) {
  return createMemoryPlugin({
    resolveRunScope: async (runId) => scopes[runId],
    store: new InMemoryMemoryStore(),
    now: () => 1_700_000_000_000,
    ...options,
  });
}

function preference(key: string, value: Readonly<Record<string, unknown>>, extra: Partial<MemoryIntentCandidate> = {}): MemoryIntentCandidate {
  return {
    schema: "agentloop.memoryIntentCandidate/v1", kind: "preference", subtype: key, canonicalKey: key,
    value, persistenceIntent: "explicit", sensitivity: "normal", applicationTargets: ["response", "human_loop"], confidence: 1,
    ...extra,
  };
}

test("assistant nickname and unseen preference concepts survive storage and both interaction projections", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const create = () => createLocalMemoryPlugin({ database, resolveRunScope: async (runId) => scopes[runId] });
    const memory = await create();
    const userText = "还有，以后我会称呼你为玄武，你就是玄武，知道吗？以后解释复杂问题先画图。";
    const result = await memory.commitExplicit({
      runId: "runA", messageId: "assistant-name", userText,
      memoryIntents: [
        preference("interaction.assistant_name", { subject: "assistant", name: "玄武" }, {
          contentMarkdown: "用户以后称呼助手为玄武。", sourceQuote: "以后我会称呼你为玄武，你就是玄武",
        }),
        preference("interaction.explanation_order", { when: "复杂问题", first: "画图" }, {
          contentMarkdown: "解释复杂问题时优先使用图示。", sourceQuote: "以后解释复杂问题先画图",
        }),
      ],
    });
    assert.equal(result.kind, "committed");
    if (result.kind !== "committed") return;
    assert.equal(result.receipt.committedCount, 2);
    const active = await memory.store.active(scopes.runA);
    assert.equal(active.length, 2);
    assert.equal(new Set(active.map(({ item }) => item.id)).size, 2);
    assert.equal(active.find(({ item }) => item.subtype === "interaction.assistant_name")?.revision.sourceRefs[0]?.quotedText,
      "以后我会称呼你为玄武，你就是玄武");
    // A new plugin and a different Run for the same owner must apply the
    // durable preferences; the original conversation is not required.
    const reloaded = await create();
    for (const target of ["response", "human_loop"] as const) {
      const projection = await reloaded.recall({ runId: "runA2", target, budget: { maxItems: 10, maxTokens: 800 } });
      assert.ok(projection && "preferences" in projection);
      assert.deepEqual(projection.preferences?.find((entry) => entry.subtype === "interaction.assistant_name")?.value,
        { subject: "assistant", name: "玄武" });
      assert.equal("guidance" in projection ? projection.guidance.preferredAddress : undefined, undefined);
      assert.match(projection.promptMarkdown, /玄武/u);
      assert.match(projection.promptMarkdown, /复杂问题/u);
      assert.match(projection.promptMarkdown, /画图/u);
    }
    assert.equal(await reloaded.recall({ runId: "runB", target: "response", budget: { maxItems: 10, maxTokens: 800 } }), undefined);
  } finally {
    await database.close();
  }
});

test("revising an open-ended preference preserves other preferences and supersedes its prior value", async () => {
  const memory = plugin();
  await memory.commitExplicit({ runId: "runA", messageId: "first", userText: "以后叫你玄武；少用表格",
    memoryIntents: [preference("interaction.assistant_name", { name: "玄武" }), preference("interaction.tables", { use: "sparingly" })] });
  await memory.commitExplicit({ runId: "runA", messageId: "second", userText: "以后改叫你小武",
    memoryIntents: [preference("interaction.assistant_name", { name: "小武" })] });
  const active = await memory.store.active(scopes.runA);
  assert.equal(active.length, 2);
  const name = active.find(({ item }) => item.subtype === "interaction.assistant_name");
  assert.equal(name?.revision.revision, 2);
  const projection = await memory.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 800 } });
  assert.ok(projection && "promptMarkdown" in projection);
  assert.match(projection.promptMarkdown, /小武/u);
  assert.doesNotMatch(projection.promptMarkdown, /玄武/u);
  assert.match(projection.promptMarkdown, /sparingly/u);
});

test("empty semantic intake does not re-interpret quoted or temporary text through legacy regexes", async () => {
  const memory = plugin();
  const result = await memory.commitExplicit({ runId: "runA", messageId: "quoted", userText: "分析这句测试素材：以后叫我大王。", memoryIntents: [] });
  assert.equal(result.kind, "not_applicable");
  assert.equal((await memory.store.active(scopes.runA)).length, 0);
});

test("general preference intake preserves policy decisions and does not drop accepted siblings", async () => {
  const memory = plugin();
  const result = await memory.commitExplicit({ runId: "runA", messageId: "mixed", userText: "以后叫你玄武",
    memoryIntents: [
      preference("interaction.secret", { secret: "do not store" }, { sensitivity: "secret" }),
      preference("interaction.restricted", { value: "private" }, { sensitivity: "restricted" }),
      preference("interaction.inferred", { value: "guess" }, { persistenceIntent: "inferred" }),
      preference("interaction.assistant_name", { name: "玄武" }),
    ] });
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") return;
  assert.equal(result.receipt.committedCount, 1);
  assert.equal(result.pendingConfirmations?.length, 2);
  assert.equal((await memory.store.active(scopes.runA)).length, 1);
});

test("generic preference validation rejects missing evidence, unsafe shapes and unbounded values", async () => {
  const memory = plugin();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const invalid = [
    preference("invalid", { name: "玄武" }),
    preference("interaction.assistant_name", {}),
    preference("interaction.assistant_name", { name: "玄武" }, { sourceQuote: "用户没有说过的话" }),
    preference("interaction.assistant_name", { name: "x".repeat(2_001) }),
    preference("interaction.assistant_name", { x: Number.NaN }),
    preference("interaction.assistant_name", JSON.parse('{"__proto__":{"x":1}}')),
    preference("interaction.assistant_name", circular),
  ];
  for (const [index, intent] of invalid.entries()) {
    assert.equal((await memory.commitExplicit({ runId: "runA", messageId: `invalid-${index}`, userText: "以后叫你玄武", memoryIntents: [intent] })).kind,
      "not_applicable");
  }
  assert.equal((await memory.store.active(scopes.runA)).length, 0);
});

test("source evidence cannot persist secrets alongside an otherwise normal preference", async () => {
  const memory = plugin();
  const userText = "以后叫你玄武，旁边这项是密码：example-sensitive-value";
  const result = await memory.commitExplicit({ runId: "runA", messageId: "secret-quote", userText,
    memoryIntents: [preference("interaction.assistant_name", { name: "玄武" }, { sourceQuote: userText })] });
  assert.equal(result.kind, "not_applicable");
  assert.equal((await memory.store.active(scopes.runA)).length, 0);
});

test("tone and formatting values are projected in full without schema-specific rendering", async () => {
  const memory = plugin();
  await memory.commitExplicit({ runId: "runA", messageId: "style", userText: "以后少客套，比较时用表格",
    memoryIntents: [preference("interaction.tone", { tone: { avoid: ["unnecessary_politeness"] } }),
      preference("interaction.formatting", { formatting: { comparisons: "table" } })] });
  const projection = await memory.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 800 } });
  assert.ok(projection && "promptMarkdown" in projection);
  assert.match(projection.promptMarkdown, /unnecessary_politeness/u);
  assert.match(projection.promptMarkdown, /comparisons/u);
  assert.match(projection.promptMarkdown, /table/u);
});

test("projection budgeting counts structured values and does not let a large item starve a small preference", async () => {
  const memory = plugin();
  await memory.commitExplicit({ runId: "runA", messageId: "budget", userText: "偏好测试",
    memoryIntents: [preference("interaction.long", { text: "x".repeat(900) }), preference("interaction.assistant_name", { name: "玄武" })] });
  const projection = await memory.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 50 } });
  assert.ok(projection && "preferences" in projection);
  assert.equal(projection.preferences?.length, 1);
  assert.equal(projection.preferences[0].value.name, "玄武");
});

test("new preference values survive every declared application target without a per-type adapter", async () => {
  const memory = plugin();
  await memory.commitExplicit({ runId: "runA", messageId: "targets", userText: "以后输出表格时金额保留两位小数",
    memoryIntents: [preference("artifact.amount_precision", { decimalPlaces: 2, when: "表格金额" }, {
      applicationTargets: ["planner", "execution", "artifact"],
    })] });
  for (const target of ["planner", "execution", "artifact"] as const) {
    const projection = await memory.recall({ runId: "runA", target, budget: { maxItems: 10, maxTokens: 800 } });
    assert.deepEqual(projection?.preferences?.[0].value, { decimalPlaces: 2, when: "表格金额" });
    if (projection && "augmentations" in projection) assert.match(projection.augmentations[0].contentMarkdown, /decimalPlaces/u);
  }
  assert.equal(await memory.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 800 } }), undefined);
});

test("explicit address preference is committed and recalled as a typed projection", async () => {
  const memory = plugin();
  const result = await memory.commitExplicit({ runId: "runA", messageId: "m1", userText: "以后叫我军爷。" });
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") return;
  assert.equal(result.receipt.memoryEpoch, 1);
  assert.deepEqual(result.receipt.affectedTargets, ["response", "human_loop"]);

  const projection = await memory.recall({
    runId: "runA",
    target: "response",
    budget: { maxItems: 10, maxTokens: 200 },
  });
  assert.equal(projection?.target, "response");
  assert.equal(projection && "guidance" in projection ? projection.guidance.preferredAddress : undefined, "军爷");
  assert.match(projection?.contentHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal((await memory.store.projections(scopes.runA, "runA")).length, 1);
});

test("structured resolver intent commits the natural-language address preference", async () => {
  const memory = plugin();
  const result = await memory.commitExplicit({
    runId: "runA",
    messageId: "m-natural-language",
    userText: "你以后回复我都称呼我为俊爷",
    memoryIntents: [{
      schema: "agentloop.memoryIntentCandidate/v1",
      kind: "preference",
      subtype: "interaction.address",
      canonicalKey: "interaction.address",
      value: { preferredAddress: "俊爷" },
      persistenceIntent: "explicit",
      sensitivity: "normal",
      applicationTargets: ["response", "human_loop"],
      confidence: 0.99,
    }],
  });
  assert.equal(result.kind, "committed");
  const projection = await memory.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 200 } });
  assert.equal(projection && "guidance" in projection ? projection.guidance.preferredAddress : undefined, "俊爷");
});

test("structured contact email is stored as a fact and recalled for responses", async () => {
  const memory = plugin();
  const result = await memory.commitExplicit({
    runId: "runA",
    messageId: "m-email",
    userText: "记住我的邮箱是 12875549@qq.com",
    memoryIntents: [{
      schema: "agentloop.memoryIntentCandidate/v1",
      kind: "fact",
      subtype: "contact.email",
      canonicalKey: "contact.email",
      value: { email: "12875549@qq.com" },
      persistenceIntent: "explicit",
      sensitivity: "private",
      applicationTargets: ["response", "human_loop"],
      confidence: 1,
    }],
  });
  assert.equal(result.kind, "committed");
  const active = await memory.store.active(scopes.runA);
  assert.equal(active[0]?.item.kind, "fact");
  const projection = await memory.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 200 } });
  assert.equal(projection && "facts" in projection ? projection.facts?.[0]?.value.email : undefined, "12875549@qq.com");
  assert.match(projection && "promptMarkdown" in projection ? projection.promptMarkdown : "", /12875549@qq\.com/u);
});

test("explicit email fact survives when the resolver supplies no intent", async () => {
  const memory = plugin();
  const result = await memory.commitExplicit({ runId: "runA", messageId: "m-email-fallback", userText: "记住我的邮箱是 fallback@example.com" });
  assert.equal(result.kind, "committed");
  const active = await memory.store.active(scopes.runA);
  assert.equal(active[0]?.item.kind, "fact");
  assert.equal(active[0]?.revision.value.email, "fallback@example.com");
});

test("memory ownership is resolved from the trusted run scope", async () => {
  const memory = plugin();
  await memory.commitExplicit({ runId: "runA", messageId: "m1", userText: "以后叫我甲。" });
  assert.equal(await memory.recall({ runId: "runB", target: "response", budget: { maxItems: 10, maxTokens: 200 } }), undefined);
});

test("a single episode is not recalled as a reusable planner prior", async () => {
  const memory = plugin();
  const candidate: MemoryCandidate = {
    schema: "agentloop.userMemoryCandidate/v1",
    id: "single-episode",
    tenantId: "tenant-1",
    ownerUserId: "user-a",
    proposedKind: "experience",
    proposedSubtype: "experience.episode",
    proposedCanonicalKey: "experience.episode:runA:outcome-1",
    proposedValue: { taskFingerprint: { taskKind: "report", domain: "sales" } },
    proposedContentMarkdown: "一次运行的证据记录",
    persistenceIntent: "future_oriented",
    authority: "verified_run",
    sensitivity: "normal",
    proposedExperienceMaturity: "episode",
    activation: { mode: "task_match", taskKinds: ["report"], domains: ["sales"] },
    applicationTargets: ["planner"],
    sourceRefs: [{ type: "run", runId: "runA" }],
    confidence: 1,
    reason: "test_episode_only",
    decision: "pending",
  };
  await memory.store.commit(scopes.runA, candidate, 1_700_000_000_000);
  const projection = await memory.recall({
    runId: "runA",
    target: "planner",
    taskFingerprint: { taskKind: "report", domain: "sales" },
    budget: { maxItems: 10, maxTokens: 200 },
  });
  assert.equal(projection, undefined);
});

test("same canonical preference creates a new revision and epoch", async () => {
  const memory = plugin();
  await memory.commitExplicit({ runId: "runA", messageId: "m1", userText: "以后叫我甲。" });
  const second = await memory.commitExplicit({ runId: "runA", messageId: "m2", userText: "以后叫我乙。" });
  assert.equal(second.kind, "committed");
  if (second.kind !== "committed") return;
  assert.equal(second.receipt.memoryEpoch, 2);
  const projection = await memory.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 200 } });
  assert.equal(projection && "guidance" in projection ? projection.guidance.preferredAddress : undefined, "乙");
  const active = await memory.store.active(scopes.runA);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.revision.revision, 2);
  assert.equal(active[0]?.revision.supersedesRevisionId !== undefined, true);
});

test("sensitive and secret candidates never silently persist", async () => {
  const candidate = (sensitivity: MemoryCandidate["sensitivity"]): MemoryCandidate => ({
    schema: "agentloop.userMemoryCandidate/v1",
    id: `candidate-${sensitivity}`,
    tenantId: "tenant-1",
    ownerUserId: "user-a",
    proposedKind: "fact",
    proposedSubtype: "profile.identity",
    proposedValue: { value: "redacted" },
    proposedContentMarkdown: sensitivity === "secret" ? "不要保存密码" : "私人资料",
    persistenceIntent: "explicit",
    authority: "explicit_user",
    sensitivity,
    activation: { mode: "task_match", taskKinds: ["profile"] },
    applicationTargets: ["planner"],
    sourceRefs: [{ type: "user_message", runId: "runA", messageId: "m1" }],
    confidence: 1,
    reason: "test",
    decision: "pending",
  });
  const memory = plugin({ resolveExplicitCandidate: ({ userText }) => candidate(userText === "secret" ? "secret" : "restricted") });
  assert.equal((await memory.commitExplicit({ runId: "runA", messageId: "m1", userText: "private" })).kind, "confirmation_required");
  assert.equal((await memory.commitExplicit({ runId: "runA", messageId: "m1", userText: "secret" })).kind, "not_applicable");
  assert.equal((await memory.store.active(scopes.runA)).length, 0);
});

test("settlement enqueue is idempotent for the canonical terminal commit", async () => {
  const memory = plugin({ store: new InMemoryMemoryStore() });
  const first = await memory.enqueueSettlement({ runId: "runA", terminalCommitRef: "outcome-1" });
  const duplicate = await memory.enqueueSettlement({ runId: "runA", terminalCommitRef: "outcome-1" });
  assert.equal(first.kind, "enqueued");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(first.settlementJobId, duplicate.settlementJobId);
});

test("local SQLite persistence survives a new plugin instance without crossing users", async () => {
  const database = new AppDatabase(":memory:");
  const first = await createLocalMemoryPlugin({ database, resolveRunScope: async (runId) => scopes[runId], now: () => 1_700_000_000_000 });
  await first.commitExplicit({ runId: "runA", messageId: "m1", userText: "以后叫我本地甲。" });

  const second = await createLocalMemoryPlugin({ database, resolveRunScope: async (runId) => scopes[runId], now: () => 1_700_000_000_001 });
  const userA = await second.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 200 } });
  const userB = await second.recall({ runId: "runB", target: "response", budget: { maxItems: 10, maxTokens: 200 } });
  assert.equal(userA && "guidance" in userA ? userA.guidance.preferredAddress : undefined, "本地甲");
  assert.equal(userB, undefined);
  await database.close();
});

test("separate local Runtime SQLite connections share the device Memory file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-memory-"));
  const path = join(root, "memory.db");
  const firstDatabase = new AppDatabase(path);
  const first = await createLocalMemoryPlugin({ database: firstDatabase, resolveRunScope: async (runId) => scopes[runId], now: () => 1_700_000_000_000 });
  await first.commitExplicit({ runId: "runA", messageId: "shared", userText: "以后叫我共享甲。" });
  const secondDatabase = new AppDatabase(path);
  const second = await createLocalMemoryPlugin({ database: secondDatabase, resolveRunScope: async (runId) => scopes[runId], now: () => 1_700_000_000_001 });
  const userA = await second.recall({ runId: "runA", target: "response", budget: { maxItems: 10, maxTokens: 200 } });
  const userB = await second.recall({ runId: "runB", target: "response", budget: { maxItems: 10, maxTokens: 200 } });
  assert.equal(userA && "guidance" in userA ? userA.guidance.preferredAddress : undefined, "共享甲");
  assert.equal(userB, undefined);
  await firstDatabase.close();
  await secondDatabase.close();
  await rm(root, { recursive: true, force: true });
});

test("SQLite migration repairs legacy contact email preferences", async () => {
  const database = new AppDatabase(":memory:");
  const legacy = await createLocalMemoryPlugin({
    database,
    resolveRunScope: async (runId) => scopes[runId],
    resolveExplicitCandidate: ({ scope, candidateId, messageId }) => ({
      schema: "agentloop.userMemoryCandidate/v1",
      id: candidateId,
      tenantId: scope.tenantId,
      ownerUserId: scope.ownerUserId,
      proposedKind: "preference",
      proposedSubtype: "contact.email",
      proposedCanonicalKey: "contact.email",
      proposedValue: { email: "12875549@qq.com" },
      proposedContentMarkdown: "用户希望在适合称呼时使用其指定称呼。",
      persistenceIntent: "explicit",
      authority: "explicit_user",
      sensitivity: "private",
      proposedPreferenceEffect: "default",
      activation: { mode: "always" },
      applicationTargets: ["response"],
      sourceRefs: [{ type: "user_message", runId: scope.runId, messageId }],
      confidence: 1,
      reason: "legacy_fixture",
      decision: "pending",
    }),
  });
  await legacy.commitExplicit({ runId: "runA", messageId: "legacy", userText: "记住我的邮箱" });
  const repaired = await createLocalMemoryPlugin({ database, resolveRunScope: async (runId) => scopes[runId] });
  const active = await repaired.store.active(scopes.runA);
  assert.equal(active[0]?.item.kind, "fact");
  assert.equal(active[0]?.revision.preferenceEffect, undefined);
  await database.close();
});
