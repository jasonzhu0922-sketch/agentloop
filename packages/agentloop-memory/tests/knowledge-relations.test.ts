import assert from "node:assert/strict";
import test from "node:test";
import { accumulateKnowledge, projectedKnowledgeBindings, verifiedLearning } from "../src/knowledge.ts";
import { alignKnowledgeClaims, knowledgeInventory } from "../src/knowledge-relations.ts";

const episode = (runId: string) => ({ runId, executionKey: `run:${runId}`, evidenceHash: runId, outcome: "verified_success" });
const sources = Object.fromEntries(["one", "two", "three"].map(runId => [runId, [{ type: "action" as const, runId, sourceId: "inspect" }]]));
function learning(ref: string, rule = "Inspect the current resource contract before processing") {
  return { reuse: { parameters: [] }, appliesTo: ["A current resource contract is available"], exclusions: [], classicPath: [], failureLessons: [],
    reusableKnowledge: [{ kind: "method", standalone: true, rule, trigger: "New input", action: "Inspect the resource contract", verification: "The current input satisfies it",
      conditions: ["An authorized current resource contract is available"], exclusions: ["No current contract exists"], recheckRules: [], evidenceRefs: [ref],
      evidenceAssessment: { status: "supported", rationale: "The cited action exercises this method", evidenceRefs: [ref], limitations: [] } }] };
}

test("model-declared equivalent wording accumulates support under the original claim and stable ID", () => {
  const first = learning("one"), old = accumulateKnowledge(first, sources, [episode("one")]);
  const incoming = { ...learning("two", "Read the current specification before working on the input"), knowledgeRelations: [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: old[0]!.id, decision: "support", rationale: "The same method under its original prerequisites" }] };
  incoming.reusableKnowledge[0]!.conditions = ["Any resource whatsoever"];
  const aligned = alignKnowledgeClaims(incoming, old);
  assert.deepEqual(aligned.reusableKnowledge[0].conditions, first.reusableKnowledge[0]!.conditions, "support cannot broaden the old claim");
  const units = accumulateKnowledge(aligned, sources, [episode("two")], old, incoming);
  assert.equal(units[0]!.id, old[0]!.id);
  assert.equal(units[0]!.status, "verified");
  assert.deepEqual(units[0]!.supports.map(support => support.runId), ["one", "two"]);
  assert.equal(verifiedLearning(aligned, units).reusableKnowledge.length, 1);
  assert.equal(projectedKnowledgeBindings({ taskGroup: aligned, knowledgeUnits: units })[0]!.knowledgeId, old[0]!.id);
  assert.equal(knowledgeInventory(aligned, units)[0]!.claimRef, "reusableKnowledge:0");
  const replay = accumulateKnowledge(aligned, sources, [episode("two")], units, incoming);
  assert.equal(replay[0]!.supports.length, 2, "replay is not another execution");
});

test("reinforce can retain historical group wording while using explicitly mapped current evidence", () => {
  const first = learning("one"), old = accumulateKnowledge(first, sources, [episode("one")]);
  const incoming = { ...learning("two", "A paraphrase"), knowledgeRelations: [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: old[0]!.id, decision: "support", rationale: "Same claim" }] };
  const units = accumulateKnowledge(first, sources, [episode("two")], old, incoming);
  assert.equal(units[0]!.status, "verified");
  assert.deepEqual(units[0]!.supports.map(item => item.runId), ["one", "two"]);
});

test("a changed scope keeps identity as a revision but cannot inherit earlier validation", () => {
  const first = learning("one"); first.reusableKnowledge[0]!.evidenceRefs = ["one", "two"];
  const old = accumulateKnowledge(first, sources, [episode("one"), episode("two")]);
  assert.equal(old[0]!.status, "verified");
  const incoming = { ...learning("three", "A revised method for a different resource scope"), knowledgeRelations: [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: old[0]!.id, decision: "revise", rationale: "The premise and operation changed" }] };
  const aligned = alignKnowledgeClaims(incoming, old), units = accumulateKnowledge(aligned, sources, [episode("three")], old, incoming);
  assert.equal(units[0]!.id, old[0]!.id);
  assert.notEqual(units[0]!.contentId, old[0]!.contentId);
  assert.deepEqual(units[0]!.supports.map(item => item.runId), ["three"]);
  assert.equal(units[0]!.status, "candidate");
  assert.equal(verifiedLearning(aligned, units).reusableKnowledge.length, 0);
});

test("unmapped paraphrases, inherited results and contradictions never manufacture independent support", () => {
  const first = learning("one"), old = accumulateKnowledge(first, sources, [episode("one")]);
  const different = learning("two", "Unmapped paraphrase");
  assert.equal(accumulateKnowledge(first, sources, [episode("two")], old, different)[0]!.supports.length, 1);
  const incoming: any = { ...different, knowledgeRelations: [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: old[0]!.id, decision: "support", rationale: "Same claim" }] };
  assert.equal(accumulateKnowledge(first, sources, [{ ...episode("two"), independent: false }], old, incoming)[0]!.supports.length, 1);
  incoming.knowledgeRelations[0].decision = "contradict";
  incoming.reusableKnowledge[0].evidenceAssessment.status = "contradicted";
  const units = accumulateKnowledge(alignKnowledgeClaims(incoming, old), sources, [episode("two")], old, incoming);
  assert.equal(units[0]!.assessment!.status, "contradicted");
  assert.equal(units[0]!.status, "candidate");
  assert.equal(units[0]!.supports.length, 1);
});

test("a previously stored revision relation is not replayed as a new revision in later exact reinforcement", () => {
  const first = learning("one"), old = accumulateKnowledge(first, sources, [episode("one")]);
  const revision = { ...learning("two", "Revised contract inspection"), knowledgeRelations: [{ claimRef: "reusableKnowledge:0", targetKnowledgeId: old[0]!.id, decision: "revise", rationale: "Changed operation" }] };
  const revised = accumulateKnowledge(revision, sources, [episode("two")], old);
  const next = learning("three", "Revised contract inspection");
  const units = accumulateKnowledge(revision, sources, [episode("three")], revised, next);
  assert.equal(units[0]!.id, old[0]!.id);
  assert.deepEqual(units[0]!.supports.map(row => row.runId), ["two", "three"]);
  assert.equal(units[0]!.status, "verified");
});

test("unmentioned standalone knowledge retains its own parameters and support during an unrelated refinement", () => {
  const first = learning("one");
  first.reuse.parameters = [{ name: "input", description: "The current input to inspect" }] as any;
  first.reusableKnowledge[0]!.action = "Inspect {{input}}";
  first.reusableKnowledge[0]!.evidenceRefs = ["one", "two"];
  const old = accumulateKnowledge(first, sources, [episode("one"), episode("two")]);
  const incoming = learning("three", "A different independently scoped method");
  const units = accumulateKnowledge(incoming, sources, [episode("three")], old);
  const retained = units.find(unit => unit.id === old[0]!.id)!;
  assert.equal(retained.status, "verified");
  assert.deepEqual(retained.supports.map(row => row.runId), ["one", "two"]);
  assert.deepEqual(retained.parameters, [{ name: "input", description: "The current input to inspect" }]);
  const inventory = knowledgeInventory(incoming, units);
  assert.equal(inventory.find(row => row.knowledgeId === retained.id)!.content, retained.content);
});
