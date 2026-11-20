import assert from "node:assert/strict";
import test from "node:test";
import { accumulateKnowledge, revalidateKnowledge, verifiedLearning } from "../src/knowledge.ts";

const episodes = ["one", "two"].map(runId => ({ runId, executionKey: `run:${runId}`, evidenceHash: runId, outcome: "verified_success" }));
const sources = Object.fromEntries(episodes.map(episode => [episode.runId, [{ type: "action" as const, runId: episode.runId, sourceId: "inspect" }]]));
function learning(status?: "supported" | "tentative" | "contradicted") {
  return { reuse: { parameters: [] }, appliesTo: ["Current resource"], exclusions: [], classicPath: [], failureLessons: [],
    reusableKnowledge: [{ kind: "method", rule: "Inspect definitions when a successful search is empty", conditions: ["The search completed and returned zero matches"], evidenceRefs: ["one", "two"],
      ...(status ? { evidenceAssessment: { status, rationale: "Both executions rejected malformed input; they did not observe a successful empty search",
        evidenceRefs: ["one", "two"], limitations: ["The empty-search condition was not exercised"] } } : {}) }] };
}

test("successful Runs and valid repeated citations cannot replace the model's claim assessment", () => {
  for (const status of [undefined, "tentative", "contradicted"] as const) {
    const [unit] = accumulateKnowledge(learning(status), sources, episodes);
    assert.equal(unit!.supports.length, 2);
    assert.equal(unit!.status, "candidate");
    assert.equal(revalidateKnowledge([unit!], episodes)[0]!.status, "candidate", "reconciliation cannot promote a candidate by counting again");
  }
});

test("model assessment changes maturity without changing claim identity; retracted evidence requires reassessment", () => {
  const tentative = accumulateKnowledge(learning("tentative"), sources, episodes);
  const supported = accumulateKnowledge(learning("supported"), sources, episodes, tentative);
  assert.equal(supported[0]!.id, tentative[0]!.id);
  assert.equal(supported[0]!.status, "verified");
  assert.equal(supported[0]!.assessment!.evidence.length, 2);
  assert.deepEqual(verifiedLearning(learning("supported"), supported).cautions, ["The empty-search condition was not exercised"]);
  const retracted = revalidateKnowledge(supported, [{ ...episodes[0]!, evidenceHash: "corrected" }]);
  assert.equal(retracted[0]!.status, "candidate");
  const countRestored = { ...retracted[0]!, supports: [...retracted[0]!.supports, { runId: "three", executionKey: "run:three", evidenceHash: "three" }] };
  assert.equal(revalidateKnowledge([countRestored], [])[0]!.status, "candidate", "a different receipt cannot replace the evidence the model actually reviewed");
});
