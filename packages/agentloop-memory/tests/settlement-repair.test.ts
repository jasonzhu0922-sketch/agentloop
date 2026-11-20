import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMemoryStore, settleV2Batch, SETTLEMENT_V2, REUSABLE_LEARNING_CONTRACT } from "../src/index.ts";
import { applySettlementRepairs } from "../src/settlement-repair.ts";
import type { MemorySettlementEvidence, MemorySettlementModel } from "../src/types.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
const evidence: MemorySettlementEvidence = { scope: { ...scope, runId: "one" }, runId: "one", terminalCommitRef: "outcome:one", terminalStatus: "completed",
  taskFingerprint: { taskKind: "execute", domain: "documents" }, strategy: "Render and inspect the requested document",
  observations: ["render", "probe"].map(id => ({ id, kind: "action", toolName: "document.inspect", status: "succeeded", summary: "Current document inspection",
    sourceRefs: [{ type: "action", runId: "one", sourceId: id }] })),
  quality: { terminalCommitted: true, assessmentApproved: true, laterCorrected: false, laterDisputed: false }, sourceRefs: [{ type: "outcome", runId: "one" }], occurredAt: 1 };
function learning(input: any): any {
  return { schema: SETTLEMENT_V2, learningContract: REUSABLE_LEARNING_CONTRACT,
    executionReview: [{ finding: "The document was rendered and an optional reference probe was empty", status: "observed", evidenceRefs: ["episode_1_observation_1", "episode_1_observation_2"] }],
    reuse: { parameters: [], verifiedScope: ["Current renderer"], unverifiedScope: [] }, caseFacts: [], title: "Render and inspect a document", goalSummary: "Render and inspect the current document",
    keywords: ["render", "inspect"], appliesTo: ["A renderer is available"], exclusions: [], learningValue: { status: "actionable", novelty: "new", actionChange: "Inspect the rendered document", verification: "The current render passes inspection" },
    classicPath: [{ objective: "Render and inspect the current document", toolNames: ["document.inspect"], skillIds: [], conditions: [], verification: "The current render matches the request", evidenceRefs: ["episode_1_observation_1"],
      evidenceAssessment: { status: "supported", rationale: "The current render was inspected", evidenceRefs: ["episode_1_observation_2"], limitations: [] } }],
    toolUsage: [], reusableKnowledge: [], failureLessons: [{ trigger: "A reference is missing", symptom: "An optional probe is empty", rootCause: "The source is permanently unavailable", causeStatus: "confirmed",
      nextAction: "Check the current reference scope", verification: "Current source definition is inspected", applicability: ["The reference can be inspected"], evidenceRefs: ["episode_1_observation_2"] }],
    cautions: [], recheckRules: [], merge: { decision: "new", supportingEpisodeIds: input.episodeIds, conflicts: [] } };
}
async function run(model: MemorySettlementModel) {
  const store = new InMemoryMemoryStore();
  await settleV2Batch({ store, model, evidences: [evidence], jobs: [{ ...scope, runId: "one", terminalCommitRef: "outcome:one", settlementJobId: "job:one", enqueuedAt: 1,
    status: "processing", attempts: 1, nextAttemptAt: 1 }], consolidate: true, now: 1 });
  return store;
}
test("local repair replaces only the invalid assessment and cause instead of regenerating the valid learning", async () => {
  let calls = 0;
  const store = await run({ modelKey: "fixture:local-repair", complete: async ({ input }) => {
    const request = input as any; calls++;
    if (!request.correction) return { content: JSON.stringify(learning(request)), usage: { inputTokens: 100, outputTokens: 300 } };
    assert.equal(request.correction.mode, "replace_targets");
    assert.deepEqual(request.correction.targets.map((target: any) => target.path), ["$.classicPath[0].evidenceAssessment", "$.failureLessons[0]"]);
    assert.deepEqual(request.correction.targets[0].context.allowedEvidenceRefs, ["episode_1_observation_1"]);
    assert.deepEqual(request.correction.responseSchema.properties.repairs.items.anyOf[0].properties.value.properties.evidenceRefs.items.enum, ["episode_1_observation_1"]);
    const repairs = request.correction.targets.map((target: any) => ({ path: target.path, value: target.path.includes("evidenceAssessment")
      ? { ...target.current, evidenceRefs: ["episode_1_observation_1"] }
      : { ...target.current, rootCause: "The cause of this empty reference search is unknown", causeStatus: "unknown" } }));
    return { content: JSON.stringify({ repairs }), usage: { inputTokens: 120, outputTokens: 80 } };
  } });
  assert.equal(calls, 2);
  const active = await store.active(scope), group = active.find(entry => entry.item.subtype === "experience.task_group")!;
  const final = group.revision.value.taskGroup as any;
  assert.equal(final.classicPath[0].objective, "Render and inspect the current document");
  assert.deepEqual(final.classicPath[0].evidenceRefs, ["episode_1_observation_1"]);
  assert.deepEqual(final.classicPath[0].evidenceAssessment.evidenceRefs, ["episode_1_observation_1"]);
  assert.equal(final.failureLessons[0].causeStatus, "unknown");
  const attempts = await store.settlementAttempts(scope, "one");
  assert.deepEqual(attempts.map(attempt => attempt.status), ["invalid_output", "accepted"]);
  assert.ok(attempts[1]!.learning);
  assert.equal(attempts[1]!.outputTokens, 80);
});

test("the model can withdraw an invalid independent item while preserving the valid ordered path", async () => {
  const store = await run({ modelKey: "fixture:withdraw", complete: async ({ input }) => {
    const request = input as any;
    if (!request.correction) {
      const output = learning(request); output.classicPath[0].evidenceAssessment.evidenceRefs = output.classicPath[0].evidenceRefs;
      return { content: JSON.stringify(output) };
    }
    return { content: JSON.stringify({ repairs: request.correction.targets.map((target: any) => ({ path: target.path, value: null })) }) };
  } });
  const group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!;
  assert.equal((group.revision.value.taskGroup as any).classicPath.length, 1);
  assert.deepEqual((group.revision.value.taskGroup as any).failureLessons, []);
  assert.equal((group.revision.value.quarantinedUnits as any[])[0].content.causeStatus, "confirmed");
});

test("an invalid local repair cannot change the scope or remove an ordered path", async () => {
  await assert.rejects(run({ modelKey: "fixture:unadmitted-patch", complete: async ({ input }) => {
    const request = input as any;
    return { content: JSON.stringify(request.correction ? { repairs: [{ path: "$.appliesTo", value: ["Every resource"] }] } : learning(request)) };
  } }), /local_repair_invalid/u);
});

test("independent item withdrawal preserves the remaining relation indexes", () => {
  const old = { reusableKnowledge: [{ rule: "bad" }, { rule: "good" }], knowledgeRelations: [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: "bad" }, { claimRef: "reusableKnowledge:1", targetKnowledgeId: "good" }] };
  const repaired = applySettlementRepairs(old, [{ path: "$.reusableKnowledge[0]", value: null }], [{ path: "$.reusableKnowledge[0]", section: "reusableKnowledge", index: 0, current: old.reusableKnowledge[0], schema: {} }]);
  assert.deepEqual(repaired.learning.knowledgeRelations, [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: "good" }]);
  assert.deepEqual(old.reusableKnowledge, [{ rule: "bad" }, { rule: "good" }]);
});

test("an assessment can use its containing claim's citations without generating a redundant list", async () => {
  const store = await run({ modelKey: "fixture:owned-citations", complete: async ({ input }) => {
    const output = learning(input);
    delete output.classicPath[0].evidenceAssessment.evidenceRefs;
    output.failureLessons = [];
    return { content: JSON.stringify(output) };
  } });
  const attempts = await store.settlementAttempts(scope, "one");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.status, "accepted");
  const path = (attempts[0]!.learning as any).classicPath[0];
  assert.deepEqual(path.evidenceAssessment.evidenceRefs, path.evidenceRefs);
});

test("a missing execution review requires a complete evidence summary rather than patching each assessment", async () => {
  let calls = 0;
  await run({ modelKey: "fixture:missing-review", complete: async ({ input }) => {
    const request = input as any, output = learning(request); calls++;
    output.classicPath[0].evidenceAssessment.evidenceRefs = output.classicPath[0].evidenceRefs;
    output.failureLessons = [];
    if (calls === 1) delete output.executionReview;
    else {
      assert.equal(request.correction.mode, undefined);
      assert.deepEqual(request.correction.errors, [{ path: "$.executionReview", code: "execution_review_required" }]);
    }
    return { content: JSON.stringify(output) };
  } });
  assert.equal(calls, 2);
});

test("a model can withdraw an invalid new-claim relation without discarding the independent claim", async () => {
  const store = await run({ modelKey: "fixture:relation-repair", complete: async ({ input }) => {
    const request = input as any;
    if (request.correction) {
      assert.equal(request.correction.mode, "replace_targets");
      assert.equal(request.correction.targets[0].path, "$.knowledgeRelations[0]");
      return { content: JSON.stringify({ repairs: [{ path: "$.knowledgeRelations[0]", value: null }] }) };
    }
    const output = learning(request);
    output.classicPath[0].evidenceAssessment.evidenceRefs = output.classicPath[0].evidenceRefs;
    output.failureLessons = [];
    output.knowledgeRelations = [{ claimRef: "classicPath", targetKnowledgeId: "unused-target", decision: "new", rationale: "This is a new claim, no relationship was actually needed" }];
    return { content: JSON.stringify(output) };
  } });
  const group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!;
  assert.equal((group.revision.value.taskGroup as any).classicPath.length, 1);
  assert.deepEqual((group.revision.value.taskGroup as any).knowledgeRelations, []);
  assert.equal((group.revision.value.quarantinedUnits as any[])[0].section, "knowledgeRelations");
});
