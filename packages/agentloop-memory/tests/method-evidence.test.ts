import assert from "node:assert/strict";
import test from "node:test";
import { settlementMethodView } from "../src/method-evidence.ts";
import type { MemorySettlementEvidence } from "../src/types.ts";

type Observation = NonNullable<MemorySettlementEvidence["observations"]>[number];
function evidence(observations: Observation[]): MemorySettlementEvidence {
  return { scope: { tenantId: "device", ownerUserId: "alice", runId: "run" }, runId: "run", terminalCommitRef: "outcome", terminalStatus: "completed",
    taskFingerprint: {}, observations, sourceRefs: [], occurredAt: 1,
    quality: { terminalCommitted: true, assessmentApproved: true, laterCorrected: false, laterDisputed: false } };
}
function action(id: string, operation = "collect", extra: Partial<Observation> = {}): Observation {
  return { id, kind: "action", stepOrder: 1, toolName: "workflow.execute", status: "succeeded", summary: operation,
    details: { repeatIdentity: operation, method: { operation, argumentFields: ["scope"] } }, sourceRefs: [{ type: "action", runId: "run", sourceId: id }], ...extra };
}
function modelView(value: ReturnType<typeof settlementMethodView>) {
  return { ...value, observations: value.observations.map(({ sourceRefs: _refs, sourceIndex: _index, ...row }) => row) };
}

test("thousands of identical acquisition cycles become two methods and one repeated path", () => {
  const value = evidence(Array.from({ length: 2000 }, (_, i) => [action(`read-${i}`, "inspect definition"), action(`query-${i}`, "collect current evidence")]).flat());
  const before = JSON.stringify(value);
  const view = settlementMethodView(value);
  assert.equal(view.observations.length, 2);
  assert.deepEqual(view.observations.map(row => row.occurrences), [2000, 2000]);
  assert.deepEqual(view.executionPath, [{ methods: ["method_1", "method_2"], repetitions: 2000 }]);
  assert.deepEqual(view.methodCoverage, { originalObservations: 4000, methodCards: 2, repeatedActions: 3998 });
  assert.equal(view.observations[0]!.sourceRefs.length, 2000, "all original receipts remain locally resolvable");
  assert.ok(JSON.stringify(modelView(view)).length < 2000, "model input scales with methods, not repeated calls");
  assert.equal(JSON.stringify(value), before);
});

test("decisions, failures, changed methods and step boundaries cannot disappear into repetition", () => {
  const view = settlementMethodView(evidence([
    action("a"), action("b"),
    { id: "choice", kind: "decision", status: "user_confirmed", summary: "Choose the current scope", sourceRefs: [] },
    action("c"), action("failed", "collect", { status: "failed" }), action("repaired"),
    action("new-method", "inspect definition"), action("other-step", "collect", { stepOrder: 2 }),
  ]));
  assert.deepEqual(view.observations.map(row => row.occurrences), [2, 1, 1, 1, 1, 1, 1]);
  assert.equal(view.observations[3]!.status, "failed");
  const route = view.executionPath.flatMap(segment => Array.from({ length: segment.repetitions }, () => segment.methods).flat());
  assert.deepEqual(route, ["method_1", "method_1", "method_2", "method_3", "method_4", "method_5", "method_6", "method_7"]);
});

test("method details exclude arbitrary payloads and choice catalogs while retaining selected scope and checks", () => {
  const view = settlementMethodView(evidence([
    action("read", "inspect", { details: { method: { operation: "inspect" }, modelInput: "RAW_PROMPT", modelOutput: "RAW_RESPONSE", toolReturn: "RAW_ROWS" } }),
    { id: "decision", kind: "decision", status: "user_confirmed", summary: "Select scope", sourceRefs: [],
      details: { question: "Choose current scope", selectedOptions: [{ id: "current", label: "Current scope" }], candidates: ["FULL_CATALOG"], persistenceIntent: "task_only" } },
    { id: "assessment", kind: "assessment", stepOrder: 1, status: "approved", summary: "Current scope verified", sourceRefs: [], relatedObservationIds: ["read"] },
  ]));
  const serialized = JSON.stringify(modelView(view));
  assert.doesNotMatch(serialized, /RAW_PROMPT|RAW_RESPONSE|RAW_ROWS|FULL_CATALOG/);
  assert.match(serialized, /Current scope|task_only/);
  assert.deepEqual(view.observations[2]!.relatedObservationIds, ["method_1"]);
});

test("causally verified evidence cannot merge into an unverified action", () => {
  const view = settlementMethodView(evidence([action("ordinary"), action("verified", "collect", { details: { causalVerification: true } })]));
  assert.equal(view.observations.length, 2);
  assert.equal(view.observations[0]!.details!.causalVerification, undefined);
  assert.equal(view.observations[1]!.details!.causalVerification, true);
});

test("identical command forms with different evidence or unknown identity stay distinct", () => {
  const view = settlementMethodView(evidence([
    action("empty", "query", { details: { repeatIdentity: "empty-result", purpose: "Find candidates", resultProfile: [{ pointer: "/rows", items: 0 }] } }),
    action("coverage", "query", { details: { repeatIdentity: "coverage-result", purpose: "Check coverage", resultProfile: [{ pointer: "/rows", items: 1 }] } }),
    action("matched", "query", { details: { repeatIdentity: "matched-result", purpose: "Find candidates", resultProfile: [{ pointer: "/rows", items: 9 }] } }),
    action("unknown-1", "query", { details: {} }), action("unknown-2", "query", { details: {} }),
  ]));
  assert.equal(view.observations.length, 5);
  assert.doesNotMatch(JSON.stringify(modelView(view)), /empty-result|coverage-result|matched-result/);
  assert.match(JSON.stringify(modelView(view)), /Find candidates|Check coverage/);
});

test("public findings preserve empty-result decisions and links without becoming verified causes", () => {
  const view = settlementMethodView(evidence([
    action("search"),
    { id: "finding", kind: "decision", status: "interpreted", summary: "No candidates under the current filter", relatedObservationIds: ["search"], sourceRefs: [],
      details: { purpose: "Find an authoritative source", finding: "Current filter returned no candidates", informationStatus: "unfulfilled",
        nextAction: "Inspect coverage before broadening discovery", authority: "model_interpretation" } },
    action("coverage", "inspect coverage"),
  ]));
  assert.equal(view.observations[1]!.details!.informationStatus, "unfulfilled");
  assert.equal(view.observations[1]!.details!.authority, "model_interpretation");
  assert.deepEqual(view.observations[1]!.relatedObservationIds, ["method_1"]);
  assert.equal(view.observations[1]!.details!.causalVerification, undefined);
  assert.deepEqual(view.executionPath, [{ methods: ["method_1", "method_2", "method_3"], repetitions: 1 }]);
});
