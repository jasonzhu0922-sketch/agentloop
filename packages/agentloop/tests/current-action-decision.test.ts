import assert from "node:assert/strict";
import test from "node:test";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import { deriveDecisionWorkingSet } from "../src/runtime/decision-working-set.ts";
import { committedDecisionRecords } from "../src/runtime/committed-decision-records.ts";
import { decisionContextToolDefinitions, decisionContextEvidenceReferences, toolCallWithoutDecisionContext } from "../src/runtime/decision-context-transport.ts";
import { deriveCurrentDecisionView } from "../src/runtime/current-decision-view.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { projectDecisionEvidence } from "../src/runtime/decision-evidence-projection.ts";
import { createResultTool } from "../src/tools/result-tool.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { modelInvocationComposition } from "../src/runtime/model-streaming.ts";
import type { ModelAdapter, ModelMessage, RuntimeEvent } from "../src/runtime/contracts.ts";
import type { ExecutionHistoryBasis } from "../src/runtime/execution-history-projection.ts";

const identity = { runId: "action-decision", planId: "plan", stepId: "leaf", eventWatermark: 1,
  reducerVersion: "v1" as const, viewId: "view", decisionBasisDigest: "basis" };
const basis: ExecutionHistoryBasis = { identity, contextDecisionRequired: true, contextArgumentTools: ["inspect", "mutate"],
  toolEffects: { inspect: "read", mutate: "write" } };
const ref = (n: number) => ({ schema: "agentloop.resultRef/v1" as const, resultId: `rr_${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` });
const decision = (evidence: string[] = [], changes = {}) => ({ target: "subject-A", progress: "No observation yet; existing authority remains exact",
  remaining: "Read the required source content; scope B remains unknown", purpose: "Read the selected content", evidence, disposition: "retain", ...changes });
function pair(n: number, frame = decision(), result: unknown = { value: 42, scope: "A" }, options: {
  basis?: ExecutionHistoryBasis; tool?: string; args?: Record<string, unknown>; updates?: unknown[]; outcome?: "succeeded" | "failed" | "unknown";
  reasoning?: string;
} = {}): ModelMessage[] {
  return [{ role: "assistant", content: "", ...(options.reasoning ? { reasoningContent: options.reasoning } : {}),
    executionHistoryBasis: options.basis ?? basis, toolCalls: [{ id: `source${n}`, name: options.tool ?? "inspect",
      arguments: { selection: "A", ...options.args, _agentloopContext: { decision: frame, ...(options.updates ? { updates: options.updates } : {}) } } }] },
    { role: "tool", name: options.tool ?? "inspect", toolCallId: `source${n}`, content: JSON.stringify({ ...result as object, resultRef: ref(n) }), resultRef: ref(n),
      isError: options.outcome === "failed", executionOutcome: { invocationStatus: "completed", operationStatus: options.outcome ?? "succeeded" } }];
}
const derive = (messages: ModelMessage[]) => deriveDecisionWorkingSet({ runId: identity.runId, messages, materializeObservations: true });
const reader = createResultTool({} as never);
const definition = { name: reader.name, description: reader.description, inputSchema: reader.inputSchema };
const model: ModelAdapter = { completedExchangePolicy: "releasable", limits: { contextWindowTokens: 128000, maxOutputTokens: 4096 },
  complete: async () => { throw Error("No maintenance model call permitted"); } };
const assembler = () => new ContextAssembler({ runId: identity.runId, model, systemPrompt: "Preserve evidence and authority",
  runtimeContext: { phase: "execution", content: "Exact HIL: A only, do not publish, never repeat an unknown effect" } });

test("normal action schema carries current progress from the first decision; semantic changes remain optional", () => {
  const tools = [{ name: "inspect", description: "Read", inputSchema: { type: "object", required: ["selection"], properties: { selection: { type: "string" } } } }];
  const offered = decisionContextToolDefinitions(tools, false);
  const schema = offered.definitions[0].inputSchema as any;
  assert.deepEqual(schema.required, ["selection", "_agentloopContext"]);
  assert.equal(schema.properties._agentloopContext.properties.updates, undefined);
  const call = (pair(1)[0] as any).toolCalls[0];
  assert.deepEqual(toolCallWithoutDecisionContext(call, offered.names).arguments, { selection: "A" });
  assert.ok(call.arguments._agentloopContext.decision, "native arguments remain unchanged for Provider continuation");
  assert.equal(derive(pair(1)).rejections.length, 0, "omitting optional updates is valid");
});

for (const [domain, progress, remaining] of [
  ["code", "Revision r2 passes its bound unit check; r1 diagnostic is historical", "Integration on r2 has no evidence"],
  ["research", "Source A supports C; source B disagrees on date", "Earlier-period coverage remains unknown"],
  ["analysis", "For A in H1, 10+32=42; source revision r2", "No evidence for B or other periods"],
  ["artifact", "Draft r2 replaces r1; experiment deleted", "Final delivery and r2 acceptance remain unverified"],
]) test(`${domain}: progress and next action are joined to committed outcome, not promoted to authority`, async () => {
  const messages = [...pair(1), ...pair(2, decision(["@e1"], { target: domain, progress, remaining, purpose: "Inspect the missing evidence" }), { content: "exact source ".repeat(200) },
    { basis: { ...basis, contextEvidenceToolCallIds: ["source1"], contextEvidenceBindings: { "@e1": "source1" } } })];
  const before = structuredClone(messages), instance = assembler();
  const assembled = await instance.assemble(messages, [definition]);
  const frame = instance.decisionWorkingSet!.currentDecision!;
  assert.equal(frame.authority, "model"); assert.equal(frame.progress, progress); assert.equal(frame.remaining, remaining);
  assert.equal(frame.evidence[0].result?.resultId, ref(1).resultId);
  assert.equal(frame.source.result?.resultId, ref(2).resultId);
  assert.equal(frame.outcome.operationStatus, "succeeded");
  assert.equal(instance.decisionWorkingSet!.items.length, 0, "a progress statement does not create a verified fact");
  assert.equal(instance.decisionWorkingSet!.currentEvidence!.length, 2);
  assert.match(assembled.runtimeContext.content, /Exact HIL: A only/);
  assert.deepEqual(messages, before);
});

test("request-bound references include decision dependencies even without semantic updates", () => {
  const call = (pair(2, decision(["@e1"]))[0] as any).toolCalls[0];
  assert.deepEqual(decisionContextEvidenceReferences([call], ["inspect"], { "@e1": "source1" }), ["source1"]);
});

test("parallel actions preserve both purposes, dependencies and distinct outcomes; an invalid sibling cannot retire detail", () => {
  const first = pair(1), second = pair(2);
  const [a, resultA] = pair(3, decision(["source1"], { target: "A", progress: "A source acquired", disposition: "carry" }));
  const [b, resultB] = pair(4, decision(["source2"], { target: "B", progress: "B source acquired", disposition: "carry" }), {}, { outcome: "failed" });
  const batch = { ...a as any, toolCalls: [...(a as any).toolCalls, ...(b as any).toolCalls] };
  const state = derive([...first, ...second, batch, resultA, resultB]);
  assert.equal(state.view.parallelDecisions![0].target, "A");
  assert.equal(state.view.parallelDecisions![0].outcome.operationStatus, "succeeded");
  assert.equal(state.view.currentDecision!.target, "B");
  assert.equal(state.view.currentDecision!.outcome.operationStatus, "failed");
  assert.deepEqual(state.view.currentEvidence!.map(entry => entry.toolCallId), ["source1", "source2", "source3", "source4"]);
  const invalid = structuredClone(batch);
  delete invalid.toolCalls[1].arguments._agentloopContext.decision.purpose;
  const rejected = derive([...first, ...second, invalid, resultA, resultB]);
  assert.equal(rejected.reconciledToolCallIds.has("source1"), false);
  assert.equal(rejected.reconciledToolCallIds.has("source2"), false);
});

for (const invalid of ["foreign-step", "foreign-run", "future", "not-presented", "missing-purpose", "missing-disposition", "oversized", "ambiguous"]) {
  test(`invalid ${invalid} decision cannot release evidence or replace the preceding decision`, () => {
    const messages = pair(1);
    const frame: any = decision(["source1"], { disposition: "carry" });
    const requestBasis = structuredClone(basis);
    if (invalid === "foreign-step" || invalid === "foreign-run") (messages[0] as any).executionHistoryBasis = { ...basis,
      identity: { ...identity, ...(invalid === "foreign-step" ? { stepId: "other" } : { runId: "other" }) } };
    if (invalid === "future") frame.evidence = ["source2"];
    if (invalid === "not-presented") (requestBasis as any).contextEvidenceToolCallIds = [];
    if (invalid === "missing-purpose") delete frame.purpose;
    if (invalid === "missing-disposition") delete frame.disposition;
    if (invalid === "oversized") frame.progress = "x".repeat(1601);
    if (invalid === "ambiguous") messages.push(...pair(1));
    const current = derive([...messages, ...pair(2, frame, {}, { basis: requestBasis })]);
    assert.ok(current.rejections.some(entry => entry.reason === "invalid_action_decision"));
    assert.ok(!current.reconciledToolCallIds.has("source1"));
    assert.notEqual(current.view.currentDecision?.source.toolCallId, "source2");
  });
}

test("repeated successful writes are locatable but remain separate effects and require no repair-only turn", () => {
  const messages = [...pair(1, decision(), { written: true }, { tool: "mutate" }),
    ...pair(2, decision(["source1"], { progress: "The file was created", remaining: "Its content must be read", purpose: "Repeat with an explicit changed reason" }), { written: true }, { tool: "mutate" })];
  const result = derive(messages);
  assert.equal(result.view.currentDecision!.priorMatchingSuccess!.count, 1);
  assert.equal(result.view.currentDecision!.priorMatchingSuccess!.toolCallId, "source1");
  assert.equal(result.view.currentEvidence!.length, 2, "matching writes are never coalesced");
  assert.equal(result.view.currentDecision!.outcome.operationStatus, "succeeded");
  assert.equal(result.rejections.length, 0);
  const changed = [...messages, ...pair(3, decision(["source2"]), {}, { tool: "mutate", basis: { ...basis,
    workProductVersions: [{ path: "report", versionId: "r2", evidenceToolCallIds: ["source2"] }] } })];
  assert.equal(derive(changed).view.currentDecision!.priorMatchingSuccess, undefined, "same arguments after a version change do not establish reusable success");
});

test("partial and unknown effects retain honest progress and native continuation across restart and HIL", async () => {
  for (const mode of ["unknown", "pending", "reasoning", "cancelled"]) {
    const messages = [...pair(1), ...pair(2, decision(["source1"], { progress: "Preparation observed", remaining: "The effect still needs evidence" }), {},
      { tool: "mutate", ...(mode === "unknown" ? { outcome: "unknown" } : {}), ...(mode === "reasoning" ? { reasoning: "native continuation" } : {}) })];
    if (mode === "pending" || mode === "cancelled") messages.pop();
    const events: RuntimeEvent[] = [];
    for (const message of messages) {
      if (message.role === "assistant") events.push({ type: "assistant.committed", data: { ...message, finishReason: "tool_calls" } });
      if (message.role === "tool") events.push({ type: "tool.completed", data: { toolName: message.name, toolCallId: message.toolCallId,
        result: message.content, resultRef: message.resultRef, ...message.executionOutcome } });
    }
    if (mode === "cancelled") events.push({ type: "run.cancelled", data: {} });
    const original = derive(messages);
    const restored = reconstructRecoveryTranscript({ userInput: "HIL: A only; never retry the effect", stepId: "leaf", events: [
      { seq: 1, type: "plan.step.started", data: { planId: "plan", stepId: "leaf" } }, ...events.map((event, index) => ({ ...event, seq: index + 2 }))] });
    const after = deriveDecisionWorkingSet({ runId: identity.runId, messages: restored.messages, records: committedDecisionRecords(restored.workProductEvents ?? []), materializeObservations: true });
    assert.deepEqual(after.view.currentDecision, original.view.currentDecision, mode);
    assert.ok(!after.archived.has("source2"), mode);
    assert.equal(after.view.currentDecision!.outcome.operationStatus, mode === "reasoning" ? "succeeded" : "unknown");
    assert.match(restored.messages[0].content, /HIL: A only/);
  }
});

test("execution and assessment retain current decision dependencies even when their detail was carried", () => {
  const messages = [...pair(1), ...pair(2, decision(["source1"], { disposition: "carry", progress: "A=42", remaining: "B unknown" })),
    ...pair(3, decision(["source2"], { disposition: "carry", progress: "A=42", remaining: "B unknown" }))];
  const state = derive(messages);
  const evidence = messages.filter(message => message.role === "tool").map(message => ({ toolCallId: message.toolCallId, toolName: message.name,
    result: message.content, resultRef: message.resultRef, isError: false, ...message.executionOutcome }));
  const selected = projectDecisionEvidence({ evidence, workingSet: { ...state.view, history: state.history }, reconciledToolCallIds: state.reconciledToolCallIds });
  assert.deepEqual(selected.map(entry => entry.toolCallId), ["source2", "source3"]);
  assert.deepEqual(state.view.currentEvidence!.map(entry => entry.toolCallId), ["source2", "source3"]);
  assert.equal(state.view.currentDecision!.remaining, "B unknown");
});

test("100 to 160 solved observations keep the same progress, exact current sources, unresolved conflict and authority", async () => {
  const measurements: { steps: number; baselineCharacters: number; currentCharacters: number }[] = [];
  for (const steps of [100, 160]) {
    const messages: ModelMessage[] = [{ role: "user", content: "Only A; B unknown; no publication authorized" }, ...pair(1)];
    const conflict = { id: "date-conflict", category: "conflict", text: "A and B disagree on date; unresolved", certainty: "tentative", scope: "A vs B",
      evidence: ["source1"], disposition: "retain" };
    for (let n = 2; n <= steps; n++) messages.push(...pair(n, decision([`source${n - 1}`], { disposition: "carry", progress: "Current result A=42 with source scope",
      remaining: "B coverage and source date conflict remain unresolved", purpose: "Inspect the needed current revision" }),
      { value: 42, detail: "old completed attempt ".repeat(25), revision: n }, { ...(n === 2 ? { updates: [conflict] } : {}) }));
    const instance = assembler();
    const current = await instance.assemble(messages, [definition]);
    const canonical = new ContextAssembler({ runId: identity.runId, model: { ...model, limits: { ...model.limits, contextWindowTokens: 2_000_000 } },
      systemPrompt: "Preserve evidence and authority", runtimeContext: { phase: "execution", content: "Exact HIL: A only, do not publish, never repeat an unknown effect" },
      policy: { executionHistoryProjection: "canonical" } });
    const baseline = await canonical.assemble(messages, [definition]);
    const measure = (v: typeof current) => modelInvocationComposition({ phase: "execution", systemPrompt: "fixed", tools: [definition], ...v }).totalCharacters as number;
    measurements.push({ steps, baselineCharacters: measure(baseline), currentCharacters: measure(current) });
    assert.deepEqual(instance.decisionWorkingSet!.currentEvidence!.map(entry => entry.toolCallId), ["source1", `source${steps - 1}`, `source${steps}`]);
    assert.equal(instance.decisionWorkingSet!.items[0].category, "conflict");
    assert.equal(instance.decisionWorkingSet!.items[0].status, "active");
    assert.equal(instance.decisionWorkingSet!.currentDecision!.authority, "model");
    assert.match(current.messages[0].content, /no publication authorized/);
    assert.equal(current.contextEpoch, 0);
  }
  assert.ok(measurements[1].baselineCharacters > measurements[0].baselineCharacters * 1.5);
  assert.ok(measurements[1].currentCharacters < measurements[0].currentCharacters * 1.03);
  console.log(`ACTION_DECISION_60_PERCENT ${JSON.stringify(measurements)}`);
});

test("an ordinary model turn consumes committed progress and returns the answer without a state-maintenance call or repeated effect", async () => {
  let turns = 0, effects = 0;
  const initial = [...pair(1), ...pair(2, decision(["source1"], { progress: "A=42 has been read", remaining: "No further acquisition; B unknown", purpose: "Read exact source before answering", disposition: "carry" }))];
  const tools = new ToolRegistry([reader, { name: "inspect", description: "Read", effect: "read", replaySafe: true, inputSchema: { type: "object" },
    parse: value => value, execute: async () => { effects++; return { value: 42 }; } }]);
  const events: RuntimeEvent[] = [];
  const result = await runAgentLoop({ runId: identity.runId, input: "Answer A; do not publish", initialMessages: initial,
    tools, grant: createCapabilityGrant({ runId: identity.runId, planId: "plan", stepId: "leaf", depth: 0, allowedToolNames: ["inspect", "read_result"], allowedSkillIds: [] }),
    systemPrompt: "Use current progress and exact results", maxSteps: 2, emit: event => { events.push(event); },
    model: { ...model, complete: async request => {
      turns++; assert.match(request.runtimeContext!.content, /A=42 has been read/);
      assert.ok((request.tools[0].inputSchema as any).required.includes("_agentloopContext"));
      return { content: "A=42; B remains unknown; no publication.", finishReason: "stop", toolCalls: [] };
    } } });
  assert.match(result.output, /A=42/); assert.equal(turns, 1); assert.equal(effects, 0);
  assert.equal(events.filter(event => event.type === "tool.dispatched").length, 0);
});

test("a completed action never closes a canonical assessment gap or changes a user amendment", () => {
  const base = deriveCurrentDecisionView({ runId: identity.runId });
  const current = { ...base, identity, currentGap: { ...base.currentGap, assessmentGaps: [{ id: "delivery-gap", status: "open" }] } } as any;
  const before = structuredClone(current);
  const state = deriveDecisionWorkingSet({ runId: identity.runId, currentView: current, messages: pair(1, decision([], { progress: "The model claims everything is done", remaining: "None claimed" })) });
  assert.equal(state.view.currentDecision!.authority, "model");
  assert.deepEqual(current, before); assert.equal(current.currentGap.assessmentGaps[0].status, "open");
});
