import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMemoryStore, settleV2Batch, SETTLEMENT_V2, REUSABLE_LEARNING_CONTRACT } from "../src/index.ts";
import { KNOWLEDGE_COMPARISON } from "../src/knowledge-comparison.ts";
import type { MemorySettlementEvidence, MemorySettlementModel } from "../src/types.ts";

const scope = { tenantId: "device", ownerUserId: "alice" };
function evidence(runId: string, domain = "documents"): MemorySettlementEvidence {
  return { scope: { ...scope, runId }, runId, terminalCommitRef: `outcome:${runId}`, terminalStatus: "completed",
    strategy: "Inspect the current contract before processing", taskFingerprint: { taskKind: "execute", domain },
    observations: [{ id: "inspect", kind: "action", toolName: "resource.inspect", status: "succeeded", summary: "Inspected the current resource contract and checked the input",
      sourceRefs: [{ type: "action", runId, sourceId: "inspect" }] }], quality: { terminalCommitted: true, assessmentApproved: true, laterCorrected: false, laterDisputed: false },
    sourceRefs: [{ type: "outcome", runId }], occurredAt: 1 };
}
function draft(input: any, version = 1): any {
  const refs = Object.keys(input.sources).filter(ref => /^episode_\d+_observation_1$/u.test(ref));
  return { schema: SETTLEMENT_V2, learningContract: REUSABLE_LEARNING_CONTRACT,
    executionReview: [{ finding: "The current contract was inspected and the input was checked", status: "observed", evidenceRefs: refs }],
    reuse: { parameters: [], verifiedScope: ["Inspected contract"], unverifiedScope: [] }, caseFacts: [], title: "Inspect current contract", goalSummary: "Check the input against its contract",
    keywords: ["contract", "inspect"], appliesTo: ["An authorized current contract exists"], exclusions: [],
    learningValue: { status: "actionable", novelty: "new", actionChange: "Inspect the current contract first", verification: "Input conforms to the current contract" },
    classicPath: [], toolUsage: [], failureLessons: [], cautions: [], recheckRules: [],
    reusableKnowledge: [{ standalone: true, kind: "method", rule: version === 1 ? "Inspect the contract before processing" : "Read the current specification before processing",
      trigger: "New input", action: version === 3 ? "Check schema and resource version" : "Inspect the current contract", verification: "Current input conforms to the current contract",
      conditions: ["Authorized contract is available"], exclusions: ["Contract unavailable"], recheckRules: [], evidenceRefs: refs,
      evidenceAssessment: { status: "supported", rationale: "Current execution performed this scoped check", limitations: [], evidenceRefs: refs } }],
    merge: { decision: "new", supportingEpisodeIds: input.episodeIds, conflicts: [] } };
}
async function run(store: InMemoryMemoryStore, runId: string, model: MemorySettlementModel, domain?: string) {
  const value = evidence(runId, domain);
  return settleV2Batch({ store, evidences: [value], jobs: [{ ...scope, runId, terminalCommitRef: value.terminalCommitRef, settlementJobId: `job:${runId}`,
    enqueuedAt: 1, status: "processing", attempts: 1, nextAttemptAt: 1 }], model, consolidate: true, now: 1000 });
}
function model(decision: "support" | "revise" | "contradict" = "support", mutate?: (comparison: any, input: any) => void): MemorySettlementModel {
  return { modelKey: "fixture:comparison", complete: async ({ input }) => {
    const request = input as any;
    if (request.stage === "selection") return { content: JSON.stringify({ matches: request.candidates.map((item: any) => ({ id: item.id, relevance: 0.99 })) }) };
    if (!request.comparisonContract) return { content: JSON.stringify(draft(request, decision === "revise" ? 3 : request.stage === "extraction" ? 2 : 1)) };
    assert.equal(request.comparisonContract, KNOWLEDGE_COMPARISON);
    const old = request.similarTaskGroups[0], target = request.independentKnowledge?.[0] ?? old.knowledge.find((unit: any) => unit.section === "reusableKnowledge");
    const comparison = { schema: KNOWLEDGE_COMPARISON, rationale: "The fixed current subtask belongs to the same family; compare its claim against the original contract boundary",
      merge: { decision: decision === "support" ? "reinforce" : "refine", targetGroupId: old.id, supportingEpisodeIds: request.episodeIds, conflicts: [] },
      knowledgeRelations: [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: target.knowledgeId, decision, rationale: "Compare the fixed current method and original contract boundary",
        assessments: [{ status: decision === "contradict" ? "contradicted" : "supported", rationale: "The current cited operation was checked against this proposition", limitations: [] }] }] };
    mutate?.(comparison, request);
    return { content: JSON.stringify(comparison) };
  } };
}

for (const domain of ["documents", "coding", "external_api", "data_analysis"]) test(`${domain}: relation-only comparison accumulates, revises and retracts immutable subtask knowledge`, async () => {
  const store = new InMemoryMemoryStore();
  await run(store, "one", model(), domain); await run(store, "two", model(), domain);
  const group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!;
  const unit = (group.revision.value.knowledgeUnits as any[])[0];
  assert.equal(unit.status, "verified"); assert.equal(unit.supports.length, 2);
  assert.ok((await store.active(scope)).some(entry => entry.item.subtype === "experience.knowledge"));
  const accepted = (await store.settlementAttempts(scope, "two")).find(attempt => attempt.comparison)!;
  assert.equal(accepted.schema, KNOWLEDGE_COMPARISON);
  assert.equal((accepted.learning as any).reusableKnowledge[0].rule, "Read the current specification before processing");
  assert.equal((accepted.comparison as any).reusableKnowledge, undefined, "the model never regenerates claim content in comparison");
  await run(store, "three", model("revise"), domain);
  let revised = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!.revision.value.knowledgeUnits as any[];
  assert.equal(revised[0].id, unit.id); assert.equal(revised[0].supports.length, 1); assert.equal(revised[0].status, "candidate");
  await run(store, "four", model("contradict"), domain);
  revised = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!.revision.value.knowledgeUnits as any[];
  assert.equal(revised[0].assessment.status, "contradicted"); assert.equal(revised[0].status, "candidate");
});

test("comparison cannot rewrite an accepted claim and retry reuses the independent extraction", async () => {
  const store = new InMemoryMemoryStore(); await run(store, "one", model());
  let extracts = 0, invalid = true;
  const fixture = model("support", (comparison) => { if (invalid) comparison.reusableKnowledge = [{ rule: "Invent a new stopping policy" }]; });
  const wrapped: MemorySettlementModel = { ...fixture, complete: async request => { if ((request.input as any).stage === "extraction") extracts++; return fixture.complete(request); } };
  await assert.rejects(run(store, "two", wrapped), /settlement_v2:fusion/);
  assert.equal(extracts, 1);
  assert.equal(((await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!.revision.value.knowledgeUnits as any[])[0].supports.length, 1);
  invalid = false; await run(store, "two", wrapped);
  assert.equal(extracts, 1, "accepted independent extraction survives comparison failure");
  const attempts = await store.settlementAttempts(scope, "two");
  assert.equal(attempts.filter(attempt => attempt.schema === KNOWLEDGE_COMPARISON && attempt.status === "invalid_output").length, 2);
});

test("comparison refuses duplicate identities and unknown targets without changing prior support", async () => {
  for (const failure of ["duplicate", "unknown"]) {
    const store = new InMemoryMemoryStore(); await run(store, "one", model());
    await assert.rejects(run(store, "two", model("support", comparison => {
      if (failure === "unknown") comparison.knowledgeRelations[0].targetKnowledgeId = "unadmitted";
      else comparison.knowledgeRelations.push(structuredClone(comparison.knowledgeRelations[0]));
    })), failure === "unknown" ? /knowledge_not_admitted/ : /knowledge_relation_duplicate/);
    assert.equal(((await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!.revision.value.knowledgeUnits as any[])[0].supports.length, 1);
  }
});

test("reinforcing a group preserves a new independent subtask and later support keeps its parameter identity", async () => {
  const store = new InMemoryMemoryStore(); await run(store, "one", model());
  const extended = (supportExtra: boolean): MemorySettlementModel => {
    const fixture = model();
    return { ...fixture, complete: async request => {
      const reply = await fixture.complete(request), input = request.input as any;
      if (input.stage === "selection") return reply;
      const output = JSON.parse(reply.content);
      if (!input.comparisonContract) {
        output.reuse.parameters = [{ name: "input", description: supportExtra ? "The newly selected input document" : "Current input" }];
        output.reusableKnowledge.push({ ...structuredClone(output.reusableKnowledge[0]), rule: "Inspect the output encoding separately",
          action: "Check current output encoding", operation: "encoding-check --input {{input}}" });
      } else if (supportExtra) {
        const target = input.independentKnowledge.find((unit: any) => unit.content?.operation === "encoding-check --input {{input}}");
        assert.ok(target, "an independent claim outside the canonical group text is available for comparison");
        output.knowledgeRelations.push({ ...structuredClone(output.knowledgeRelations[0]), claimRef: "reusableKnowledge:1", targetKnowledgeId: target.knowledgeId });
      }
      return { content: JSON.stringify(output) };
    } };
  };
  await run(store, "two", extended(false));
  let group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!;
  assert.equal((group.revision.value.taskGroup as any).reusableKnowledge.length, 1, "reinforcement keeps the canonical group");
  const first = (group.revision.value.knowledgeUnits as any[]).find(unit => unit.content.operation?.startsWith("encoding-check"));
  assert.ok(first, "new independently scoped knowledge is retained outside the canonical text");
  assert.equal(first.status, "candidate"); assert.equal(first.supports.length, 1);
  await run(store, "three", extended(true));
  group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!;
  const units = (group.revision.value.knowledgeUnits as any[]).filter(unit => unit.content.operation?.startsWith("encoding-check"));
  assert.equal(units.length, 1); assert.equal(units[0].id, first.id); assert.equal(units[0].contentId, first.contentId);
  assert.deepEqual(units[0].parameters, [{ name: "input", description: "Current input" }]);
  assert.equal(units[0].supports.length, 2); assert.equal(units[0].status, "verified");
  assert.ok((await store.active(scope)).some(entry => entry.item.subtype === "experience.knowledge" && (entry.revision.value.taskKnowledge as any)?.knowledgeId === first.id));
});

test("a comparison cannot replace current citations with historical references", async () => {
  const store = new InMemoryMemoryStore(); await run(store, "one", model());
  await assert.rejects(run(store, "two", model("support", (comparison, input) => {
    comparison.knowledgeRelations[0].evidenceRefs = [Object.keys(input.sources).find(ref => ref.startsWith("group_"))];
  })), /settlement_v2:fusion/);
  const group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!;
  assert.equal((group.revision.value.knowledgeUnits as any[])[0].supports.length, 1);
});

test("an optional comparison assessment citation stays within the fixed claim's own sources", async () => {
  for (const outside of [false, true]) {
    const store = new InMemoryMemoryStore(); await run(store, "one", model());
    const operation = run(store, "two", model("support", (comparison, input) => {
      comparison.knowledgeRelations[0].assessments[0].evidenceRefs = outside
        ? [Object.keys(input.sources).find(ref => ref.startsWith("group_"))] : input.independentLearning.reusableKnowledge[0].evidenceRefs;
    }));
    if (outside) await assert.rejects(operation, /assessment_outside_claim/);
    else await operation;
    const group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!;
    assert.equal((group.revision.value.knowledgeUnits as any[])[0].supports.length, outside ? 1 : 2);
  }
});

test("a revision cannot turn a method into environmental cognition under the same knowledge identity", async () => {
  const store = new InMemoryMemoryStore(); await run(store, "one", model());
  const fixture = model("revise");
  const changedType: MemorySettlementModel = { ...fixture, complete: async request => {
    const reply = await fixture.complete(request), input = request.input as any;
    if (input.stage === "extraction") {
      const output = JSON.parse(reply.content);
      output.reusableKnowledge[0].kind = "scoped_rule";
      output.reusableKnowledge[0].recheckRules = ["Re-read current metadata after a resource revision"];
      return { content: JSON.stringify(output) };
    }
    if (input.comparisonContract) assert.deepEqual(input.comparisonChoices[0].targets, [], "generation choices exclude a different knowledge role");
    return reply;
  } };
  await assert.rejects(run(store, "two", changedType), /knowledge_kind_changed/);
  const group = (await store.active(scope)).find(entry => entry.item.subtype === "experience.task_group")!;
  assert.equal((group.revision.value.knowledgeUnits as any[])[0].content.kind, "method");
  assert.equal((group.revision.value.knowledgeUnits as any[])[0].supports.length, 1);
});
