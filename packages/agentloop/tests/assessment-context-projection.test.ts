import assert from "node:assert/strict";
import test from "node:test";
import { projectAssessmentContext } from "../src/planning/assessment-context-projection.ts";

function expand(view: Record<string, unknown>): any {
  const visit = (value: any): any => {
    if (value?.schema === "agentloop.assessmentEvidenceReference/v1" && value.ref?.startsWith("#/")) {
      const target = value.ref.slice(2).split("/").reduce((node: any, token: string) => node[token.replace(/~1/g, "/").replace(/~0/g, "~")], view);
      assert.notEqual(target, undefined, value.ref);
      return visit(target);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]));
    return value;
  };
  const restored = visit(view);
  for (const call of [...(restored.evidence?.toolCalls ?? []), ...(restored.decisionWorkingSet?.currentEvidence ?? [])]) if (call.resultEncoding) {
    for (const [name, encoding] of Object.entries(call.resultEncoding.streams ?? {}) as [string, any][]) {
      call.result[name] = encoding.prefix + JSON.stringify(call.result[name]) + encoding.suffix;
    }
    call.result = JSON.stringify(call.result); delete call.resultEncoding;
  }
  return restored;
}

for (const domain of ["code", "research", "analysis", "document"]) {
  test(`${domain} assessment shares identical evidence without losing exact content, unknowns or versions`, () => {
    const common = { ["escaped/key~"]: { exact: "original result ".repeat(300), unknown: "source B conflicts", version: "v2", verification: "unverified" } };
    const result = JSON.stringify({ schema: "test.evidence/v1", root: common, rows: [{ date: "2026-01-01", value: 42 }] });
    const input = { canonicalIntent: { userInput: "Only A; corrected scope; do not publish", amendment: "Exact user wording" },
      userAuthority: { hil: "Selected option 2", constraint: "Do not retry unknown effects" },
      evidence: { candidateOutput: domain, toolCalls: [{ toolCallId: "source", result }, { toolCallId: "read", result }] },
      evidenceTimeline: [{ seq: 1, data: { arguments: common } }, { seq: 2, data: { arguments: common, operationStatus: "unknown" } }] };
    const before = structuredClone(input); const { view, diagnostics } = projectAssessmentContext(input);
    assert.deepEqual(input, before); assert.deepEqual(expand(view), input);
    assert.deepEqual(view.userAuthority, input.userAuthority); assert.deepEqual(view.canonicalIntent, input.canonicalIntent);
    assert.ok(diagnostics.sharedReferences > 0); assert.ok(diagnostics.projectedCharacters < diagnostics.sourceCharacters / 2);
  });
}

test("noncanonical JSON, duplicate keys and unsafe numeric representations remain exact text", () => {
  for (const result of ['{ "value": 42 }', '{"value":1,"value":2}', '{"value":9007199254740993}', '{"value":-0}', "code with exact whitespace\n  x()"] ) {
    const input = { evidence: { toolCalls: [{ result }] } }; const projected = projectAssessmentContext(input);
    assert.equal(projected.diagnostics.parsedResults, 0); assert.deepEqual(expand(projected.view), input);
  }
});

test("command JSON streams share receipt values and restore every original byte", () => {
  const receipt = { facts: Array.from({ length: 40 }, (_, n) => ({ n, content: "exact source ".repeat(30) })) };
  for (const whitespace of ["", "\n", "\r\n"]) {
    const input = { evidence: { toolCalls: [{ result: JSON.stringify({ exitCode: 0, stdout: JSON.stringify(receipt) + whitespace,
      stderr: "", evidenceReceipt: receipt }) }] } };
    const { view, diagnostics } = projectAssessmentContext(input);
    assert.deepEqual(expand(view), input);
    assert.equal(diagnostics.parsedStreams, 1);
    assert.ok(diagnostics.projectedCharacters < diagnostics.sourceCharacters * 0.6);
  }
  for (const stdout of ['{"x":1,"x":2}', '{"x":9007199254740993}', '{ "x":42}', '{"x":-0}', "\u00a0{}\n"]) {
    const input = { evidence: { toolCalls: [{ result: JSON.stringify({ exitCode: 0, stdout, stderr: "" }) }] } };
    const { view, diagnostics } = projectAssessmentContext(input);
    assert.deepEqual(expand(view), input); assert.equal(diagnostics.parsedStreams, 0);
  }
});

test("assessment and execution use the same exact current evidence encoding", () => {
  const source = { conflict: "scope A differs from B", version: "r2", content: "exact detail ".repeat(200) };
  const result = JSON.stringify({ exitCode: 0, stdout: JSON.stringify(source) + "\r\n", stderr: "", evidenceReceipt: source });
  const input = { evidence: { toolCalls: [{ result }] }, decisionWorkingSet: { currentEvidence: [{ result }] } };
  const { view, diagnostics } = projectAssessmentContext(input);
  assert.deepEqual(expand(view), input);
  assert.equal(diagnostics.parsedStreams, 2);
  assert.ok(diagnostics.sharedReferences > 0);
});

test("distinct evidence and different versions are never replaced by hash, recency or keyword", () => {
  const input = { evidence: { toolCalls: [1, 2, 3].map(version => ({ result: JSON.stringify({ text: "required detail ".repeat(200), version }) })) } };
  const projected = projectAssessmentContext(input); assert.deepEqual(expand(projected.view), input);
  assert.equal((expand(projected.view).evidence.toolCalls[2] as any).result, input.evidence.toolCalls[2].result);
});

test("existing result encoding metadata is preserved rather than overwritten", () => {
  const input = { evidence: { toolCalls: [{ result: '{"value":42}', resultEncoding: { format: "host-owned" } }] } };
  const projected = projectAssessmentContext(input);
  assert.equal(projected.diagnostics.parsedResults, 0);
  assert.deepEqual(projected.view, input);
});

test("assessment diagnostics measure structured state and evidence without recording bodies", async () => {
  const { modelInvocationComposition } = await import("../src/runtime/model-streaming.ts");
  const { view } = projectAssessmentContext({ canonicalRunState: { goal: "Only A" }, currentDecisionView: { product: "v2" },
    decisionWorkingSet: { items: [{ category: "unknown", text: "B is unknown" }] }, evidence: { candidateOutput: "42", toolCalls: [] } });
  const composition = modelInvocationComposition({ phase: "assessment", systemPrompt: "Assess", tools: [], messages: [],
    runtimeContext: { id: "assessment", phase: "assessment", content: `<assessment_context source="server">${JSON.stringify(view)}</assessment_context>` } }) as any;
  assert.ok(composition.decisionContextDiagnostics.currentStateAndProducts.characters > 0);
  assert.ok(composition.decisionContextDiagnostics.currentWorkingSetAndHistoryIndex.characters > 0);
  assert.ok(composition.decisionContextDiagnostics.historyDetails.characters > 0);
  assert.doesNotMatch(JSON.stringify(composition), /B is unknown/);
});

test("evidence chronology keeps all referenced events and exact errors instead of a last-N cut", async () => {
  const { persistedEvidenceTimeline } = await import("../src/runtime/run-service.ts");
  const error = "exact failure detail ".repeat(300);
  const events = Array.from({ length: 320 }, (_, index) => ({ seq: index + 1, createdAt: index, type: "tool.failed", data: { toolCallId: "current-source", error } }));
  const timeline = persistedEvidenceTimeline(events as any, ["current-source"]);
  assert.equal(timeline.length, 320); assert.equal(timeline[0].seq, 1); assert.equal(timeline[0].data.error, error);
  assert.deepEqual(persistedEvidenceTimeline(events as any, ["unrelated"]), []);
});
