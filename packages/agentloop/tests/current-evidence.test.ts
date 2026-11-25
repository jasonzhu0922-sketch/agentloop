import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import { deriveDecisionWorkingSet } from "../src/runtime/decision-working-set.ts";
import { deriveCurrentDecisionView } from "../src/runtime/current-decision-view.ts";
import { committedDecisionRecords } from "../src/runtime/committed-decision-records.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { createResultTool } from "../src/tools/result-tool.ts";
import { modelInvocationComposition } from "../src/runtime/model-streaming.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import type { ModelAdapter, ModelMessage, RuntimeEvent } from "../src/runtime/contracts.ts";

const identity = { runId: "exact-evidence", planId: "plan", stepId: "leaf", eventWatermark: 0,
  reducerVersion: "v1" as const, viewId: "view", decisionBasisDigest: "basis" };
const basis = { identity, contextArgumentTools: ["inspect"], toolEffects: { inspect: "read" as const, computer_read_json: "read" as const, mutate: "write" as const } };
const reader = createResultTool({} as never);
const definition = { name: reader.name, description: reader.description, inputSchema: reader.inputSchema };
const model: ModelAdapter = { completedExchangePolicy: "releasable", limits: { contextWindowTokens: 128000, maxOutputTokens: 4096 },
  complete: async () => { throw Error("No maintenance or compaction call is permitted"); } };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function pair(n: number, args: unknown, value: unknown, toolName = "inspect"): ModelMessage[] {
  const id = `source-${n}`;
  const ref = { schema: "agentloop.resultRef/v1", resultId: `rr_${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` };
  return [{ role: "assistant", content: "", toolCalls: [{ id, name: toolName, arguments: args }], executionHistoryBasis: basis },
    { role: "tool", toolCallId: id, name: toolName, content: JSON.stringify({ ...value as object, resultRef: ref }), isError: false,
      executionOutcome: { invocationStatus: "completed", operationStatus: "succeeded" } }];
}
function assembler(adapter = model, events?: readonly RuntimeEvent[]) {
  return new ContextAssembler({ runId: identity.runId, systemPrompt: "Use exact evidence and preserve uncertainty.", model: adapter,
    runtimeContext: { phase: "execution", content: "Goal: subject A only. HIL: do not publish or repeat unknown effects." },
    ...(events ? { decisionEvents: () => events } : {}) });
}
function expand(value: any, root = value): any {
  if (value?.schema === "agentloop.assessmentEvidenceReference/v1") {
    const target = value.ref.slice(2).split("/").reduce((node: any, key: string) => node[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
    return expand(target, root);
  }
  if (Array.isArray(value)) return value.map(item => expand(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, root)]));
  return value;
}
function exactState(content: string) {
  const state = JSON.parse(content.match(/<decision_working_set[^>]*>([\s\S]*?)<\/decision_working_set>/)![1]);
  const block = state.currentEvidence;
  return { state, entries: block ? expand(block).evidence.toolCalls : [] };
}

for (const [domain, data] of [
  ["code", { version: "r2", validation: { status: "passed", boundTo: "r2" }, oldError: { version: "r1", applicability: "historical" } }],
  ["research", { sourceA: { conclusion: "C", date: "2026-01-01" }, sourceB: { date: "2026-01-02" }, conflict: "date", unknown: "before 2026" }],
  ["analysis", { population: "A", period: "2026-H1", value: 42, calculation: "10 + 32", currency: "CNY", excluded: "B" }],
  ["document", { version: "r2", replaces: "r1", status: "unverified", finalDelivery: "pending", deleted: "experiment" }],
] as const) test(`${domain}: empty semantic updates transfer exact content and provenance on the very next decision`, async () => {
  const messages = [{ role: "user", content: "HIL: A only; no publication" } as ModelMessage,
    ...pair(1, { selection: domain, _agentloopContext: { updates: [] } }, data)];
  const instance = assembler();
  const assembled = await instance.assemble(messages, [definition]);
  assert.equal(assembled.messages.length, 1, "complete releasable exchange moves to exact state");
  const { state, entries } = exactState(assembled.runtimeContext.content);
  assert.equal(state.items.length, 0, "no invented semantic fact or model authority");
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].arguments, { selection: domain });
  assert.deepEqual(entries[0].result, JSON.parse((messages[2] as any).content));
  assert.equal(entries[0].resultRef.resultId, entries[0].result.resultRef.resultId);
  assert.equal(instance.decisionWorkingSet?.pendingToolCallIds.length, 0);
  assert.match(assembled.runtimeContext.content, /HIL: do not publish/);
  assert.equal(assembled.contextEpoch, 0);
});

test("100 to 160 empty-update reads of one immutable selection remain bounded without model summaries", async () => {
  const measurements = [];
  const roomyModel = { ...model, limits: { ...model.limits, contextWindowTokens: 8_000_000 } };
  for (const count of [100, 160]) {
    const messages: ModelMessage[] = [{ role: "user", content: "Only A; preserve unknown scope" }];
    const value = { path: "evidence.json", sha256: hash("same source"), schema: "agentloop.jsonRead/v1",
      queries: [{ sourcePointer: "/rows", offset: 0, returned: 1, totalItems: 2, nextOffset: 1,
        value: [{ value: 42, scope: "A", unknown: "B", provenance: "exact source ".repeat(120) }] }],
      caveats: ["Only row 0 acquired. Row 1 remains unread."] };
    for (let index = 1; index <= count; index++) messages.push(...pair(index, { path: "evidence.json", queries: [{ pointer: "/rows", limit: 1 }], _agentloopContext: { updates: [] } }, value, "computer_read_json"));
    const instance = assembler(roomyModel); const current = await instance.assemble(messages, [definition]);
    const { entries } = exactState(current.runtimeContext.content);
    assert.equal(entries.length, 1); assert.equal(entries[0].occurrences, count);
    assert.equal(entries[0].result.queries[0].nextOffset, 1);
    assert.equal(entries[0].result.queries[0].value[0].value, 42);
    assert.equal(entries[0].result.queries[0].value[0].unknown, "B");
    assert.equal(current.contextEpoch, 0); assert.equal(instance.decisionWorkingSet?.historicalObservationCount, count - 1);
    const legacy = new ContextAssembler({ runId: identity.runId, systemPrompt: "Use exact evidence and preserve uncertainty.", model: roomyModel,
      policy: { executionHistoryProjection: "canonical" }, runtimeContext: { phase: "execution", content: "Goal: subject A only. HIL: do not publish or repeat unknown effects." } });
    const before = await legacy.assemble(messages, [definition]);
    const measure = (v: typeof current) => modelInvocationComposition({ phase: "execution", systemPrompt: "Fixed", tools: [definition], ...v }).totalCharacters as number;
    measurements.push({ observations: count, beforeCharacters: measure(before), afterCharacters: measure(current) });
  }
  assert.ok(measurements[1].beforeCharacters > measurements[0].beforeCharacters * 1.5);
  assert.ok(measurements[1].afterCharacters < measurements[0].afterCharacters * 1.02);
  console.log(`EMPTY_UPDATES_60_PERCENT ${JSON.stringify(measurements)}`);
});

test("scope, windows, versions, failed conditions and distinct conflicts are never coalesced by value", async () => {
  const messages = [...pair(1, { scope: "A", pointer: "/rows", offset: 0 }, { value: 42, version: "r1", conflict: "B disagrees", unknown: "earlier period" }),
    ...pair(2, { scope: "B", pointer: "/rows", offset: 0 }, { value: 42, version: "r1" }),
    ...pair(3, { scope: "A", pointer: "/rows", offset: 1 }, { value: 42, version: "r2" }),
    ...pair(4, { scope: "A", pointer: "/rows", offset: 0 }, { error: "condition P fails" })];
  const instance = assembler(); const result = await instance.assemble(messages, [definition]);
  const { entries } = exactState(result.runtimeContext.content);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((v: any) => v.arguments.scope), ["A", "B", "A", "A"]);
  assert.equal(entries[0].result.conflict, "B disagrees"); assert.equal(entries[0].result.unknown, "earlier period");
});

test("current file hash retires consumed old reads, while a new unconsumed stale read remains explicit", async () => {
  const read = (n: number, version: string) => pair(n, { path: "code.json", queries: [{ pointer: "/validation" }] },
    { schema: "agentloop.jsonRead/v1", path: "code.json", sha256: hash(version), queries: [{ pointer: "/validation", value: { version, status: version === "r1" ? "failed" : "passed" } }] }, "computer_read_json");
  const messages = [...read(1, "r1"), ...read(2, "r2")];
  const base = deriveCurrentDecisionView({ runId: identity.runId });
  const view = { ...base, identity, workProducts: { ...base.workProducts, objects: [{ path: "code.json", presence: "present" as const,
    currentVersionId: "r2", sha256: hash("r2"), role: "unknown", checks: [] }] } };
  const instance = assembler(); instance.setCurrentDecisionView(view);
  const result = await instance.assemble(messages, [definition]);
  assert.deepEqual(instance.decisionWorkingSet?.currentEvidence?.map(entry => entry.toolCallId), ["source-2"]);
  assert.doesNotMatch(result.runtimeContext.content, /"status":"failed"/);
  assert.equal(instance.decisionWorkingSet?.historicalObservationCount, 1);
  const evidence = messages.filter(v => v.role === "tool").map(v => ({ toolCallId: v.toolCallId, toolName: v.name, result: v.content, isError: false }));
  assert.deepEqual(instance.selectAssessmentEvidence(evidence).map(v => v.toolCallId), ["source-2"]);
  assert.deepEqual(instance.selectAssessmentEvidence(evidence, ["source-1"]).map(v => v.toolCallId), ["source-1", "source-2"], "assessment concern can reopen exact old evidence");
  await instance.assemble([...messages, ...read(3, "r1")], [definition]);
  assert.ok(instance.decisionWorkingSet?.currentEvidence?.some(entry => entry.toolCallId === "source-3"), "latest read is consumed before any version retirement");
  const deleted = { ...view, workProducts: { ...view.workProducts, objects: [{ ...view.workProducts.objects[0], presence: "deleted" as const }] } };
  instance.setCurrentDecisionView(deleted); await instance.assemble(messages, [definition]);
  assert.equal(instance.decisionWorkingSet?.currentEvidence?.length, 2, "deletion does not prove the old contents irrelevant");
});

test("unknown effects, reasoning, provider requirements and incomplete batch identities keep native protocol", async () => {
  for (const mode of ["reasoning", "unknown-write", "failed-write", "provider", "no-reader", "missing-ref", "partial-batch"]) {
    const messages = pair(1, {}, { value: 42 }, mode.includes("write") ? "mutate" : "inspect");
    if (mode === "reasoning") (messages[0] as any).reasoningContent = "continuation";
    if (mode.includes("write")) (messages[1] as any).executionOutcome = { invocationStatus: "completed", operationStatus: mode === "failed-write" ? "failed" : "unknown" };
    if (mode === "missing-ref") (messages[1] as any).content = "no durable Result identity";
    if (mode === "partial-batch") {
      (messages[0] as any).toolCalls.push({ id: "second", name: "inspect", arguments: {} });
      messages.push({ ...messages[1] as any, toolCallId: "second", content: "no durable identity" });
    }
    const instance = assembler(mode === "provider" ? { ...model, completedExchangePolicy: undefined } : model);
    const assembled = await instance.assemble(messages, mode === "no-reader" ? [] : [definition]);
    assert.deepEqual(assembled.messages, messages, mode);
  }
});

test("oversized exact evidence remains native without a truncated state entry or fixed-prompt budget failure", async () => {
  const messages = pair(1, {}, { value: "exact original ".repeat(4000) });
  const instance = assembler();
  const result = await instance.assemble(messages, [definition]);
  assert.equal(instance.decisionWorkingSet?.currentEvidence?.length, 0);
  assert.equal(instance.decisionWorkingSet?.pendingToolCallIds.length, 1);
  assert.ok(result.messages.some(v => v.role === "tool"));
});

test("one oversized batch member retains the entire native batch without duplicating a sibling", async () => {
  const [first, small] = pair(1, {}, { value: 42 });
  const [second, large] = pair(2, {}, { value: "long exact value ".repeat(1500) });
  const batch = { ...first as any, toolCalls: [...(first as any).toolCalls, ...(second as any).toolCalls] };
  const instance = assembler();
  const current = await instance.assemble([batch, small, large], [definition]);
  assert.equal(instance.decisionWorkingSet?.currentEvidence?.length, 0);
  assert.equal(instance.decisionWorkingSet?.pendingToolCallIds.length, 2);
  assert.equal(current.messages.filter(v => v.role === "tool").length, 2);
});

test("committed frontier distinguishes pre-action pending prose from completed and unknown effects", async () => {
  const messages = pair(1, {}, { value: 42 });
  (messages[0] as any).content = "The inspection is pending; read it next.";
  const instance = assembler();
  const result = await instance.assemble(messages, [definition]);
  const { state, entries } = exactState(result.runtimeContext.content);
  assert.equal(state.latestCommittedAction.checkpointOrdinal, 1);
  assert.equal(state.latestCommittedAction.toolCalls[0].operationStatus, "succeeded");
  assert.equal(state.latestCommittedAction.toolCalls[0].receipt, "committed");
  assert.match(entries[0].assistantStatement, /pending/);
  const unknown = pair(2, {}, { effect: "unknown" }, "mutate");
  (unknown[1] as any).executionOutcome = { invocationStatus: "failed", operationStatus: "unknown" };
  await instance.assemble([...messages, ...unknown], [definition]);
  const frontier = instance.decisionWorkingSet!.latestCommittedAction!;
  assert.equal(frontier.toolCalls[0].operationStatus, "unknown");
  assert.equal(frontier.toolCalls[0].invocationStatus, "failed");
});

test("active semantic findings keep their exact source content; oversized dependencies stay native", async () => {
  for (const large of [false, true]) {
    const first = pair(1, { scope: "A" }, { marker: "EXACT-REVISION-B", content: "source ".repeat(large ? 3000 : 20) });
    const update = { id: "finding", category: "observation", certainty: "observed", scope: "A",
      text: "Revision B observed, marker recorded in source", evidence: ["source-1"], disposition: "carry" };
    const next = pair(2, { _agentloopContext: { updates: [update] } }, { value: 42 });
    (next[0] as any).executionHistoryBasis = { ...basis, contextEvidenceToolCallIds: ["source-1"] };
    const instance = assembler(); const result = await instance.assemble([...first, ...next], [definition]);
    const { entries } = exactState(result.runtimeContext.content);
    assert.equal(instance.decisionWorkingSet?.items.length, 1);
    if (large) {
      assert.ok(result.messages.some(v => v.role === "tool" && v.toolCallId === "source-1"));
      assert.ok(instance.decisionWorkingSet?.pendingToolCallIds.includes("source-1"));
    } else {
      assert.equal(entries.find((v: any) => v.toolCallId === "source-1").result.marker, "EXACT-REVISION-B");
      assert.equal(result.messages.length, 0);
    }
  }
});

test("100 to 160 consumed obsolete file versions stay bounded while unresolved canonical issues survive", async () => {
  const measurements: number[] = [];
  for (const count of [100, 160]) {
    const messages: ModelMessage[] = [{ role: "user", content: "Fix the code; unverified integration must stay open; never publish" }];
    for (let n = 1; n <= count; n++) messages.push(...pair(n, { path: "code.json", queries: [{ pointer: "/check" }] },
      { schema: "agentloop.jsonRead/v1", path: "code.json", sha256: hash(`r${n}`),
        queries: [{ value: { version: `r${n}`, status: "failed", detail: "historical compiler error ".repeat(40) } }] }, "computer_read_json"));
    messages.push(...pair(count + 1, { path: "code.json", queries: [{ pointer: "/check" }] },
      { schema: "agentloop.jsonRead/v1", path: "code.json", sha256: hash("current"),
        queries: [{ value: { version: "current", status: "passed", integration: "unverified" } }] }, "computer_read_json"));
    const base = deriveCurrentDecisionView({ runId: identity.runId });
    const view = { ...base, identity, workProducts: { ...base.workProducts,
      objects: [{ path: "code.json", presence: "present" as const, currentVersionId: "current", sha256: hash("current"), role: "unknown", checks: [] }],
      issues: [{ id: "integration", applicability: "current", evidenceToolCallIds: ["source-1"], text: "integration remains unverified" }] } };
    const instance = assembler(); instance.setCurrentDecisionView(view as any);
    const current = await instance.assemble(messages, [definition]);
    const { entries } = exactState(current.runtimeContext.content);
    assert.equal(entries.length, 2, "current version plus evidence pinned by the unresolved issue");
    assert.equal(entries[0].toolCallId, "source-1");
    assert.equal(entries[1].result.queries[0].value.status, "passed");
    assert.equal(entries[1].result.queries[0].value.integration, "unverified");
    assert.deepEqual(view.workProducts.issues[0].evidenceToolCallIds, ["source-1"]);
    assert.equal(instance.decisionWorkingSet?.historicalObservationCount, count - 1);
    assert.match(current.messages[0].content, /never publish/);
    measurements.push(modelInvocationComposition({ phase: "execution", systemPrompt: "fixed", tools: [definition], ...current }).totalCharacters as number);
  }
  assert.ok(measurements[1] < measurements[0] * 1.02);
  console.log(`OBSOLETE_VERSIONS_60_PERCENT ${JSON.stringify(measurements)}`);
});

test("restart including receipt-before-assistant reconstructs exact evidence and preserves HIL without replaying effects", async () => {
  const messages = [ ...pair(1, { scope: "A" }, { value: 42 }), ...pair(2, { scope: "B" }, { value: 13 }) ];
  const events: RuntimeEvent[] = [];
  for (let n = 0; n < messages.length; n += 2) {
    const a = messages[n] as any, t = messages[n + 1] as any;
    events.push({ type: "tool.completed", data: { toolName: t.name, toolCallId: t.toolCallId, result: t.content, ...t.executionOutcome } },
      { type: "assistant.committed", data: { ...a, finishReason: "tool_calls" } });
  }
  const restored = reconstructRecoveryTranscript({ stepId: "leaf", userInput: "HIL: A only, no publication", events: [
    { seq: 1, type: "plan.step.started", data: { stepId: "leaf", planId: "plan" } }, ...events.map((e, index) => ({ ...e, seq: index + 2 }))] });
  const first = await assembler().assemble(messages, [definition]);
  const recovered = assembler(model, restored.workProductEvents);
  const second = await recovered.assemble(restored.messages, [definition]);
  assert.deepEqual(exactState(second.runtimeContext.content).entries, exactState(first.runtimeContext.content).entries);
  assert.match(second.messages[0].content, /HIL: A only/);
  assert.equal(restored.facts.unfinishedToolCalls.length, 0);
  const state = deriveDecisionWorkingSet({ runId: identity.runId, messages: restored.messages,
    records: committedDecisionRecords(restored.workProductEvents ?? []), materializeObservations: true });
  assert.equal(state.items.length, 0); assert.equal(state.view.currentEvidence?.length, 2);
});

test("a real loop consumes exact empty-update evidence with no maintenance turn or repeated tool effect", async () => {
  let effects = 0, turns = 0;
  const tools = new ToolRegistry([reader, { name: "inspect", description: "Read a synthetic source", effect: "read", replaySafe: true,
    inputSchema: { type: "object" }, parse: value => value, execute: async () => { effects++; return { value: 42, unknown: "B" }; } }]);
  const events: RuntimeEvent[] = [];
  const result = await runAgentLoop({ runId: identity.runId, input: "Summarize A; do not publish", initialMessages: [
    { role: "user", content: "HIL: do not publish" }, ...pair(1, { scope: "A", _agentloopContext: { updates: [] } }, { value: 42, unknown: "B" }) ],
    tools, grant: createCapabilityGrant({ runId: identity.runId, planId: "plan", stepId: "leaf", depth: 0, allowedToolNames: ["inspect", "read_result"], allowedSkillIds: [] }),
    systemPrompt: "Use exact observations", maxSteps: 2, emit: event => { events.push(event); },
    model: { ...model, complete: async request => {
      turns++; const { entries } = exactState(request.runtimeContext!.content);
      assert.equal(entries[0].result.value, 42); assert.equal(entries[0].result.unknown, "B");
      assert.equal(request.messages.filter(v => v.role === "tool").length, 0);
      return { content: "A=42; B remains unknown.", finishReason: "stop", toolCalls: [] };
    } } });
  assert.match(result.output, /42/); assert.equal(turns, 1); assert.equal(effects, 0);
  assert.equal(events.filter(e => e.type === "tool.dispatched").length, 0);
});
