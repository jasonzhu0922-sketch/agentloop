import assert from "node:assert/strict";
import test from "node:test";
import { committedDecisionRecords } from "../src/runtime/committed-decision-records.ts";
import { deriveDecisionWorkingSet } from "../src/runtime/decision-working-set.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { projectDecisionEvidence } from "../src/runtime/decision-evidence-projection.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import { createResultTool } from "../src/tools/result-tool.ts";
import { modelInvocationComposition } from "../src/runtime/model-streaming.ts";
import { decisionContextToolDefinitions, decisionContextReferenceBindings, decisionContextEvidenceReferences } from "../src/runtime/decision-context-transport.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { approvingTestAssessor, singleStepTestPlanner } from "./runtime-test-helpers.ts";
import type { ExecutionHistoryBasis } from "../src/runtime/execution-history-projection.ts";
import type { RuntimeEvent } from "../src/runtime/contracts.ts";

const runId = "context-lifecycle";
const basis: ExecutionHistoryBasis = { identity: { runId, planId: "plan", stepId: "leaf", eventWatermark: 0,
  reducerVersion: "v1", viewId: "view", decisionBasisDigest: "basis" }, contextArgumentTools: ["inspect"], toolEffects: { inspect: "read" } };
const ref = { schema: "agentloop.resultRef/v1", resultId: "rr_11111111-1111-4111-8111-111111111111" };
const update = (rest: Record<string, unknown> = {}) => ({ id: "finding", category: "observation", text: "Value 42 at source revision r1; outside A unknown.",
  scope: "A only", certainty: "observed", evidence: ["@e1"], disposition: "carry", ...rest });
const checkpoint = (id: string, updates: unknown[] = [], overrides: Partial<ExecutionHistoryBasis> = {}): RuntimeEvent => ({ type: "assistant.committed", data: {
  content: "", finishReason: "tool_calls", executionHistoryBasis: { ...basis, ...overrides },
  toolCalls: [{ id, name: "inspect", arguments: { key: "A", _agentloopContext: { updates } } }],
} });
const receipt = (id: string, operationStatus = "succeeded"): RuntimeEvent => ({ type: "tool.completed", data: {
  toolCallId: id, toolName: "inspect", result: JSON.stringify({ value: 42, resultRef: ref }), resultRef: ref,
  invocationStatus: "completed", operationStatus,
} });
function restored(events: readonly RuntimeEvent[]) {
  return reconstructRecoveryTranscript({ userInput: "HIL: A only; no publication", stepId: "leaf",
    events: [{ seq: 1, type: "plan.step.started", data: { stepId: "leaf" } }, ...events.map((event, index) => ({ ...event, seq: index + 2 }))] });
}
function derive(events: readonly RuntimeEvent[]) {
  const recovery = restored(events);
  return deriveDecisionWorkingSet({ runId, messages: recovery.messages, records: committedDecisionRecords(recovery.workProductEvents ?? []) });
}

test("request-bound short references carry content explicitly and survive streamed receipt-first restart", () => {
  const events = [receipt("source"), checkpoint("source"), checkpoint("next", [update()], {
    contextEvidenceBindings: { "@e1": "source" }, contextEvidenceToolCallIds: ["source"],
  }), receipt("next")];
  const result = derive(events);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.items[0].evidence[0].toolCallId, "source");
  assert.equal(result.items[0].authority, "model");
  assert.equal(result.items[0].status, "active", "completed observation remains current without a model status flag");
  assert.deepEqual([...result.archived], ["source"]);
  assert.deepEqual(result.view.evidenceReferences, [{ ref: "@e1", toolCallId: "source", resultId: ref.resultId }, { ref: "@e2", toolCallId: "next", resultId: ref.resultId }]);
  const nativeIndependent = deriveDecisionWorkingSet({ runId, messages: [], records: committedDecisionRecords(restored(events).workProductEvents ?? []) });
  assert.deepEqual(nativeIndependent.items, result.items);
});

test("new requests expose one current-item disposition without manual revision or action-completion state", () => {
  const { definitions } = decisionContextToolDefinitions([{ name: "inspect", description: "Read", inputSchema: { type: "object" } }], true);
  const item = (definitions[0].inputSchema as any).properties._agentloopContext.properties.updates.items;
  assert.deepEqual(item.properties.disposition.enum, ["carry", "retain"]);
  for (const old of ["absorbs", "status", "replaces"]) assert.equal(item.properties[old], undefined);
});

test("exact Result identity binds to its unique visible producer; ambiguous identities and call-ID collisions do not bind", () => {
  const refs = [{ ref: "@e1", toolCallId: "source", resultId: ref.resultId }];
  const bindings = decisionContextReferenceBindings(refs);
  assert.equal(bindings[ref.resultId], "source");
  const result = derive([checkpoint("source"), receipt("source"), checkpoint("next", [update({ evidence: [ref.resultId] })], {
    contextEvidenceBindings: bindings, contextEvidenceToolCallIds: ["source"],
  })]);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.items[0].evidence[0].toolCallId, "source");
  assert.equal(decisionContextReferenceBindings([...refs, { ref: "@e2", toolCallId: "other", resultId: ref.resultId }])[ref.resultId], undefined);
  assert.equal(decisionContextReferenceBindings([...refs, { ref: "@e2", toolCallId: "@e1" }])["@e1"], undefined);
});

test("native arguments are the sole state input; retired lifecycle inputs are rejected atomically", () => {
  for (const evidence of ["@e1", ref.resultId]) {
    const claim = { kind: "context", ...update({ evidence: [evidence] }) };
    const content = `<work_product_progress>${JSON.stringify({ updates: [claim] })}</work_product_progress>`;
    const bindings = decisionContextReferenceBindings([{ ref: "@e1", toolCallId: "source", resultId: ref.resultId }]);
    const native = (checkpoint("native", [claim]).data.toolCalls as any[]);
    const cited = decisionContextEvidenceReferences(native, ["inspect"], bindings);
    assert.deepEqual(cited, ["source"]);
    const next = checkpoint("next", [], { contextArgumentTools: [], contextEvidenceBindings: bindings, contextEvidenceToolCallIds: cited });
    next.data.content = content;
    const state = derive([checkpoint("source"), receipt("source"), next, receipt("next")]);
    assert.equal(state.rejections.length, 0);
    assert.equal(state.items.length, 0, "assistant text is never a context write");
    assert.equal(state.archived.size, 0);
  }
  for (const field of ["absorbs", "status", "replaces"]) {
    const state = derive([checkpoint("source"), receipt("source"), checkpoint("next", [update({ [field]: field === "status" ? "active" : [] })], {
      contextEvidenceBindings: { "@e1": "source" }, contextEvidenceToolCallIds: ["source"],
    }), receipt("next")]);
    assert.equal(state.items.length, 0, field);
    assert.equal(state.archived.size, 0, field);
    assert.deepEqual(state.view.rejectedUpdates?.[0].invalidFields, [field]);
  }
});

test("a new finding can retire an obsolete observation explicitly, while a version-bound issue requires its presented version", () => {
  for (const versionBound of [false, true]) {
    const versions = [{ path: "report", versionId: "r1", evidenceToolCallIds: ["source"] }];
    const events = [checkpoint("source"), receipt("source"), checkpoint("new-source", [update({ id: "old-finding",
      ...(versionBound ? { version: { path: "report", versionId: "r1" } } : {}),
    })], { contextEvidenceBindings: { "@e1": "source" }, contextEvidenceToolCallIds: ["source"], workProductVersions: versions }), receipt("new-source")];
    const previous = derive(events).items[0];
    const next = checkpoint("next", [update({ resolves: ["old-finding"], evidence: ["@e2"] })], {
      contextEvidenceBindings: { "@e2": "new-source" }, contextEvidenceToolCallIds: ["new-source"],
      contextItemRevisions: { "old-finding": previous.revision },
    });
    const first = derive([...events, next, receipt("next")]);
    assert.deepEqual(first.items.map(item => item.id), versionBound ? ["old-finding"] : ["finding"]);
    if (versionBound) {
      (next.data.executionHistoryBasis as any).workProductVersions = versions;
      assert.deepEqual(derive([...events, next, receipt("next")]).items.map(item => item.id), ["finding"]);
    }
  }
});

test("foreign, invented, future and ambiguous references cannot be accepted as context evidence", () => {
  for (const bindings of [undefined, { "@e1": "foreign" }, { "@e1": "next" }]) {
    const result = derive([checkpoint("source"), receipt("source"), checkpoint("next", [update()], {
      contextEvidenceBindings: bindings, contextEvidenceToolCallIds: ["source"],
    }), receipt("next")]);
    assert.equal(result.items.length, 0); assert.equal(result.archived.size, 0);
  }
  const ambiguous = derive([checkpoint("source"), receipt("source"), receipt("source"), checkpoint("next", [update()], {
    contextEvidenceBindings: { "@e1": "source" }, contextEvidenceToolCallIds: ["source"],
  }), receipt("next")]);
  assert.equal(ambiguous.items.length, 0);
  assert.equal(ambiguous.view.evidenceReferences?.some(entry => entry.toolCallId === "source"), false);
});

test("retain and omitted disposition preserve bodies; contradictory disposition rejects the whole declaration", () => {
  for (const extra of [{ disposition: "retain" }, { disposition: undefined }, { disposition: "carry", absorbs: [] }, { disposition: "retain", absorbs: ["@e1"] }]) {
    const state = derive([checkpoint("source"), receipt("source"), checkpoint("next", [update(extra)], {
      contextEvidenceBindings: { "@e1": "source" }, contextEvidenceToolCallIds: ["source"],
    }), receipt("next")]);
    assert.equal(state.archived.size, 0);
    assert.equal(state.items.length, extra.disposition === "retain" && !extra.absorbs ? 1 : 0);
  }
});

test("a finding can explicitly resolve a presented issue with new successful evidence, without another action", () => {
  const events = [checkpoint("failure"), receipt("failure", "failed"), checkpoint("successful", [update({ id: "gap", category: "unknown", certainty: "unknown", text: "The previous attempt failed; value remains unknown." })], {
    contextEvidenceBindings: { "@e1": "failure" }, contextEvidenceToolCallIds: ["failure"],
  }), receipt("successful")];
  const gap = derive(events).items[0];
  events.push(checkpoint("next", [update({ evidence: ["@e2"], resolves: ["gap"] })], {
    contextEvidenceBindings: { "@e2": "successful" }, contextEvidenceToolCallIds: ["successful"], contextItemRevisions: { gap: gap.revision },
  }), receipt("next"));
  const result = derive(events);
  assert.deepEqual(result.items.map(item => item.id), ["finding"]);
  assert.equal(result.allItems.find(item => item.id === "gap")?.status, "resolved");
  assert.equal(result.allItems.find(item => item.id === "gap")?.authority, "model");
  assert.equal(result.rejections.length, 0);
  const recovery = restored(events);
  assert.deepEqual(projectDecisionEvidence({ evidence: recovery.toolEvidence,
    workingSet: { ...result.view, history: result.history }, reconciledToolCallIds: result.reconciledToolCallIds,
    unsafeEffectToolCallIds: result.unsafeEffectToolCallIds }).map(evidence => evidence.toolCallId), ["next"]);
});

test("stale, failed, unknown and unpresented resolution evidence leaves the original issue current atomically", () => {
  for (const mode of ["stale", "failed", "unknown", "unpresented", "old-evidence"]) {
    const events = [checkpoint("source"), receipt("source"), checkpoint("new-source", [update({ id: "gap", category: "unknown", certainty: "unknown" })], {
      contextEvidenceBindings: { "@e1": "source" }, contextEvidenceToolCallIds: ["source"],
    }), receipt("new-source", ["failed", "unknown"].includes(mode) ? mode : "succeeded")];
    const gap = derive(events).items[0];
    const source = mode === "old-evidence" ? "source" : "new-source";
    events.push(checkpoint("next", [update({ resolves: ["gap"] })], {
      contextEvidenceBindings: { "@e1": source }, contextEvidenceToolCallIds: [source],
      contextItemRevisions: mode === "unpresented" ? {} : { gap: mode === "stale" ? "stale" : gap.revision },
    }), receipt("next"));
    const result = derive(events);
    assert.deepEqual(result.items.map(item => item.id), ["gap"], mode);
    assert.equal(result.items[0].revision, gap.revision, mode);
    assert.equal(result.rejections.length, 1, mode);
    assert.equal(result.reconciledToolCallIds.has("new-source"), false, "invalid resolution cannot partly absorb its evidence");
  }
});

test("a stable unknown item can become a current finding only with an explicit self-resolution and new evidence", () => {
  const events = [checkpoint("source"), receipt("source"), checkpoint("new-source", [update({ id: "finding", category: "unknown", certainty: "unknown" })], {
    contextEvidenceBindings: { "@e1": "source" }, contextEvidenceToolCallIds: ["source"],
  }), receipt("new-source")];
  const prior = derive(events).items[0];
  for (const explicit of [false, true]) {
    const state = derive([...events, checkpoint("next", [update({ evidence: ["@e2"], ...(explicit ? { resolves: ["finding"] } : {}) })], {
      contextEvidenceBindings: { "@e2": "new-source" }, contextEvidenceToolCallIds: ["new-source"], contextItemRevisions: { finding: prior.revision },
    }), receipt("next")]);
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].category, explicit ? "observation" : "unknown");
    assert.equal(state.items[0].status, "active");
    assert.equal(state.rejections.length, explicit ? 0 : 1);
    if (explicit) assert.deepEqual(state.items[0].supersedes, { id: prior.id, revision: prior.revision });
  }
});

test("reasoning and uncertain write effects remain native even with an explicit carry disposition", () => {
  for (const mode of ["reasoning", "write-unknown", "write-failed"]) {
    const event = checkpoint("source", [], { toolEffects: { inspect: mode.startsWith("write") ? "write" : "read" } });
    if (mode === "reasoning") event.data.reasoningContent = "provider continuation";
    const events = [event, receipt("source", mode === "write-unknown" ? "unknown" : mode === "write-failed" ? "failed" : "succeeded"),
      checkpoint("next", [update()], { contextEvidenceBindings: { "@e1": "source" }, contextEvidenceToolCallIds: ["source"] }), receipt("next")];
    const state = derive(events);
    assert.equal(state.items.length, 1);
    assert.equal(state.archived.size, 0, mode);
    if (mode !== "reasoning") assert.equal(state.unsafeEffectToolCallIds.has("source"), true);
  }
});

test("RunService binds only cited visible references before execution; normal business turns resolve old issues", async () => {
  const database = new AppDatabase(":memory:");
  let calls = 0, effects = 0, presentedResultId: string | undefined;
  try {
    const runs = new RunService({ database, skills: new SkillService(database),
      tools: [{ name: "inspect", effect: "read", description: "Compare two source observations, then verify scope", inputSchema: { type: "object" },
        parse: value => { assert.equal((value as any)._agentloopContext, undefined); return value; }, execute: async () => { effects++; return { value: 42, scope: "A" }; } }],
      plannerFactory: singleStepTestPlanner, assessorFactory: approvingTestAssessor,
      modelFactory: () => ({ completedExchangePolicy: "releasable", limits: { contextWindowTokens: 100000, maxOutputTokens: 4096 }, complete: async request => {
        calls++;
        const working = JSON.parse(request.runtimeContext!.content.match(/<decision_working_set[^>]*>([\s\S]*?)<\/decision_working_set>/)![1]);
        if (calls === 4) {
          assert.deepEqual(working.items.map((item: any) => item.id), ["finding"]);
          assert.equal(working.rejectionCount, 0);
          return { content: "A=42；A 以外未知，未发布。", finishReason: "stop", toolCalls: [] };
        }
        const reference = working.evidenceReferences?.find((entry: any) => entry.toolCallId === `source${calls - 1}`);
        const source = calls === 3 ? reference?.resultId : reference?.ref;
        if (calls === 3) presentedResultId = source;
        if (calls > 1) assert.ok(source);
        const claim = update({ evidence: [source], ...(calls === 2 ? { id: "gap", category: "unknown", certainty: "unknown", text: "Independent confirmation remains unknown." } : { resolves: ["gap"] }) });
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `source${calls}`, name: "inspect",
          arguments: { _agentloopContext: { decision: { target: "A", progress: calls === 1 ? "No local evidence" : "A=42; independent confirmation pending",
            remaining: "Confirm scope against the source", purpose: "Compare the next source", evidence: calls === 1 ? [] : [source], disposition: "retain" },
            ...(calls === 1 ? {} : { updates: [claim] }) } } }] };
      } }),
    });
    const run = await runs.execute("owner", "Compare A with the second source and verify its scope; do not publish");
    assert.equal(run.status, "completed"); assert.equal(calls, 4); assert.equal(effects, 3);
    const events = await runs.events("owner", run.id);
    const cp = events.find(event => event.type === "assistant.committed" && (event.data.toolCalls as any[])?.[0]?.id === "source3")!;
    const frozen = cp.data.executionHistoryBasis as ExecutionHistoryBasis;
    assert.deepEqual(frozen.contextEvidenceBindings, { [presentedResultId!]: "source2" });
    assert.deepEqual(frozen.contextEvidenceToolCallIds, ["source2"]);
    const recovery = reconstructRecoveryTranscript({ events, stepId: frozen.identity.stepId!, userInput: run.input });
    const rebuilt = deriveDecisionWorkingSet({ runId: run.id, messages: recovery.messages, records: committedDecisionRecords(recovery.workProductEvents ?? []) });
    assert.deepEqual(rebuilt.items.map(item => item.id), ["finding"]); assert.equal(rebuilt.rejections.length, 0);
  } finally { await database.close(); }
});

test("60 percent more carried observations keep content, authority and restart basis without opaque-ID absorption lists", async () => {
  const measurements: { steps: number; characters: number }[] = [];
  const reader = createResultTool({} as never);
  for (const steps of [100, 160]) {
    const events: RuntimeEvent[] = [checkpoint("source0"), receipt("source0")];
    for (let index = 1; index <= steps; index++) {
      const state = derive(events);
      const source = `source${index - 1}`;
      const alias = state.view.evidenceReferences!.find(entry => entry.toolCallId === source)!.ref;
      events.push(checkpoint(`source${index}`, [update({ evidence: [alias],
        text: "Code revision r1 passes the requested test; research A and B conflict on dates; value 42 = 10 + 32 at source r1; outside A unknown; no publication authorized.",
      })], { contextEvidenceBindings: { [alias]: source }, contextEvidenceToolCallIds: [source],
        contextItemRevisions: Object.fromEntries(state.items.map(item => [item.id, item.revision])),
      }), receipt(`source${index}`));
    }
    const transcript = restored(events);
    const assembler = new ContextAssembler({ runId, systemPrompt: "Respect authority and provenance",
      runtimeContext: { phase: "execution", content: "HIL: A only; no publication" }, decisionEvents: () => transcript.workProductEvents ?? [],
      model: { completedExchangePolicy: "releasable", limits: { contextWindowTokens: 100000, maxOutputTokens: 4096 },
        complete: async () => { throw Error("No maintenance model call"); } } });
    const assembly = await assembler.assemble(transcript.messages, [{ name: reader.name, description: reader.description, inputSchema: reader.inputSchema }]);
    assert.equal(assembler.decisionWorkingSet?.items.length, 1);
    assert.equal(assembler.decisionWorkingSet?.rejectionCount, 0);
    assert.equal(assembler.decisionWorkingSet?.pendingToolCallIds.length, 1);
    assert.equal(assembly.messages.length, 3, "exact user input and one unconsumed exchange remain");
    assert.match(assembly.runtimeContext.content, /research A and B conflict/);
    assert.match(assembly.runtimeContext.content, /outside A unknown/);
    assert.equal(assembly.messages[0].content, "HIL: A only; no publication");
    assert.deepEqual(derive(events).items, deriveDecisionWorkingSet({ runId, messages: [], records: committedDecisionRecords(transcript.workProductEvents ?? []) }).items);
    measurements.push({ steps, characters: modelInvocationComposition({ phase: "execution", systemPrompt: "Respect authority and provenance", tools: [], ...assembly }).totalCharacters as number });
  }
  assert.ok(measurements[1].characters < measurements[0].characters * 1.02, JSON.stringify(measurements));
  console.log(`CONTENT_LIFECYCLE_60_PERCENT ${JSON.stringify(measurements)}`);
});
