import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase, type MemoryIntentCandidate } from "@zhujun/agentloop";
import { createMemoryPlugin, InMemoryMemoryStore, SqliteMemoryStore } from "../src/index.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
const applicability = { conditions: ["Only the selected project"], exclusions: ["Published material"],
  context: { project: ["alpha"], version: [2] }, excludedContext: { publication: [true] } };
const intent = (kind: "preference" | "fact", extra: Partial<MemoryIntentCandidate> = {}): MemoryIntentCandidate => ({
  schema: "agentloop.memoryIntentCandidate/v1", kind, subtype: "project.delivery", canonicalKey: "project.delivery",
  value: { format: "html" }, persistenceIntent: "explicit", sensitivity: "normal", confidence: 1,
  applicationTargets: ["response", "planner", "human_loop", "execution", "artifact"], applicability, validFrom: 1000, expiresAt: 2000, ...extra,
});

for (const backend of ["memory", "sqlite"] as const) for (const kind of ["preference", "fact"] as const) {
  test(`${backend} ${kind}: scope and time survive revisions and reload and fail closed`, async t => {
    const db = backend === "sqlite" ? new AppDatabase(":memory:") : undefined;
    t.after(() => db?.close());
    let store = db ? new SqliteMemoryStore(db) : new InMemoryMemoryStore();
    let now = 1500;
    const create = () => createMemoryPlugin({ store, now: () => now, resolveRunScope: async runId => ({ ...scope, runId }) });
    let plugin = create();
    const commit = async (id: string, proposal: MemoryIntentCandidate) => plugin.commitExplicit({ runId: "r", messageId: id, userText: "Use HTML for this project", memoryIntents: [proposal] });
    assert.equal((await commit("first", intent(kind))).kind, "committed");
    assert.equal((await commit("revision", intent(kind, { value: { format: "pdf" } }))).kind, "committed");
    assert.equal((await commit("other-scope", intent(kind, { applicability: { ...applicability, context: { project: ["beta"], version: [2] } } }))).kind, "committed");
    if (db) store = new SqliteMemoryStore(db);
    plugin = create();
    const entries = await store.active(scope);
    assert.equal(entries.length, 2);
    assert.equal(entries.find(entry => entry.revision.value.format === "pdf")?.revision.revision, 2);
    const recall = (stepContext: Record<string, unknown>) => plugin.recall({ runId: "fresh", target: "response", stepContext, budget: { maxItems: 5, maxTokens: 2000 } });
    assert.equal(await recall({ project: "alpha" }), undefined, "missing version cannot satisfy scope");
    assert.equal(await recall({ project: "alpha", version: 1 }), undefined);
    assert.equal(await recall({ project: "alpha", version: 2, publication: true }), undefined);
    const projection = await recall({ project: "alpha", version: 2 });
    assert.ok(projection && projection.target === "response");
    const value = kind === "fact" ? projection.facts?.[0] : projection.preferences?.[0];
    assert.deepEqual(value?.value, { format: "pdf" });
    assert.deepEqual(value?.applicability, applicability);
    assert.match(projection.promptMarkdown, /Only the selected project/);
    for (const target of ["planner", "execution", "artifact", "human_loop"] as const) {
      const projected = await plugin.recall({ runId: "fresh", target, stepContext: { project: "alpha", version: 2 }, budget: { maxItems: 5, maxTokens: 2000 } });
      assert.match(JSON.stringify(projected), /Only the selected project/);
    }
    now = 999;
    assert.equal(await recall({ project: "alpha", version: 2 }), undefined);
    now = 2000;
    assert.equal(await recall({ project: "alpha", version: 2 }), undefined);
  });
}

test("invalid scope, invalid time and secrets in scope cannot enter Memory", async () => {
  const store = new InMemoryMemoryStore();
  const plugin = createMemoryPlugin({ store, resolveRunScope: async runId => ({ ...scope, runId }) });
  for (const proposal of [
    intent("fact", { applicability: { ...applicability, context: { version: [] } } }),
    intent("fact", { applicability: { conditions: ["password=secret-value"], exclusions: [] } }),
    intent("fact", { validFrom: undefined, expiresAt: 500 }),
    intent("fact", { expiresAt: 1000 }), intent("fact", { validFrom: NaN }),
  ]) {
    assert.equal((await plugin.commitExplicit({ runId: "r", messageId: "bad", userText: "Use HTML", memoryIntents: [proposal] })).kind, "not_applicable");
  }
  assert.equal((await store.active(scope)).length, 0);
});

test("conditional interaction preference keeps its conditions instead of becoming unconditional guidance", async () => {
  const plugin = createMemoryPlugin({ store: new InMemoryMemoryStore(), now: () => 1500, resolveRunScope: async runId => ({ ...scope, runId }) });
  await plugin.commitExplicit({ runId: "r", messageId: "m", userText: "Use this address in formal reports", memoryIntents: [
    intent("preference", { subtype: "interaction.address", canonicalKey: "interaction.address", value: { preferredAddress: "Director" }, applicability: { conditions: ["Formal reports only"], exclusions: [] } }),
  ] });
  const projection = await plugin.recall({ runId: "r", target: "response", budget: { maxItems: 1, maxTokens: 1000 } });
  assert.ok(projection?.target === "response");
  assert.equal(projection.guidance.preferredAddress, undefined);
  assert.match(projection.promptMarkdown, /Formal reports only/);
});
