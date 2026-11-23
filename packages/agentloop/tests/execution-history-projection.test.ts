import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import { projectExecutionHistory, executionHistoryContext, type ExecutionHistoryBasis } from "../src/runtime/execution-history-projection.ts";
import { deriveCurrentDecisionView } from "../src/runtime/current-decision-view.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { OpenAICompatibleModel, ResponsesModel } from "../src/runtime/models.ts";
import type { ModelMessage, ModelAdapter, RuntimeEvent } from "../src/runtime/contracts.ts";

const identity = deriveCurrentDecisionView({ runId: "projection-test" }).identity;
const basis: ExecutionHistoryBasis = { identity, toolEffects: { inspect: "read" } };
const statement = "承诺保留单位元/吨；2026-11-22 前不发布。假设版本过期，尚未验证。证据来自 source://receipt。";
function exchange(id: string, overrides: { args?: unknown; content?: string; basis?: ExecutionHistoryBasis; error?: boolean; statement?: string } = {}): ModelMessage[] {
  return [{ role: "assistant", content: overrides.statement ?? statement, executionHistoryBasis: overrides.basis ?? basis,
    toolCalls: [{ id, name: "inspect", arguments: overrides.args ?? { revision: "old", path: "report.json", unit: "元/吨" } }] },
  { role: "tool", toolCallId: id, name: "inspect", isError: overrides.error ?? true,
    content: overrides.content ?? '{"ok":false,"code":"CONFLICT","currentRevision":"r2","reason":"use current revision"}',
    executionOutcome: { invocationStatus: "completed", operationStatus: overrides.error === false ? "succeeded" : "failed" } }];
}
const calls = (messages: readonly ModelMessage[]) => messages.flatMap(message => message.role === "assistant" ? message.toolCalls ?? [] : []);
const model: ModelAdapter = { limits: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
  complete: async () => { throw new Error("ordinary projection must not call a summarizer"); } };
function assembler(overrides: Partial<ConstructorParameters<typeof ContextAssembler>[0]> = {}) {
  return new ContextAssembler({ runId: "projection-test", systemPrompt: "Execute correctly.", runtimeContext: { phase: "execution", content: "Current authority" }, model, ...overrides });
}

test("folds identical read failures with exact statements, full latest exchange and source identities; projection is immutable and idempotent", async () => {
  const input: ModelMessage[] = [{ role: "user", content: "保留所有明细，不允许以零替代缺失值。" }, ...exchange("a"), ...exchange("b"), ...exchange("c")];
  const before = structuredClone(input);
  const projection = projectExecutionHistory(input);
  assert.deepEqual(calls(projection.messages), calls(input).slice(-1));
  assert.equal(projection.mergedExchangeCount, 2);
  assert.deepEqual(projection.messages.at(-1), input.at(-1));
  const history = JSON.parse(executionHistoryContext(projection.messages)!).records[0];
  assert.equal(history.failureCount, 3);
  assert.deepEqual(history.statements, [{ text: statement, sourceToolCallIds: ["a", "b", "c"] }]);
  assert.deepEqual(history.failedAttempts.map((item: { toolCallIds: string[] }) => item.toolCallIds), [["a"], ["b"], ["c"]]);
  assert.deepEqual(projectExecutionHistory(projection.messages).messages, projection.messages);
  assert.deepEqual(input, before);
  const instance = assembler();
  const first = await instance.assemble(input, []);
  const second = await instance.assemble(input, []);
  assert.deepEqual(first, second);
  assert.deepEqual(first.messages[0], input[0]);
  assert.equal(first.messages[1].content, "", "historical prose must not remain an assistant style example");
  assert.ok(first.runtimeContext.content.includes(statement));
});

for (const change of ["arguments", "receipt", "state", "plan", "basis", "effect", "unknown", "success", "reasoning", "missing-basis", "user"] as const) {
  test(`does not fold across changed ${change}; actionable current evidence stays available`, () => {
    const next = exchange("b");
    const assistant = next[0] as Extract<ModelMessage, { role: "assistant" }>;
    const result = next[1] as Extract<ModelMessage, { role: "tool" }>;
    if (change === "arguments") next[0] = { ...assistant, toolCalls: [{ ...assistant.toolCalls![0], arguments: { revision: "r2", path: "report.json" } }] };
    if (change === "receipt") next[1] = { ...result, content: '{"ok":false,"code":"CONFLICT","currentRevision":"r3"}' };
    if (change === "state") next[0] = { ...assistant, executionHistoryBasis: { ...basis, identity: { ...identity, canonicalState: { stateId: "state", runId: "projection-test", intentId: "intent", revision: 2 } } } };
    if (change === "plan") next[0] = { ...assistant, executionHistoryBasis: { ...basis, identity: { ...identity, planVersion: 2 } } };
    if (change === "basis") next[0] = { ...assistant, executionHistoryBasis: { ...basis, identity: { ...identity, decisionBasisDigest: "changed" } } };
    if (change === "effect") next[0] = { ...assistant, executionHistoryBasis: { ...basis, toolEffects: { inspect: "write" } } };
    if (change === "unknown") next[1] = { ...result, executionOutcome: { invocationStatus: "failed", operationStatus: "unknown" } };
    if (change === "success") next[1] = { ...result, isError: false, content: '{"ok":true,"revision":"r2","amount":42,"unit":"元/吨"}' };
    if (change === "reasoning") next[0] = { ...assistant, reasoningContent: "opaque continuation" };
    if (change === "missing-basis") next[0] = { ...assistant, executionHistoryBasis: undefined };
    const correction: ModelMessage[] = change === "user" ? [{ role: "user", content: "改为检查 r3；不要修改文件。" }] : [];
    const input = [...exchange("a"), ...correction, ...next];
    const projected = projectExecutionHistory(input);
    assert.equal(projected.mergedExchangeCount, 0);
    assert.deepEqual(calls(projected.messages), calls(input));
    assert.deepEqual(projected.messages.at(-1), next[1]);
    if (correction.length) assert.ok(projected.messages.some(message => message.content === correction[0].content));
  });
}

test("parallel batches fold as whole exchanges; partial or successful siblings remain", async () => {
  const batch = (prefix: string): ModelMessage[] => {
    const a = exchange(prefix + "a"), b = exchange(prefix + "b", { content: '{"ok":false,"reason":"independent receipt b"}' });
    return [{ ...a[0], toolCalls: [...calls(a), ...calls(b)] } as ModelMessage, b[1], a[1]];
  };
  const input = [...batch("first"), ...batch("last")];
  const result = await assembler().assemble(input, []);
  assert.deepEqual(calls(result.messages).map(call => call.id), ["lasta", "lastb"]);
  assert.deepEqual(result.messages.slice(-2), input.slice(-2));
  const attempts = JSON.parse(executionHistoryContext(result.messages)!).records[0].failedAttempts;
  for (const attempt of attempts) for (const [index, id] of attempt.toolCallIds.entries()) {
    const receipt = input.find(message => message.role === "tool" && message.toolCallId === id)!;
    assert.equal(attempt.resultHashes[index], createHash("sha256").update(receipt.content).digest("hex"));
  }
  const incomplete = input.slice(0, -1);
  await assert.rejects(() => assembler().assemble(incomplete, []), /without results/);
  assert.deepEqual(calls(projectExecutionHistory(incomplete).messages), calls(incomplete));
});

test("publication ResultRefs remain traceable while source ResultRefs and source revisions are compared", () => {
  const first = exchange("a", { content: JSON.stringify({ ok: false, sourceResultRef: "source-1", resultRef: { schema: "agentloop.resultRef/v1", resultId: "rr_11111111-1111-4111-8111-111111111111" } }) });
  const second = exchange("b", { content: JSON.stringify({ ok: false, sourceResultRef: "source-1", resultRef: { schema: "agentloop.resultRef/v1", resultId: "rr_22222222-2222-4222-8222-222222222222" } }) });
  const merged = projectExecutionHistory([...first, ...second]);
  assert.equal(merged.mergedExchangeCount, 1);
  assert.deepEqual(merged.messages.at(-1), second.at(-1));
  assert.equal(JSON.parse(executionHistoryContext(merged.messages)!).records[0].failedAttempts.length, 2);
  assert.equal(projectExecutionHistory([...first, ...exchange("c", { content: '{"ok":false,"sourceResultRef":"source-2"}' })]).mergedExchangeCount, 0);
});

test("recovery retains successful writes in interrupted batches and leaves unknown siblings unresolved", async () => {
  for (const early of [false, true]) {
    const write = { id: "written", name: "write", arguments: { path: "report.txt", content: "all 42 rows" } };
    const pending = { id: "pending", name: "publish", arguments: {} };
    const transcript = reconstructRecoveryTranscript({ userInput: "不要重复发布", stepId: "s", events: [
      { seq: 1, type: "plan.step.started", data: { stepId: "s" } },
      ...(early ? [write, pending].map((call, i) => ({ seq: i + 2, type: "assistant.tool_call.committed", data: { toolCallId: call.id, name: call.name, arguments: call.arguments } }))
        : [{ seq: 2, type: "assistant.committed", data: { content: "发布尚待核对", toolCalls: [write, pending] } }]),
      { seq: 4, type: "tool.completed", data: { toolCallId: "written", result: '{"path":"report.txt","bytes":42}', invocationStatus: "completed", operationStatus: "succeeded" } },
    ] });
    assert.deepEqual(transcript.facts.unfinishedToolCalls, [{ toolCallId: "pending", toolName: "publish" }]);
    assert.deepEqual(calls(transcript.messages), [write]);
    assert.equal(transcript.toolEvidence[0].isError, false);
    const result = await assembler().assemble(transcript.messages, []);
    assert.deepEqual(calls(result.messages), [write]);
    assert.match(result.messages.at(-1)!.content, /report.txt/);
  }
});

test("persisted historical basis reconstructs the same folded failure semantics", () => {
  const input = [...exchange("a"), ...exchange("b")];
  const events = input.map((message, i) => message.role === "assistant"
    ? { seq: i + 2, type: "assistant.committed", data: { ...message } }
    : { seq: i + 2, type: "tool.completed", data: { ...message, result: message.content, invocationStatus: "completed", operationStatus: "failed" } });
  const recovered = reconstructRecoveryTranscript({ userInput: "check", stepId: "s", events: [{ seq: 1, type: "plan.step.started", data: { stepId: "s" } }, ...events] });
  const actual = projectExecutionHistory(recovered.messages);
  assert.equal(actual.mergedExchangeCount, 1);
  assert.deepEqual(calls(actual.messages), calls(input).slice(-1));
  assert.equal(JSON.parse(executionHistoryContext(actual.messages)!).records[0].failureCount, 2);
  assert.equal(JSON.parse(executionHistoryContext(actual.messages)!).records[0].statements[0].text, statement);
});

test("the execution loop repairs from the latest full receipt and delivers the measured value", async () => {
  const executed: unknown[] = [];
  const initialMessages = [{ role: "user" as const, content: "检查 report.json，保留单位；不要推断缺失值。" }, ...exchange("a"), ...exchange("b")];
  const result = await runAgentLoop({ runId: "repair-action", input: initialMessages[0].content, initialMessages,
    systemPrompt: "Use observed state.", maxSteps: 3,
    grant: createCapabilityGrant({ actorUserId: "owner", runId: "repair-action", depth: 0, allowedToolNames: ["inspect"], allowedSkillIds: [] }),
    tools: new ToolRegistry([{ name: "inspect", description: "Read current revision", effect: "read", executionMode: "parallel", replaySafe: true,
      inputSchema: { type: "object", properties: { path: { type: "string" }, revision: { type: "string" } }, required: ["path", "revision"] },
      parse: value => value, execute: async (_context, value) => { executed.push(value); assert.deepEqual(value, { path: "report.json", revision: "r2" }); return { amount: 42, unit: "元/吨" }; } }]),
    model: { limits: model.limits, complete: async request => {
      const receipt = request.messages.findLast(message => message.role === "tool")!;
      assert.ok(request.runtimeContext?.content.includes(statement));
      if (receipt.role === "tool" && receipt.isError) {
        const observed = JSON.parse(receipt.content);
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "repaired", name: "inspect", arguments: { path: "report.json", revision: observed.currentRevision } }] };
      }
      assert.ok(receipt.content.includes("42"));
      return { content: "实测为42元/吨；未推断缺失值。", finishReason: "stop", toolCalls: [] };
    } },
    evaluateCandidate: async candidate => ({ approved: candidate.output.includes("42元/吨"), feedback: "" }),
  });
  assert.equal(executed.length, 1);
  assert.equal(result.output, "实测为42元/吨；未推断缺失值。");
});

test("resumed execution consumes a successful write without executing it again", async () => {
  let writes = 0;
  const write = { id: "saved", name: "save", arguments: { path: "report.txt", content: "complete evidence" } };
  const recovered = reconstructRecoveryTranscript({ userInput: "确认已保存内容，不要再次写入。", stepId: "s", events: [
    { seq: 1, type: "plan.step.started", data: { stepId: "s" } },
    { seq: 2, type: "assistant.committed", data: { content: "我会保留全部证据，尚待确认内容。", toolCalls: [write] } },
    { seq: 3, type: "tool.completed", data: { toolCallId: "saved", result: '{"path":"report.txt","content":"complete evidence","sha256":"saved-hash"}', invocationStatus: "completed", operationStatus: "succeeded" } },
  ] });
  const result = await runAgentLoop({ runId: "resume-write", input: recovered.messages[0].content, initialMessages: recovered.messages,
    initialToolEvidence: recovered.toolEvidence, systemPrompt: "Use receipts.", maxSteps: 2,
    grant: createCapabilityGrant({ actorUserId: "owner", runId: "resume-write", depth: 0, allowedToolNames: ["save"], allowedSkillIds: [] }),
    tools: new ToolRegistry([{ name: "save", description: "Write", effect: "write", executionMode: "exclusive", replaySafe: false,
      inputSchema: { type: "object" }, parse: value => value, execute: async () => { writes++; throw new Error("Must not repeat committed writes"); } }]),
    model: { limits: model.limits, complete: async request => {
      const saved = request.messages.find(message => message.role === "tool" && message.toolCallId === "saved");
      if (!saved) return { content: "", finishReason: "tool_calls", toolCalls: [write] };
      assert.ok(saved.content.includes("complete evidence"));
      assert.ok(request.runtimeContext?.content.includes("尚待确认内容"));
      return { content: "已核对回执：report.txt 保存了 complete evidence。", finishReason: "stop", toolCalls: [] };
    } },
    evaluateCandidate: async () => ({ approved: true, feedback: "" }),
  });
  assert.equal(writes, 0);
  assert.ok(result.output.includes("complete evidence"));
});

test("real non-Data-Agent quota failure fixture preserves independent requests, recovered sources and final caveats", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/execution-history/public-research-recovery.json", import.meta.url), "utf8"));
  const recovered = reconstructRecoveryTranscript(fixture);
  const before = structuredClone(recovered.messages);
  const projected = await assembler().assemble(recovered.messages, []);
  assert.equal(calls(projected.messages).length, 4);
  assert.equal(recovered.toolEvidence.filter(item => item.isError).length, 2);
  assert.equal(recovered.toolEvidence.filter(item => !item.isError).length, 2);
  assert.notDeepEqual(calls(projected.messages)[0].arguments, calls(projected.messages)[1].arguments);
  for (const message of before.filter(message => message.role === "tool")) {
    const value = projected.messages.find(value => value.role === "tool" && value.toolCallId === message.toolCallId)!;
    assert.ok(value);
    if (message.isError) assert.equal(value.content, message.content);
    else {
      const original = JSON.parse(message.content);
      for (const ref of original.evidenceReceipt.sourceRefs) assert.ok(value.content.includes(ref.path));
    }
  }
  assert.ok(projected.messages.some(value => value.content.includes("您所查询的标准系统尚未收录")));
  assert.ok(projected.messages.some(value => value.content.includes("GB/T 17705-1999")), "successful transport of an irrelevant standard must not become task success");
  assert.ok(recovered.facts.candidateOutputs.length > 0);
  assert.deepEqual(recovered.messages, before);
});

for (const mode of ["proactive", "over-budget", "forced"] as const) {
  test(`${mode} compaction preserves original user constraints and receives projected historical provenance`, async () => {
    const events: RuntimeEvent[] = [];
    const constraints = "不允许写入；日期2026-11-22；单位元/吨；必须详细列出证据和局限。";
    let summaryInput = "";
    const summary = ["## Goal", "Check", "## Constraints & Preferences", constraints, "## Progress", "Blocked", "## Evidence", "a,b: current revision r2; source://receipt", "## Next Steps", "Use r2", "## Critical Context", statement].join("\n");
    const instance = assembler({ model: { limits: { contextWindowTokens: mode === "over-budget" ? 12_000 : 128_000, maxOutputTokens: 2_000 },
      complete: async request => { summaryInput += request.messages[0].content; return { content: summary, toolCalls: [], finishReason: "stop" }; } },
      policy: { proactiveCompactionTokens: 2_000, preserveRecentTokens: 1_000, pruneProtectTokens: 1_000 }, emit: event => { events.push(event); } });
    const input: ModelMessage[] = [{ role: "user", content: constraints }, ...exchange("a"), ...exchange("b"),
      { role: "assistant", content: "past non-authoritative draft ".repeat(3_000) }, { role: "user", content: "更正：只检查 r2，不得发布。" },
      ...exchange("current", { args: { revision: "r2" }, content: '{"revision":"r2","amount":42,"unit":"元/吨"}', error: false })];
    const before = structuredClone(input);
    if (mode === "forced") await instance.forceCompactForCompletionRepair(input, []);
    const result = await instance.assemble(input, []);
    assert.ok(events.some(event => event.type === "context.compacted"));
    assert.ok(summaryInput.includes("agentloop.executionHistory/v2"));
    assert.ok(summaryInput.includes("failedAttempts"));
    for (const user of input.filter(message => message.role === "user")) assert.ok(result.messages.some(message => message.content === user.content));
    assert.ok(JSON.stringify(result).includes("元/吨"));
    assert.deepEqual(input, before);
    assert.deepEqual((await instance.assemble(input, [])).messages, result.messages);
  });
}

for (const [Model, kinds] of [[OpenAICompatibleModel, ["openai-compatible", "deepseek", "alibaba", "openai"]], [ResponsesModel, ["openai-compatible", "openai"]]] as const)
  for (const providerKind of kinds) for (const streaming of [false, true]) {
  test(`${Model.name}/${providerKind} ${streaming ? "stream" : "complete"} sends complete projected calls, current receipt and unverified statements`, async () => {
    const originalFetch = globalThis.fetch;
    let sent: any;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(Model === ResponsesModel ? { status: "completed", output_text: "done" }
        : { choices: [{ finish_reason: "stop", message: { content: "done" } }] }), { headers: { "content-type": "application/json" } });
    };
    try {
      const adapter = new Model({ baseUrl: "https://example.test/v1", apiKey: "fixture", model: "fixture", providerKind, contextWindowTokens: 128_000, maxOutputTokens: 4_096, maxAttempts: 1 });
      const assembly = await assembler().assemble([...exchange("a"), ...exchange("b")], []);
      const invocation = { runId: "wire", phase: "execution" as const, systemPrompt: "system", messages: assembly.messages,
        runtimeContext: assembly.runtimeContext, tools: [{ name: "inspect", description: "read", inputSchema: { type: "object", properties: { revision: { type: "string" } } } }] };
      if (streaming) await adapter.streamComplete(invocation, async () => undefined);
      else await adapter.complete(invocation);
      const serialized = JSON.stringify(sent);
      assert.equal(Boolean(sent.stream), streaming || Model === ResponsesModel);
      const assistantContent = Model === ResponsesModel
        ? sent.input.filter((item: any) => item.type === "message" && item.role === "assistant")
        : sent.messages.filter((item: any) => item.role === "assistant").map((item: any) => item.content);
      assert.ok(!JSON.stringify(assistantContent).includes("尚未验证"), "history belongs in server context, not an assistant style example");
      assert.ok(serialized.includes("尚未验证"));
      assert.ok(serialized.includes("currentRevision"));
      assert.ok(serialized.includes("r2"));
      const wireCalls = Model === ResponsesModel ? sent.input.filter((item: any) => item.type === "function_call")
        : sent.messages.flatMap((item: any) => item.tool_calls ?? []);
      assert.equal(wireCalls.length, 1);
      assert.deepEqual(JSON.parse(Model === ResponsesModel ? wireCalls[0].arguments : wireCalls[0].function.arguments), calls(assembly.messages)[0].arguments);
    } finally { globalThis.fetch = originalFetch; }
  });
}
