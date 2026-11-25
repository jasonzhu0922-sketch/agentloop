import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deriveDecisionWorkingSet } from "../src/runtime/decision-working-set.ts";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import { deriveCurrentDecisionView, projectCurrentDecisionView } from "../src/runtime/current-decision-view.ts";
import { modelInvocationComposition } from "../src/runtime/model-streaming.ts";
import { unreadRuntimeResultRefs } from "../src/runtime/runtime-result.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { createResultTool } from "../src/tools/result-tool.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { approvingTestAssessor, singleStepTestPlanner } from "./runtime-test-helpers.ts";
import { decisionContextToolDefinitions, toolCallWithoutDecisionContext } from "../src/runtime/decision-context-transport.ts";
import { ModelRecoveryPlanner } from "../src/runtime/recovery-planning.ts";
import { createCanonicalRunState } from "../src/runtime/canonical-run-state.ts";
import { understandTask } from "../src/runtime/task-intent.ts";
import type { ExecutionHistoryBasis } from "../src/runtime/execution-history-projection.ts";
import type { ModelAdapter, ModelMessage, RuntimeEvent } from "../src/runtime/contracts.ts";

const ref = (n = 1) => ({ schema: "agentloop.resultRef/v1" as const, resultId: `rr_${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` });
const identity = { runId: "working-set", stepId: "leaf", planId: "plan", planVersion: 1, eventWatermark: 1,
  reducerVersion: "v1" as const, viewId: "view", decisionBasisDigest: "basis" };
const basis: ExecutionHistoryBasis = { identity, contextArgumentTools: ["inspect"], toolEffects: { inspect: "read", mutate: "write", read_result: "read" } };
const reader = createResultTool({} as never);
const definition = { name: reader.name, description: reader.description, inputSchema: reader.inputSchema };
const model: ModelAdapter = { completedExchangePolicy: "releasable", limits: { contextWindowTokens: 8_000_000, maxOutputTokens: 4096 },
  complete: async () => { throw new Error("No summarization model call is allowed in this replay"); } };
function pair(id: string, updates: unknown[] | "" = "", result: unknown = { value: 42 }, extras: Partial<Extract<ModelMessage, { role: "assistant" }>> = {}): ModelMessage[] {
  return [{ role: "assistant", content: "", executionHistoryBasis: basis, toolCalls: [{ id, name: "inspect", arguments: { id, ...(updates ? { _agentloopContext: { updates } } : {}) } }], ...extras },
    { role: "tool", name: "inspect", toolCallId: id, isError: false, content: JSON.stringify({ ...result as object, resultRef: ref(Number(id.replace(/\D/g, "")) || 1) }),
      executionOutcome: { invocationStatus: "completed", operationStatus: "succeeded" } }];
}
function item(id: string, evidence: string, rest: Record<string, unknown> = {}) {
  return { kind: "context", id, category: "observation", text: "42 confirmed by the source within the requested scope", scope: "subject A; revision 1; date 2026-01-01", certainty: "observed",
    evidence: [evidence], disposition: "carry", ...rest };
}
const declaration = (...updates: unknown[]) => updates;
function assembler(policy: "current" | "canonical" = "current", adapter: ModelAdapter = model) {
  return new ContextAssembler({ runId: identity.runId, systemPrompt: "Respect user authority and sources.", runtimeContext: { phase: "execution", content: "Current goal and exact HIL: inspect only subject A; no publication." }, model: adapter,
    policy: { executionHistoryProjection: policy } });
}
const calls = (messages: readonly ModelMessage[]) => messages.flatMap(message => message.role === "assistant" ? message.toolCalls?.map(call => call.id) ?? [] : []);
// A completed exchange can now be transported as exact current evidence.
const visibleCalls = (invocation: { messages: readonly ModelMessage[]; runtimeContext?: { content: string } }) => {
  const state = JSON.parse(invocation.runtimeContext?.content.match(/<decision_working_set[^>]*>([\s\S]*?)<\/decision_working_set>/)?.[1] ?? "{}");
  return [...calls(invocation.messages), ...(state.currentEvidence?.evidence?.toolCalls ?? []).map((entry: any) => entry.toolCallId)];
};

test("normal committed turns reconcile generic research facts, conflicts, unknowns and promises without changing user authority", async () => {
  const input: ModelMessage[] = [{ role: "user", content: "Only subject A. Do not publish. Correction: use revised period." }, ...pair("source1"),
    ...pair("source2", declaration(item("fact", "source1"), item("conflict", "source1", { category: "conflict", text: "The primary source and independent source disagree; keep both interpretations.", certainty: "tentative" }),
      item("unknown", "source1", { category: "unknown", certainty: "unknown", text: "Coverage before 2026 remains unknown." }),
      item("promise", "source1", { category: "commitment", certainty: "tentative", text: "Compare the independent source before delivering." })))];
  const original = structuredClone(input);
  const instance = assembler();
  const assembly = await instance.assemble(input, [definition]);
  assert.deepEqual(visibleCalls(assembly), ["source1", "source2"]);
  assert.equal(assembly.messages[0].content, input[0].content);
  assert.equal(instance.decisionWorkingSet?.items.length, 4);
  assert.ok(instance.decisionWorkingSet!.items.every(value => value.authority === "model" && value.evidence[0].result?.resultId === ref().resultId));
  assert.equal(instance.decisionWorkingSet?.history?.anchor.resultId, ref().resultId);
  assert.deepEqual(input, original);
  assert.deepEqual(await instance.assemble(input, [definition]), assembly, "idempotent reconstruction");
  assert.deepEqual((await assembler().assemble(input, [definition])).messages, assembly.messages, "fresh process derives the same input");
});

for (const invalid of ["future", "unknown-ref", "wrong-step", "wrong-revision", "absorption-with-uncommitted-evidence", "unproven-resolution"] as const) {
  test(`rejects ${invalid} handoffs and retains the exact source`, async () => {
    const update = item("fact", "source1");
    const source = pair("source1");
    if (invalid === "future") update.evidence = ["source2"];
    if (invalid === "unknown-ref") update.evidence = ["nonexistent"];
    if (invalid === "wrong-revision") Object.assign(update, { replaces: "invented" });
    if (invalid === "wrong-step") source[0] = { ...source[0] as Extract<ModelMessage, { role: "assistant" }>, executionHistoryBasis: { ...basis, identity: { ...identity, stepId: "other" } } };
    if (invalid === "absorption-with-uncommitted-evidence") { update.evidence = ["source2"]; }
    if (invalid === "unproven-resolution") { Object.assign(update, { status: "resolved" }); source[1] = { ...source[1] as Extract<ModelMessage, { role: "tool" }>, isError: true, executionOutcome: { invocationStatus: "completed", operationStatus: "failed" } }; }
    const input = [...source, ...pair("source2", declaration(update))];
    const instance = assembler();
    const result = await instance.assemble(input, [definition]);
    assert.deepEqual(visibleCalls(result), ["source1", "source2"]);
    assert.equal(instance.decisionWorkingSet?.rejectionCount, 1);
    assert.ok(instance.decisionWorkingSet?.gaps.length);
  });
}

test("unknown effects, native reasoning, partial batches, Skills and unknown adapters cannot be released", async () => {
  for (const kind of ["unknown-effect", "reasoning", "skill", "missing-outcome", "no-reader", "opaque-provider"]) {
    const source = pair("source1");
    if (kind === "reasoning") source[0] = { ...source[0] as Extract<ModelMessage, { role: "assistant" }>, reasoningContent: "private continuation" };
    if (kind === "unknown-effect") source[1] = { ...source[1] as Extract<ModelMessage, { role: "tool" }>, executionOutcome: { invocationStatus: "failed", operationStatus: "unknown" } };
    if (kind === "missing-outcome") source[1] = { ...source[1] as Extract<ModelMessage, { role: "tool" }>, executionOutcome: undefined };
    if (kind === "skill") {
      source[0] = { ...source[0] as Extract<ModelMessage, { role: "assistant" }>, toolCalls: [{ id: "source1", name: "load_skill", arguments: {} }] };
      source[1] = { ...source[1] as Extract<ModelMessage, { role: "tool" }>, name: "load_skill" };
    }
    const instance = assembler("current", kind === "opaque-provider" ? { ...model, completedExchangePolicy: undefined } : model);
    assert.deepEqual(visibleCalls(await instance.assemble([...source, ...pair("source2", declaration(item("fact", "source1")))], kind === "no-reader" ? [] : [definition])), ["source1", "source2"], kind);
  }
  await assert.rejects(() => assembler().assemble(pair("missing").slice(0, 1), [definition]), /without results/);
});

test("resolved model items require new evidence; unresolved conflicts and promises cannot silently change kind", () => {
  let input = [...pair("source1"), ...pair("source2", declaration(item("conflict", "source1", { category: "conflict", certainty: "tentative", text: "Contradictory sources." })))];
  const previous = deriveDecisionWorkingSet({ runId: identity.runId, messages: input }).items[0];
  input.push(...pair("source3", declaration(item("conflict", "source2")), {}, { executionHistoryBasis: { ...basis, contextItemRevisions: { conflict: previous.revision } } }));
  const rejected = deriveDecisionWorkingSet({ runId: identity.runId, messages: input });
  assert.equal(rejected.rejections.length, 1);
  assert.equal(rejected.items[0].category, "conflict");
  input.push(...pair("source4", declaration(item("finding", "source3", { resolves: ["conflict"], text: "The new primary source reconciles the observed contradiction." })), {}, { executionHistoryBasis: { ...basis, contextItemRevisions: { conflict: previous.revision } } }));
  assert.deepEqual(deriveDecisionWorkingSet({ runId: identity.runId, messages: input }).items.map(item => item.id), ["finding"]);
});

test("versioned code diagnostics retire on replacement/deletion and new validation binds to its observed version", () => {
  const versionBasis = (versionId: string) => ({ ...basis, workProductVersions: [{ path: "app.ts", versionId, evidenceToolCallIds: [versionId === "v1" ? "source1" : "source2"] }] });
  const input = [...pair("source1"), ...pair("source2", declaration(item("code-issue", "source1", { category: "unknown", certainty: "unknown", text: "Old implementation throws.", version: { path: "app.ts", versionId: "v1" } })), {}, { executionHistoryBasis: versionBasis("v1") }),
    ...pair("source3", declaration(item("verified", "source2", { text: "New implementation passes the requested scenario.", version: { path: "app.ts", versionId: "v2" } })), {}, { executionHistoryBasis: versionBasis("v2") })];
  const view = deriveCurrentDecisionView({ runId: identity.runId });
  const current = { ...view, identity, workProducts: { ...view.workProducts, objects: [{ path: "app.ts", presence: "present" as const, currentVersionId: "v2", role: "candidate", checks: [{ id: "test", status: "passed", binding: "current" as const }] }] } };
  const derived = deriveDecisionWorkingSet({ runId: identity.runId, messages: input, currentView: current });
  assert.deepEqual(derived.items.map(item => item.id), ["verified"], JSON.stringify(derived.rejections));
  assert.equal(derived.rejections.length, 0, "old declaration is validated against its original checkpoint, not current v2");
  const deleted = { ...current, workProducts: { ...current.workProducts, objects: [{ ...current.workProducts.objects[0], presence: "deleted" as const }] } };
  assert.equal(deriveDecisionWorkingSet({ runId: identity.runId, messages: input, currentView: deleted }).items.length, 0);
  assert.equal(projectCurrentDecisionView(deleted).workProducts.deletedObjects[0].path, "app.ts");
});

function longTranscript(steps: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: "Current task: preserve the measured 42, unresolved coverage and exact user constraint." }, ...pair("source0", "", { value: 42, detail: "historical solved detail ".repeat(30) })];
  let previous: string | undefined;
  for (let n = 1; n <= steps; n++) {
    const update = item("current-fact", `source${n - 1}`, { text: "Current measured value is 42; required source revision r1; old attempts are resolved." });
    messages.push(...pair(`source${n}`, declaration(update), { value: 42, detail: "historical solved detail ".repeat(30) }, { executionHistoryBasis: { ...basis, contextItemRevisions: previous ? { "current-fact": previous } : {} } }));
    previous = createHash("sha256").update(JSON.stringify([[`source${n}`], 0, update])).digest("hex").slice(0, 24);
  }
  return messages;
}

test("fixed-task A/B replay: completed history grows 100x while the effective model working set stays bounded", async () => {
  const measurements = [];
  for (const steps of [10, 100, 1000]) {
    const input = longTranscript(steps);
    const current = await assembler().assemble(input, [definition]);
    const baseline = await assembler("canonical").assemble(input, [definition]);
    const measure = (assembly: typeof current) => modelInvocationComposition({ runId: identity.runId, systemPrompt: "Respect user authority and sources.", phase: "execution", runtimeContext: assembly.runtimeContext, messages: assembly.messages, tools: [definition] });
    measurements.push({ steps, baseline: measure(baseline).totalCharacters as number, current: measure(current).totalCharacters as number });
    assert.equal(visibleCalls(current).length, 2);
    assert.ok(current.runtimeContext.content.includes("Current measured value is 42"));
    assert.equal((current.runtimeContext.content.match(/historical solved detail/g) ?? []).length, 30, "current source and latest observation share one identical detail body; inactive history leaves input");
    assert.equal(current.messages[0].content, input[0].content);
    assert.equal(current.contextEpoch, 0, "ordinary state projection runs before capacity-triggered summaries");
  }
  assert.ok(measurements[2].baseline > measurements[0].baseline * 60);
  assert.ok(measurements[2].current < measurements[0].current * 1.1);
  console.log(`WORKING_SET_REPLAY ${JSON.stringify(measurements)}`);
});

for (const [domain, text] of [
  ["research", "Source A confirms claim C in revision 2; source B disagrees about date; earlier coverage remains unknown."],
  ["analysis", "Read window: requested population and period only; sum of 10 and 32 is 42; no evidence about excluded periods."],
  ["document", "Draft revision 2 supersedes revision 1; deleted experiment is not the final deliverable; acceptance remains pending."],
]) test(`${domain} preserves necessary content and scope while exact history stays discoverable`, async () => {
  const input = [...pair("source1", "", { exact: text }), ...pair("source2", declaration(item(domain, "source1", { text })))];
  const instance = assembler();
  const result = await instance.assemble(input, [definition]);
  assert.ok(result.runtimeContext.content.includes(text));
  assert.equal(instance.decisionWorkingSet?.items[0].scope, "subject A; revision 1; date 2026-01-01");
  assert.deepEqual(visibleCalls(result), ["source1", "source2"]);
});

test("history index is navigation, never evidence that a bound original Result was consumed", () => {
  const binding = [{ schema: "agentloop.resultBinding/v1" as const, result: ref(), relation: "dependency" as const }];
  const evidence = { toolName: "read_result", toolCallId: "read", isError: false, result: JSON.stringify({ schema: "agentloop.resultRead/v1", sourceResultRef: ref(), source: { view: "step_history" }, value: [] }) };
  assert.deepEqual(unreadRuntimeResultRefs(binding, [evidence]), [ref()]);
  assert.deepEqual(unreadRuntimeResultRefs(binding, [{ ...evidence, result: JSON.stringify({ sourceResultRef: ref(), source: { view: "result" }, content: "42" }) }]), []);
});

test("restart and HIL reconstruction preserve the same items, native pairs and committed effect boundaries", () => {
  const input = [...pair("source1"), ...pair("source2", declaration(item("fact", "source1")))];
  const events = [{ seq: 1, type: "plan.step.started", data: { planId: "plan", stepId: "leaf" } }];
  for (let n = 0; n < input.length; n += 2) {
    const assistant = input[n] as Extract<ModelMessage, { role: "assistant" }>;
    const outcome = input[n + 1] as Extract<ModelMessage, { role: "tool" }>;
    events.push({ seq: events.length + 1, type: "assistant.committed", data: { ...assistant, step: n / 2 + 1, finishReason: "tool_calls" } } as never,
      { seq: events.length + 2, type: "tool.completed", data: { ...outcome, result: outcome.content, invocationStatus: "completed", operationStatus: "succeeded" } } as never);
  }
  const restored = reconstructRecoveryTranscript({ events: events as never, stepId: "leaf", userInput: "HIL confirmed: inspect only A" });
  assert.deepEqual(deriveDecisionWorkingSet({ runId: identity.runId, messages: restored.messages }).items,
    deriveDecisionWorkingSet({ runId: identity.runId, messages: input }).items);
  assert.equal(restored.facts.unfinishedToolCalls.length, 0);
});

test("a resumed committed write is consumed without repeating the effect, with exact HIL still visible", async () => {
  let effects = 0;
  const events: RuntimeEvent[] = [];
  const source = pair("source1");
  source[0] = { ...source[0] as Extract<ModelMessage, { role: "assistant" }>, toolCalls: [{ id: "source1", name: "mutate", arguments: { path: "report" } }] };
  source[1] = { ...source[1] as Extract<ModelMessage, { role: "tool" }>, name: "mutate" };
  const tools = new ToolRegistry([{ name: "mutate", effect: "write", description: "Recorded effect", inputSchema: { type: "object" }, replaySafe: false, executionMode: "exclusive", parse: value => value,
    execute: async () => { effects++; return {}; } }, reader]);
  const grant = createCapabilityGrant({ runId: identity.runId, depth: 0, allowedToolNames: ["mutate", "read_result"], allowedSkillIds: [] });
  const result = await runAgentLoop({ runId: identity.runId, input: "Use recorded outcome", initialMessages: [{ role: "user", content: "HIL: do not repeat the write" }, ...source,
      ...pair("source2", declaration(item("effect", "source1", {text:"The write is committed; do not repeat it. Publication remains unverified."})))], initialToolEvidence: [{ toolCallId: "source1", toolName: "mutate", result: "committed", isError: false }],
    systemPrompt: "Use committed evidence", grant, tools, maxSteps: 2, emit: event => { events.push(event); }, model: { ...model, complete: async invocation => {
      assert.ok(invocation.messages.some(message => message.content.includes("do not repeat the write")));
      assert.deepEqual(visibleCalls(invocation),["source1", "source2"],"restart consumes projected committed effects without replaying them");
      return { content: "The committed output is available; publication is unverified.", finishReason: "stop", toolCalls: [] };
    } } });
  assert.equal(effects, 0);
  assert.ok(result.output.includes("publication is unverified"));
  assert.equal(events.some(event => event.type === "tool.dispatched"), false);
});

test("native context metadata preserves exact provider arguments, is stripped from host execution, and reconstructs after restart", async () => {
  const updates = [item("fact", "source1")];
  const decorated = decisionContextToolDefinitions([{name:"inspect",description:"Observe",inputSchema:{type:"object",additionalProperties:false,properties:{id:{type:"string"}},required:["id"]}}], true);
  assert.ok(decorated.definitions[0].inputSchema.required.includes("_agentloopContext"), "ordinary actions now carry their decision basis without a maintenance turn");
  assert.deepEqual((decorated.definitions[0].inputSchema as any).properties._agentloopContext.required, ["decision"], "changed semantic items remain optional");
  const raw = {id:"source2",name:"inspect",arguments:{id:"A",_agentloopContext:{updates}}};
  assert.deepEqual(toolCallWithoutDecisionContext(raw,decorated.names).arguments,{id:"A"});
  assert.deepEqual(raw.arguments._agentloopContext.updates,updates);
  const input = [...pair("source1"), ...pair("source2","",{}, {toolCalls:[raw],executionHistoryBasis:{...basis,contextArgumentTools:["inspect"]}})];
  const instance = assembler();
  assert.deepEqual(visibleCalls(await instance.assemble(input,[definition])),["source1", "source2"]);
  assert.equal(instance.decisionWorkingSet?.items[0].id,"fact");
  assert.deepEqual(deriveDecisionWorkingSet({runId:identity.runId,messages:structuredClone(input)}).items,instance.decisionWorkingSet?.items);
  const hostOwned = {name:"inspect",description:"Host",inputSchema:{type:"object",properties:{_agentloopContext:{type:"string"}}}};
  const untouched = decisionContextToolDefinitions([hostOwned],true);
  assert.equal(untouched.names.size,0);
  assert.equal(untouched.definitions[0],hostOwned);
  assert.deepEqual(toolCallWithoutDecisionContext(raw,untouched.names),raw);
  const untrusted = input.map(message=>message.role==='assistant'?{...message,executionHistoryBasis:{...basis,contextArgumentTools:[]}}:message);
  assert.equal(deriveDecisionWorkingSet({runId:identity.runId,messages:untrusted}).items.length,0,"a host-owned argument cannot inject a kernel context declaration");
});

test("first decision carries an action purpose but has no reconciliation schema or authority from a previous Run answer", () => {
  const tools = [{name:"inspect",description:"Observe",inputSchema:{type:"object",properties:{id:{type:"string"}}}}];
  const first = decisionContextToolDefinitions(tools, false);
  assert.equal(first.names.size, 1);
  const envelope = (first.definitions[0].inputSchema as any).properties._agentloopContext;
  assert.ok(envelope.properties.decision);
  assert.equal(envelope.properties.updates, undefined);
  const call = {id:"first",name:"inspect",arguments:{_agentloopContext:{updates:[item("fact","previous-run-call")]}}};
  assert.deepEqual(toolCallWithoutDecisionContext(call,first.names).arguments, {}, "kernel decision envelope never reaches a host tool");
  const input = pair("first","",{}, {toolCalls:[call],executionHistoryBasis:{...basis,contextArgumentTools:[]}});
  assert.equal(deriveDecisionWorkingSet({runId:identity.runId,messages:input}).items.length,0);
});

test("compact native schemas keep typed required fields while durable bounds reject oversized content", () => {
  const tools = Array.from({length:16}, (_,i) => ({name:`tool${i}`,description:"Host operation",inputSchema:{type:"object",properties:{}}}));
  const decorated = decisionContextToolDefinitions(tools,true);
  const overhead = JSON.stringify(decorated.definitions).length - JSON.stringify(tools).length;
  assert.ok(overhead < 16*1400, `Decision and update schemas must remain bounded; measured overhead ${overhead}`);
  const schema = decorated.definitions[0].inputSchema as any;
  assert.ok(schema.properties._agentloopContext.properties.updates.items.required.includes("evidence"));
  const input = [...pair("source1"),...pair("source2","",{}, {toolCalls:[{id:"source2",name:"inspect",arguments:{_agentloopContext:{updates:[item("too-long","source1",{text:"x".repeat(4001)})]}}}],executionHistoryBasis:{...basis,contextArgumentTools:["inspect"]}})];
  const derived=deriveDecisionWorkingSet({runId:identity.runId,messages:input});
  assert.equal(derived.rejections[0].reason,"invalid_context_item");
  assert.equal(derived.archived.size,0);
});

test("recovery planning consumes the same persisted semantic items and exact unresolved effect boundary", async () => {
  const messages = [...pair("source1"), ...pair("source2",declaration(item("fact","source1")))];
  const events = [{seq:1,type:"plan.step.started",data:{planId:"plan",stepId:"leaf"}}];
  for(let n=0;n<messages.length;n+=2) {
    const assistant=messages[n] as Extract<ModelMessage,{role:"assistant"}>;
    const result=messages[n+1] as Extract<ModelMessage,{role:"tool"}>;
    events.push({seq:events.length+1,type:"assistant.committed",data:{...assistant,finishReason:"tool_calls",step:n/2+1}} as never,
      {seq:events.length+2,type:"tool.completed",data:{...result,toolName:result.name,result:result.content,invocationStatus:"completed",operationStatus:"succeeded"}} as never);
  }
  const canonicalState=createCanonicalRunState({runId:identity.runId,userInput:"HIL: inspect only A",understanding:understandTask({objective:"HIL: inspect only A"})});
  await new ModelRecoveryPlanner({...model,complete:async request=>{
    const context=JSON.parse(request.runtimeContext!.content);
    assert.equal(context.decisionWorkingSet.items[0].id,"fact");
    assert.equal(context.userAuthority.originalUserInput,"HIL: inspect only A");
    assert.equal(context.unresolvedActionEffects[0].effectState,"unknown");
    assert.equal(context.recoveryTranscriptFacts.unfinishedToolCalls.length,0);
    return {content:"",finishReason:"tool_calls",toolCalls:[{id:"decision",name:"submit_recovery_decision",arguments:{actionId:"unknown-action",expectedActionRevision:1,decision:"fail",rationale:"Reconcile the unknown effect before retry.",evidenceRefs:[]}}]};
  }}).decide({runId:identity.runId,userInput:"HIL: inspect only A",canonicalState,
    action:{id:"unknown-action",revision:1,stepId:"leaf",kind:"tool_call",state:"failed",replayPolicy:"unsafe"} as never,events,userResponses:[],
    unresolvedActionEffects:[{actionId:"unknown-action",stepId:"leaf",kind:"tool_call",effectState:"unknown"}]});
});

test("RunService preserves provider release capability through action and interrupt wrappers for a non-file task", async () => {
  const database = new AppDatabase(":memory:");
  let turns = 0;
  try {
    const runs = new RunService({ database, skills: new SkillService(database),
      tools: [{ name: "inspect", effect: "read", description: "Observe a synthetic source", inputSchema: { type: "object" },
        parse: value => value, execute: async () => ({ value: 42 }) }],
      plannerFactory: singleStepTestPlanner, assessorFactory: () => ({ assess: async (input,signal,emit) => {
        assert.ok(input.contextReads);
        const content=await input.contextReads!.execute({id:"assessment-original",name:"read_result",arguments:{
          resultId:input.decisionWorkingSet!.history!.anchor.resultId,view:"producer_exchange",toolCallId:"source1",pointer:"/outcome/result",
        }},signal);
        assert.ok(content.includes("42"));
        return approvingTestAssessor().assess(input,signal,emit);
      } }),
      modelFactory: () => ({ ...model, complete: async request => {
        turns++;
        if (turns === 1) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "source1", name: "inspect", arguments: {} }] };
        if (turns === 2) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "source2", name: "inspect", arguments: { _agentloopContext: { updates: declaration(item("fact", "source1")) } } }] };
        assert.deepEqual(visibleCalls(request), ["source1", "source2"]);
        assert.ok(request.runtimeContext?.content.includes("42 confirmed by the source"));
        return { content: "测量值为 42；其他范围未知。", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.execute("owner", "Summarize this briefly");
    assert.equal(run.status, "completed");
    assert.equal(turns, 3);
    const events = await runs.events("owner", run.id);
    assert.ok(events.some(event => event.type === "context.assembled" && (event.data.decisionWorkingSet as { absorbedExchangeCount?: number })?.absorbedExchangeCount === 1));
    assert.equal(events.filter(event => event.type === "assistant.committed").length, 3, "projection adds no model calls");
    assert.ok(events.some(event => event.type === "tool.completed" && event.data.toolCallId === "source1"), "original evidence remains persisted");
    const actions=await database.prepare("SELECT metadata_json FROM runtime_actions WHERE run_id = ?").all<{metadata_json:string}>(run.id);
    const read=actions.map(row=>JSON.parse(row.metadata_json ?? "{}")).find(value=>value.toolCallId==="assessment-original");
    assert.equal(read.phase,"assessment");
    assert.equal(read.arguments.pointer,"/outcome/result","assessment selection is auditable in the existing Action ledger");
  } finally { await database.close(); }
});

test("failed writes retain their native boundary even when a model claims the error is absorbed", async () => {
  const source = pair("source1");
  source[0] = { ...source[0] as Extract<ModelMessage, { role: "assistant" }>, toolCalls: [{ id: "source1", name: "mutate", arguments: {} }] };
  source[1] = { ...source[1] as Extract<ModelMessage, { role: "tool" }>, name: "mutate", isError: true,
    executionOutcome: { invocationStatus: "completed", operationStatus: "failed" } };
  const instance = assembler();
  assert.deepEqual(visibleCalls(await instance.assemble([...source, ...pair("source2", declaration(item("failed-effect", "source1", { category: "unknown", certainty: "unknown", text: "Failed write may have partial effects; reconcile before retry." })))], [definition])), ["source1", "source2"]);
});

test("RunService pins the presented native item revision and reconstructs a same-id update without an extra turn", async () => {
  const database = new AppDatabase(":memory:");
  let turns = 0, presentedRevision: string | undefined;
  try {
    const runs = new RunService({ database, skills: new SkillService(database),
      tools: [{ name: "inspect", effect: "read", description: "Observe a synthetic source", inputSchema: { type: "object" },
        parse: value => { assert.equal((value as any)._agentloopContext, undefined); return value; }, execute: async () => ({ value: 42 }) }],
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ ...model, complete: async request => {
        turns++;
        if (turns === 4) {
          assert.deepEqual(visibleCalls(request), ["source2", "source3"]);
          assert.match(request.runtimeContext!.content, /Latest source confirms A=42; B remains unknown/);
          return { content: "A 为 42；B 未知。", finishReason: "stop", toolCalls: [] };
        }
        if (turns === 3) {
          const view = JSON.parse(request.runtimeContext!.content.match(/<decision_working_set[^>]*>([\s\S]*?)<\/decision_working_set>/)![1]);
          presentedRevision = view.items[0].revision;
          assert.ok(presentedRevision);
        }
        const { kind, ...update } = item("fact", `source${turns - 1}`, {
          text: turns === 3 ? "Latest source confirms A=42; B remains unknown" : "A=42; B remains unknown",
        });
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `source${turns}`, name: "inspect", arguments: {
          _agentloopContext: { decision: { target: "A", progress: turns === 1 ? "No local observation yet" : "A=42; B remains unknown",
            remaining: "Verify the source before delivery", purpose: "Inspect the selected source", evidence: turns === 1 ? [] : [`source${turns - 1}`], disposition: "retain" },
            ...(turns === 1 ? {} : { updates: [update] }) } } }] };
      } }),
    });
    const run = await runs.execute("owner", "Summarize A; B remains unknown");
    assert.equal(run.status, "completed"); assert.equal(turns, 4);
    const events = await runs.events("owner", run.id);
    const checkpoint = events.find(event => event.type === "assistant.committed" && (event.data.toolCalls as any[])?.[0]?.id === "source3")!;
    assert.equal((checkpoint.data.executionHistoryBasis as ExecutionHistoryBasis).contextItemRevisions!.fact, presentedRevision);
    const stepId = (checkpoint.data.executionHistoryBasis as ExecutionHistoryBasis).identity.stepId!;
    const restored = reconstructRecoveryTranscript({ events, stepId, userInput: run.input });
    const state = deriveDecisionWorkingSet({ runId: run.id, messages: restored.messages });
    assert.equal(state.items.length, 1); assert.equal(state.rejections.length, 0);
    assert.equal(state.items[0].supersedes!.revision, presentedRevision);
    assert.equal(events.filter(event => event.type === "assistant.committed").length, 4);
  } finally { await database.close(); }
});

test("a corrected rejected revision closes only the declaration gap and repeated reads reconcile into one stable item", () => {
  const input = [...pair("source1"), ...pair("source2", declaration(item("fact", "source1", { replaces: "wrong" })))];
  assert.equal(deriveDecisionWorkingSet({ runId: identity.runId, messages: input }).view.rejectedUpdates.length, 1);
  input.push(...pair("source3", declaration(item("fact", "source1"))));
  const previous = deriveDecisionWorkingSet({ runId: identity.runId, messages: input });
  assert.equal(previous.view.gaps.length, 0);
  input.push(...pair("source4", declaration(item("fact", "source2")), {}, { executionHistoryBasis: { ...basis, contextItemRevisions: { fact: previous.items[0].revision } } }));
  const corrected = deriveDecisionWorkingSet({ runId: identity.runId, messages: input });
  assert.equal(corrected.items.length, 1);
  assert.equal(corrected.view.gaps.length, 0);
});

test("a renamed current finding explicitly retires the old item; stale request revisions cannot revive it", () => {
  const input=[...pair("source1"),...pair("source2",declaration(item("attempt-one","source1")))];
  const previous=deriveDecisionWorkingSet({runId:identity.runId,messages:input}).items[0];
  input.push(...pair("source3",declaration(item("attempt-two","source2",{resolves:["attempt-one"]})), {}, {
    executionHistoryBasis:{...basis,contextItemRevisions:{"attempt-one":previous.revision}} }));
  const current=deriveDecisionWorkingSet({runId:identity.runId,messages:input});
  assert.deepEqual(current.items.map(value=>value.id),["attempt-two"]);
  assert.equal(current.allItems.find(item=>item.id==="attempt-one")?.status,"resolved");
  assert.equal(current.view.historicalItemCount,1);
  input.push(...pair("source4",declaration(item("attempt-one","source3")), {}, {
    executionHistoryBasis:{...basis,contextItemRevisions:{"attempt-one":previous.revision}} }));
  const stale=deriveDecisionWorkingSet({runId:identity.runId,messages:input});
  assert.equal(stale.rejections.length,1);
  assert.deepEqual(stale.items.map(value=>value.id),["attempt-two"]);
});

test("native context discriminator is syntax; missing disposition never infers content release", () => {
  const { kind, disposition, ...observation } = item("fact", "source1");
  const messages = [...pair("source1"), ...pair("source2", "", {}, {
    toolCalls: [{ id: "source2", name: "inspect", arguments: { _agentloopContext: { updates: [observation] } } }],
    executionHistoryBasis: { ...basis, contextArgumentTools: ["inspect"], contextItemRevisions: {} },
  })];
  const result = deriveDecisionWorkingSet({ runId: identity.runId, messages });
  assert.equal(result.items.length, 0); assert.equal(result.rejections[0].reason, "invalid_context_item");
  assert.equal(result.archived.size, 0, "missing disposition cannot silently release evidence");
  assert.deepEqual(visibleCalls(result), ["source1", "source2"]);
  const invalid = structuredClone(messages);
  (invalid[2] as any).toolCalls[0].arguments._agentloopContext.updates[0].evidence = [];
  assert.equal(deriveDecisionWorkingSet({ runId: identity.runId, messages: invalid }).items.length, 0);
});

test("same-id native updates use presented versions; stale or unbound checkpoints cannot overwrite state", () => {
  const input = [...pair("source1"), ...pair("source2", declaration(item("fact", "source1")))];
  const revision = deriveDecisionWorkingSet({ runId: identity.runId, messages: input }).items[0].revision;
  const update = (step: string, presented?: string, replaces?: string) => pair(step, "", {}, {
    executionHistoryBasis: { ...basis, contextArgumentTools: ["inspect"], ...(presented ? { contextItemRevisions: { fact: presented } } : {}) },
    toolCalls: [{ id: step, name: "inspect", arguments: { _agentloopContext: { updates: [item("fact", "source2", { ...(replaces ? { replaces } : {}), text: "New evidence replaces the earlier model interpretation." })] } } }],
  });
  for (const replaces of [undefined, "fact", revision]) {
    const result = deriveDecisionWorkingSet({ runId: identity.runId, messages: [...input, ...update("source3", revision, replaces)] });
    assert.equal(result.rejections.length, replaces === undefined ? 0 : 1); assert.equal(result.items.length, 1);
    assert.equal(result.view.historicalItemCount, replaces === undefined ? 1 : 0);
  }
  for (const presented of [undefined, "stale-version"]) {
    const result = deriveDecisionWorkingSet({ runId: identity.runId, messages: [...input, ...update("source3", presented)] });
    assert.equal(result.items[0].revision, revision); assert.equal(result.view.rejectedUpdates?.[0].expectedRevision, revision);
  }
  const first = [...input, ...update("source3", revision)];
  const stale = deriveDecisionWorkingSet({ runId: identity.runId, messages: [...first, ...update("source4", revision)] });
  assert.equal(stale.rejections.length, 1, "two updates from the same old version cannot overwrite each other");
});

test("60 percent more resolved native turns keep a fixed effective set and restart basis", async () => {
  const measurements = [];
  for (const steps of [100, 160]) {
    const messages: ModelMessage[] = [{ role: "user", content: "HIL: inspect A only; do not publish. B remains unknown." }, ...pair("source0", "", { value: 42, detail: "resolved detail ".repeat(50) })];
    for (let index = 1; index <= steps; index++) {
      const previous = deriveDecisionWorkingSet({ runId: identity.runId, messages });
      const { kind, ...update } = item("current-fact", `source${index - 1}`, { text: "A=42 at revision r1. Source B remains unknown; no permission to publish." });
      messages.push(...pair(`source${index}`, "", { value: 42, detail: "resolved detail ".repeat(50) }, {
        executionHistoryBasis: { ...basis, contextArgumentTools: ["inspect"], contextItemRevisions: Object.fromEntries(previous.items.map(i => [i.id, i.revision])) },
        toolCalls: [{ id: `source${index}`, name: "inspect", arguments: { _agentloopContext: { updates: [update] } } }],
      }));
    }
    const instance = assembler(); const assembled = await instance.assemble(messages, [definition]);
    assert.equal(instance.decisionWorkingSet!.items.length, 1); assert.equal(instance.decisionWorkingSet!.rejectionCount, 0);
    assert.equal(visibleCalls(assembled).length, 2); assert.equal(assembled.messages[0].content, messages[0].content);
    assert.match(assembled.runtimeContext.content, /Source B remains unknown/);
    const events: any[] = [{ seq: 1, type: "plan.step.started", data: { planId: "plan", stepId: "leaf" } }];
    for (let n = 1; n < messages.length; n += 2) {
      const a = messages[n] as Extract<ModelMessage, { role: "assistant" }>, t = messages[n + 1] as Extract<ModelMessage, { role: "tool" }>;
      // Reproduce streamed receipt-before-assistant order across restart.
      events.push({ seq: events.length + 1, type: "tool.completed", data: { step: (n + 1) / 2, toolName: t.name, toolCallId: t.toolCallId, result: t.content, ...t.executionOutcome } },
        { seq: events.length + 2, type: "assistant.committed", data: { ...a, step: (n + 1) / 2 } });
    }
    const restored = reconstructRecoveryTranscript({ events, stepId: "leaf", userInput: messages[0].content });
    const resumed = deriveDecisionWorkingSet({ runId: identity.runId, messages: restored.messages });
    assert.deepEqual(resumed.items, deriveDecisionWorkingSet({ runId: identity.runId, messages }).items);
    measurements.push({ steps, characters: modelInvocationComposition({ phase: "execution", systemPrompt: "Respect scope", tools: [definition], ...assembled }).totalCharacters as number });
  }
  assert.ok(measurements[1].characters < measurements[0].characters * 1.05, JSON.stringify(measurements));
  console.log(`NATIVE_60_PERCENT_REPLAY ${JSON.stringify(measurements)}`);
});
