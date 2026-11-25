import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { committedDecisionRecords } from "../src/runtime/committed-decision-records.ts";
import { deriveDecisionWorkingSet } from "../src/runtime/decision-working-set.ts";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { projectDecisionEvidence } from "../src/runtime/decision-evidence-projection.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { createResultTool } from "../src/tools/result-tool.ts";
import type { ModelAdapter, RuntimeEvent } from "../src/runtime/contracts.ts";
import type { ExecutionHistoryBasis } from "../src/runtime/execution-history-projection.ts";

const runId = "committed-context";
const basis: ExecutionHistoryBasis = { identity: { runId, planId: "plan", stepId: "leaf", eventWatermark: 0,
  reducerVersion: "v1", viewId: "view", decisionBasisDigest: "basis" }, contextArgumentTools: ["inspect"], toolEffects: { inspect: "read" } };
const ref = { schema: "agentloop.resultRef/v1", resultId: "rr_11111111-1111-4111-8111-111111111111" };
const reader = createResultTool({} as never);
const definition = { name: reader.name, description: reader.description, inputSchema: reader.inputSchema };
const model: ModelAdapter = { completedExchangePolicy: "releasable", limits: { contextWindowTokens: 8_000_000, maxOutputTokens: 4096 },
  complete: async () => { throw new Error("Projection must never invoke a maintenance model"); } };
const update = (source: string, rest: Record<string, unknown> = {}) => ({ kind: "context", id: "current", category: "observation", text: "Measured 42; source revision r1; coverage outside A remains unknown.",
  scope: "A only", certainty: "observed", evidence: [source], disposition: "carry", ...rest });
const checkpoint = (id: string, updates: unknown[] = [], overrides: Partial<ExecutionHistoryBasis> = {}): RuntimeEvent => ({ type: "assistant.committed", data: {
  content: "", finishReason: "tool_calls", executionHistoryBasis: { ...basis, ...overrides },
  toolCalls: [{ id, name: "inspect", arguments: { key: "A", _agentloopContext: { updates } } }],
} });
const receipt = (id: string): RuntimeEvent => ({ type: "tool.completed", data: { toolCallId: id, toolName: "inspect", result: JSON.stringify({ value: 42, detail: "Exact old content ".repeat(100), resultRef: ref }), resultRef: ref,
  invocationStatus: "completed", operationStatus: "succeeded" } });
function restore(events: readonly RuntimeEvent[]) {
  return reconstructRecoveryTranscript({ userInput: "A only; HIL: no publication", stepId: "leaf",
    events: [{ seq: 1, type: "plan.step.started", data: { stepId: "leaf" } }, ...events.map((event, index) => ({ ...event, seq: index + 2 }))] });
}
function derive(events: readonly RuntimeEvent[]) {
  const restored = restore(events);
  return deriveDecisionWorkingSet({ runId, messages: restored.messages, records: committedDecisionRecords(restored.workProductEvents ?? []) });
}

test("a committed proposal survives prepare rejection and an unfinished action independently of native encoding", async () => {
  const events = [checkpoint("source"), receipt("source"), checkpoint("bad", [update("source")], { contextEvidenceToolCallIds: ["source"] }),
    { type: "tool.rejected", data: { toolCallId: "bad", toolName: "inspect", reason: "Missing required key", failurePhase: "prepare" } }];
  const restored = restore(events);
  assert.equal(restored.messages.some(message => message.role === "assistant" && message.toolCalls?.some(call => call.id === "bad")), false);
  const live = new ContextAssembler({ runId, systemPrompt: "Current task", runtimeContext: { phase: "execution", content: "Exact goal: A only" }, model,
    decisionEvents: () => events });
  await live.assemble(restored.messages, [definition]);
  const recovered = derive(events);
  assert.deepEqual(live.decisionWorkingSet?.items, recovered.items);
  assert.equal(recovered.items.length, 1);
  assert.deepEqual(recovered.view.pendingToolCallIds, ["bad"]);
  assert.equal(recovered.items[0].authority, "model");
  assert.equal(recovered.items[0].evidence[0].result?.resultId, ref.resultId);
  const incomplete = events.slice(0, -1);
  assert.equal(derive(incomplete).items.length, 1, "a complete semantic checkpoint does not require its proposed action to finish");
  assert.equal(restore(incomplete).facts.unfinishedToolCalls[0].toolCallId, "bad", "unfinished effect remains an independent recovery boundary");
});

test("early receipts, truncation, ambiguous identities and out-of-request evidence cannot create facts", () => {
  assert.equal(derive([receipt("own"), checkpoint("own", [update("own")], { contextEvidenceToolCallIds: [] })]).items.length, 0);
  const source = [checkpoint("source"), receipt("source")];
  assert.equal(derive([...source, checkpoint("later", [update("source")], { contextEvidenceToolCallIds: [] })]).items.length, 0);
  const truncated = checkpoint("later", [update("source")]);
  assert.equal(derive([...source, { ...truncated, data: { ...truncated.data, finishReason: "length" } }]).items.length, 0);
  assert.equal(derive([...source, receipt("source"), checkpoint("later", [update("source")])]).items.length, 0);
  assert.equal(derive([...source, checkpoint("source"), checkpoint("later", [update("source")])]).items.length, 0);
  const partial = [{ type: "assistant.tool_call.committed", data: { toolCallId: "source", name: "inspect", arguments: { _agentloopContext: { updates: [update("other")] } } } }, receipt("source")];
  assert.equal(derive(partial).items.length, 0, "half-stream proposals are never accepted");
  const rejectedOrphan = restore([partial[0], { type: "tool.rejected", data: { toolCallId: "source", toolName: "inspect", reason: "Missing key", failurePhase: "prepare" } }]);
  assert.equal(rejectedOrphan.messages.length, 1, "a rejected orphan is evidence, not an invalid native continuation");
  assert.equal(rejectedOrphan.toolEvidence[0].failurePhase, "prepare");
  assert.equal(rejectedOrphan.facts.unfinishedToolCalls.length, 0);
});

test("rejected optional metadata is diagnostic, never a new authoritative task obligation", () => {
  const events = [checkpoint("source"), receipt("source"), checkpoint("next", [update("source", { evidence: [] })]), receipt("next")];
  const result = derive(events);
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.view.rejectedUpdates?.[0].invalidFields, ["evidence"]);
  assert.equal(result.view.rejectedUpdates?.[0].taskBlocking, false);
  assert.equal(result.reconciledToolCallIds.size, 0);
  assert.ok(result.view.gaps[0].includes("require no extra turn"));
  assert.equal(result.messages.length, restore(events).messages.length, "original evidence remains available");
});

test("assessment materializes current source bodies and keeps unprocessed/unknown effects independently of Provider retention", () => {
  const events = [checkpoint("old"), receipt("old"), checkpoint("new", [update("old")]), receipt("new")];
  const first = derive(events).items[0];
  events.push(checkpoint("pending", [update("new")], { contextItemRevisions: { current: first.revision } }), receipt("pending"));
  const derived = derive(events);
  const evidence = ["old", "new", "pending", "unknown"].map(id => ({ toolCallId: id, toolName: "inspect", result: `${id}: exact complete body`, isError: false,
    operationStatus: id === "unknown" ? "unknown" as const : "succeeded" as const }));
  const selected = projectDecisionEvidence({ evidence, workingSet: { ...derived.view, history: derived.history }, reconciledToolCallIds: derived.reconciledToolCallIds, requiredToolCallIds: ["new"] });
  assert.deepEqual(selected.map(item => item.toolCallId), ["new", "pending", "unknown"]);
  assert.equal(selected[0].result, "new: exact complete body", "required content is present, not just a Result pointer or execution prune marker");
  const retained = projectDecisionEvidence({ evidence, workingSet: { ...derived.view, history: derived.history }, reconciledToolCallIds: derived.reconciledToolCallIds, requiredToolCallIds: ["old", "new"] });
  assert.equal(retained.length, 4, "explicit current-version check dependencies can retain an old receipt");
});

test("native reasoning and uncertain writes are separate from semantic evidence selection", () => {
  const first = checkpoint("source");
  const events = [{ ...first, data: { ...first.data, privateReasoningContent: "Required private continuation" } }, receipt("source"),
    checkpoint("next", [update("source")]), receipt("next")];
  const restored = restore(events), derived = derive(events);
  assert.equal(derived.archived.size, 0, "a semantic handoff does not release reasoning required by Provider");
  assert.equal((restored.messages[1] as { reasoningContent: string }).reasoningContent, "Required private continuation");
  const selected = projectDecisionEvidence({ evidence: restored.toolEvidence, workingSet: { ...derived.view, history: derived.history },
    reconciledToolCallIds: derived.reconciledToolCallIds, unsafeEffectToolCallIds: derived.unsafeEffectToolCallIds });
  assert.deepEqual(selected.map(item => item.toolCallId), ["next"], "assessment does not duplicate a safe read merely because Provider retains reasoning");
  const failedWrite = checkpoint("source", [], { toolEffects: { inspect: "write" } });
  const failedReceipt = receipt("source");
  const uncertain = derive([failedWrite, { ...failedReceipt, data: { ...failedReceipt.data, operationStatus: "failed" } }, checkpoint("next", [update("source", { category: "unknown", certainty: "unknown", text: "Failed write may have partial effects; reconciliation required." })]), receipt("next")]);
  assert.ok(uncertain.reconciledToolCallIds.has("source"));
  assert.ok(uncertain.unsafeEffectToolCallIds.has("source"), "model handoff cannot erase a failed write effect boundary");
  assert.equal(projectDecisionEvidence({ evidence: restored.toolEvidence, workingSet: { ...uncertain.view, history: uncertain.history },
    reconciledToolCallIds: uncertain.reconciledToolCallIds, unsafeEffectToolCallIds: uncertain.unsafeEffectToolCallIds }).length, 2);
});

test("normal execution and restart preserve prepare-rejected semantics with no maintenance model turn or repeated effect", async () => {
  const events: RuntimeEvent[] = [];
  let calls = 0, effects = 0;
  const tools = new ToolRegistry([{ name: "inspect", description: "Read A", effect: "read", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    parse: value => { if (!(value as { key?: string }).key) throw new Error("Missing key"); return value; },
    execute: async () => { effects++; return { value: 42, resultRef: ref }; } }, reader]);
  const grant = createCapabilityGrant({ runId, planId: "plan", stepId: "leaf", depth: 0, allowedToolNames: ["inspect", "read_result"], allowedSkillIds: [] });
  const adapter: ModelAdapter = { ...model, complete: async request => {
    calls++;
    if (calls === 1) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "source", name: "inspect", arguments: { key: "A" } }] };
    if (calls === 2) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "bad", name: "inspect", arguments: { _agentloopContext: { updates: [update("source")] } } }] };
    assert.ok(request.runtimeContext!.content.includes("Measured 42"));
    assert.equal(request.messages.some(message => message.role === "assistant" && message.toolCalls?.some(call => call.id === "bad")), false);
    return { content: "42 within A; other coverage unknown", finishReason: "stop", toolCalls: [] };
  } };
  await runAgentLoop({ runId, systemPrompt: "A only", input: "Inspect A", grant, tools, model: adapter, maxSteps: 4, emit: event => { events.push(event); } });
  assert.equal(calls, 3); assert.equal(effects, 1);
  const restored = restore(events);
  const recovered = derive(events);
  assert.equal(recovered.items.length, 1);
  await runAgentLoop({ runId, systemPrompt: "A only", input: "Inspect A", grant, tools, model: adapter, maxSteps: 1,
    initialMessages: restored.messages, initialToolEvidence: restored.toolEvidence, initialWorkProductEvents: restored.workProductEvents });
  assert.equal(calls, 4, "restart needs only its business decision, not a state repair round");
  assert.equal(effects, 1);
});

test("100 to 160 resolved steps keep event-derived execution and assessment input bounded", async () => {
  const measurements = [];
  for (const steps of [100, 160]) {
    const events: RuntimeEvent[] = [checkpoint("source0"), receipt("source0")];
    let previous: string | undefined;
    for (let n = 1; n <= steps; n++) {
      const value = update(`source${n - 1}`);
      events.push(checkpoint(`source${n}`, [value], { contextItemRevisions: previous ? { current: previous } : {} }), receipt(`source${n}`));
      const normalized = { ...value, kind: "context" };
      previous = createHash("sha256").update(JSON.stringify([[`source${n}`], 0, normalized])).digest("hex").slice(0, 24);
    }
    const restored = restore(events);
    const assembler = new ContextAssembler({ runId, systemPrompt: "A only", runtimeContext: { phase: "execution", content: "Exact user authority: A only; no publication" }, model, decisionEvents: () => events });
    const started = performance.now();
    const result = await assembler.assemble(restored.messages, [definition]);
    const derived = derive(events);
    assert.equal(derived.rejections.length, 0);
    assert.deepEqual(assembler.decisionWorkingSet?.items, derived.items);
    assert.equal(assembler.decisionWorkingSet?.items.length, 1);
    const selected = assembler.selectAssessmentEvidence(restored.toolEvidence);
    assert.equal(selected.length, 1, "explicitly carried source + only the next unprocessed observation body, independent of history size");
    measurements.push({ steps, executionCharacters: JSON.stringify(result).length, assessmentCharacters: JSON.stringify(selected).length, assemblyAndReplayMs: performance.now() - started });
  }
  assert.ok(measurements[1].executionCharacters < measurements[0].executionCharacters * 1.02);
  assert.ok(measurements[1].assessmentCharacters < measurements[0].assessmentCharacters * 1.02);
  console.log(`COMMITTED_BASIS_60_PERCENT ${JSON.stringify(measurements)}`);
});
