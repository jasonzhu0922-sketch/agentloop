import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "@zhujun/agentloop";
import { createLocalMemoryPlugin, createMemoryPlugin } from "../src/plugin.ts";
import { InMemoryMemoryStore } from "../src/store.ts";
import type { MemoryCandidate, MemoryRunScope } from "../src/types.ts";

const scopes: Record<string, MemoryRunScope> = {
  runA: { runId: "runA", tenantId: "tenant-1", ownerUserId: "user-a" },
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
