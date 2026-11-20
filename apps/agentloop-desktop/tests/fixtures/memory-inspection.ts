import { join } from "node:path";
import { AppDatabase } from "@zhujun/agentloop";
import { createMemoryPlugin, SqliteMemoryStore } from "@zhujun/agentloop-memory";

/** Synthetic saved memory, revisions and canonical evidence; no model/network. */
export async function seedMemory(root: string, owner: string) {
  const db = new AppDatabase(join(root, "memory.db"));
  const store = new SqliteMemoryStore(db);
  const plugin = createMemoryPlugin({ store, resolveRunScope: async runId => ({ tenantId: "fixture-device", ownerUserId: runId === "foreign-run" ? "foreign" : owner, runId }) });
  try {
    for (let version = 1; version <= 28; version++) await plugin.commitExplicit({ runId: "memory-run-0001", messageId: `message-${version}`, userText: "以后项目报告使用中文", memoryIntents: [{
      schema: "agentloop.memoryIntentCandidate/v1", kind: "preference", subtype: "writing.project.language", canonicalKey: "writing.project.language",
      value: { language: "中文", version }, contentMarkdown: `项目报告使用中文。版本 ${version}。<script>window.memoryXss=true</script>`,
      applicability: { conditions: ["仅项目报告"], exclusions: ["用户本轮另有要求"] },
      persistenceIntent: "explicit", sensitivity: "normal", confidence: 1, applicationTargets: ["response", "planner"],
    }] });
    await plugin.commitExplicit({ runId: "foreign-run", messageId: "foreign", userText: "以后称呼我为别人的名字", memoryIntents: [{
      schema: "agentloop.memoryIntentCandidate/v1", kind: "preference", subtype: "interaction.address", canonicalKey: "interaction.address",
      value: { preferredAddress: "foreign-private-value" }, persistenceIntent: "explicit", sensitivity: "normal", confidence: 1, applicationTargets: ["response"],
    }] });
    const [entry] = await store.active({ tenantId: "fixture-device", ownerUserId: owner });
    if (!entry) throw new Error("fixture_memory_not_saved");
    const projection = await plugin.recall({ runId: "memory-run-0001", target: "response", budget: { maxItems: 10, maxTokens: 4000 } });
    await store.enqueueSettlement({ scope: { tenantId: "fixture-device", ownerUserId: owner }, runId: "memory-run-0001", terminalCommitRef: "fixture-commit", now: Date.now() });
    await db.prepare("UPDATE local_memory_settlement_jobs SET status = 'dead_letter', attempts = 5, last_error = 'invalid_output' WHERE run_id = 'memory-run-0001'").run();
    await db.prepare(`INSERT INTO local_memory_settlement_attempts (id,tenant_id,owner_user_id,run_id,settlement_job_id,attempt_json,created_at) VALUES ('attempt','fixture-device',?,'memory-run-0001','job',?,1)`)
      .run(owner, JSON.stringify({ stage: "extraction", status: "invalid_output", modelKey: "local:fixture", errors: [{ path: "learning", code: "evidence_missing" }] }));
    for (const reviewOwner of [owner, "foreign"]) await store.recordApplicationReview({ tenantId: "fixture-device", ownerUserId: reviewOwner }, {
      schema: "agentloop.memoryApplicationReview/v1", id: `review:${reviewOwner}`, runId: "memory-run-0001", terminalCommitRef: "fixture-commit",
      inputHash: "fixture-input-hash", modelKey: "local:fixture", status: "accepted", createdAt: 1, errors: [],
      applications: [{ projectionId: projection!.id, memoryRevisionId: entry.revision.id, knowledgeId: "knowledge:fixture", adoption: "unknown", effect: "unverified",
        reason: reviewOwner === owner ? "The evidence does not establish adoption <script>window.reviewXss=true</script>" : "foreign-private-review", stepOrders: [], evidenceRefs: [] }],
    });
    await store.invalidateRun({ tenantId: "fixture-device", ownerUserId: owner }, "memory-run-0001", { type: "user_feedback", runId: "followup", sourceId: "followup:1" }, 2);
    await store.invalidateRun({ tenantId: "fixture-device", ownerUserId: "foreign" }, "memory-run-0001", { type: "user_feedback", runId: "foreign-private-feedback" }, 2);
    return { id: entry.item.id, revisionId: entry.revision.id, projection };
  } finally { await db.close(); }
}

export async function seedRun(file: string, owner: string, id = "memory-run-0001") {
  const db = new AppDatabase(file); await db.ready();
  try {
    await db.prepare("INSERT INTO runs (id,owner_user_id,depth,status,input,output,created_at) VALUES (?,?,0,'completed','生成项目报告','已输出中文项目报告',1)").run(id, owner);
    for (let seq = 1; seq <= 32; seq++) await db.prepare("INSERT INTO run_events (run_id,seq,type,payload_json,created_at) VALUES (?,?,?,?,1)")
      .run(id, seq, seq === 1 ? "memory.recalled" : seq === 2 ? "human_loop.answered" : "tool.completed", JSON.stringify({ evidence: `证据-${seq}`, selected: "中文", html: "<img src=x onerror=alert(1)>" }));
  } finally { await db.close(); }
}
