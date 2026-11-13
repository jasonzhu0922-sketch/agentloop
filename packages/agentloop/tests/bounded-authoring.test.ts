import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { createComputerTools } from "../src/tools/computer-tools.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse, RuntimeEvent } from "../src/runtime/contracts.ts";
import { reconstructRecoveryTranscript } from "../src/runtime/recovery-transcript.ts";
import { boundedAuthoringContext, toolContentBudget } from "../src/runtime/tool-content-budget.ts";

const limits = { contextWindowTokens: 128_000, maxOutputTokens: 16_384 };
const initial = { shrinkCount: 0, consecutiveTruncations: 0 };
const grant = (root?: string, names = ["computer_write_file"]) => createCapabilityGrant({
  actorUserId: "budget-test", runId: "budget-run", depth: 0, workspaceRoot: root,
  allowedToolNames: names, allowedSkillIds: [],
});
const done: ModelResponse = { content: "complete", finishReason: "stop", toolCalls: [] };
function maxContent(request: ModelInvocation): number {
  return ((request.tools.find(tool => tool.name === "computer_write_file")!.inputSchema.properties as any).content as any).maxLength;
}
function writingContext(request: ModelInvocation): any {
  const match = request.runtimeContext!.content.match(/<runtime_bounded_authoring source="server">\n(.*?)\n<\/runtime_bounded_authoring>/s);
  assert.ok(match);
  return JSON.parse(match[1]!);
}

test("per-turn content budgets apply to generic declared tools and preserve static schemas and grants", () => {
  let parsed = 0;
  const tool: RuntimeTool = {
    name: "write_segment", effect: "write", description: "Write a segment", executionMode: "exclusive", replaySafe: false,
    boundedContent: { field: "body", targetField: "resource", continuationInstruction: "Continue the committed resource." },
    inputSchema: { type: "object", properties: { body: { type: "string", maxLength: 48_000 } } },
    parse: input => { parsed++; return input; }, execute: async () => ({}),
  };
  const registry = new ToolRegistry([tool]);
  const scoped = registry.materialize(grant(undefined, [tool.name]), { contentBudget: toolContentBudget(16_384, initial) });
  assert.equal((scoped.definitions[0]!.inputSchema.properties as any).body.maxLength, 4096);
  assert.equal((tool.inputSchema.properties as any).body.maxLength, 48_000);
  assert.throws(() => scoped.prepare({ id: "large", name: tool.name, arguments: { body: "中".repeat(4097) } }), /output budget/);
  assert.equal(parsed, 0, "Over-budget input is rejected before parsing or effects");
  assert.throws(() => scoped.prepare({ id: "overhead", name: tool.name,
    arguments: { body: "中", resource: "中".repeat(4100) } }), /serialized arguments/);
  assert.doesNotThrow(() => scoped.prepare({ id: "small", name: tool.name, arguments: { body: "valid", resource: "doc" } }));
  assert.throws(() => scoped.prepare({ id: "duplicate", name: tool.name, arguments: { body: "more", resource: "doc" } }), /wait for its committed receipt/);
  assert.equal(registry.materialize(grant(undefined, [])).definitions.length, 0);
  assert.equal((registry.materialize(grant(undefined, [tool.name])).definitions[0]!.inputSchema.properties as any).body.maxLength, 48_000);
});

test("bounded append preserves explicit boundary bytes and never invents a separator", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "bounded-boundary-bytes-"));
  try {
    const executor = new ComputerExecutor(root);
    const registry = new ToolRegistry(createComputerTools(executor));
    const chunks = ["甲", "乙", "\n第2段\n", "结尾\n\n"];
    let receipt: any;
    for (const [index, content] of chunks.entries()) {
      const scoped = registry.materialize(grant(root), { contentBudget: toolContentBudget(16_384, initial) });
      const prepared = scoped.prepare({ id: `chunk-${index}`, name: "computer_write_file",
        arguments: { path: "boundaries.txt", content, mode: index === 0 ? "create" : "append" } });
      receipt = await prepared.execute({ grant: grant(root) });
    }
    const expected = Buffer.from("甲乙\n第2段\n结尾\n\n");
    assert.deepEqual(await fs.readFile(join(root, "boundaries.txt")), expected);
    assert.equal(receipt.bytes, expected.length);
    assert.equal(receipt.inspection.tail.content, expected.toString("utf8"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const streaming of [false, true]) {
  test(`${streaming ? "streamed ready" : "ordinary"} oversized calls are rejected before writing`, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "bounded-dispatch-"));
    try {
      let turns = 0;
      const events: RuntimeEvent[] = [];
      const respond = (request: ModelInvocation): ModelResponse => {
        assert.equal(maxContent(request), 4096);
        return ++turns === 1 ? { content: "", finishReason: "tool_calls", toolCalls: [{ id: "oversized",
          name: "computer_write_file", arguments: { path: "doc.txt", content: "中".repeat(5000) } }] } : done;
      };
      const model: ModelAdapter = { limits, complete: async request => respond(request),
        ...(streaming ? { streamComplete: async (request, sink) => {
          const response = respond(request);
          for (const [index, call] of response.toolCalls.entries()) await sink({ type: "tool_call_ready", index, ...call });
          return response;
        } } : {}),
      };
      await runAgentLoop({ runId: "budget-run", systemPrompt: "Write a file", input: "create doc.txt", model,
        tools: new ToolRegistry(createComputerTools(new ComputerExecutor(root))), grant: grant(root), maxSteps: 3,
        emit: event => { events.push(event); } });
      await assert.rejects(fs.stat(join(root, "doc.txt")), { code: "ENOENT" });
      assert.equal(events.some(event => event.type === "tool.dispatched" && event.data.toolCallId === "oversized"), false);
      assert.equal(events.some(event => event.type === "tool.rejected" && /output budget/.test(String(event.data.reason))), true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

test("a later truncated chunk shrinks the budget and continues from real committed bytes", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "bounded-continuation-"));
  try {
    const head = '{"title":"报告","body":"' + "第一部分数据。".repeat(350);
    const tail = "第二部分数据。".repeat(200) + '"}';
    let turns = 0;
    const events: RuntimeEvent[] = [];
    const model: ModelAdapter = { limits, complete: async request => {
      turns++;
      if (turns === 1) {
        assert.equal(maxContent(request), 4096);
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "first", name: "computer_write_file",
          arguments: { path: "report.json", content: head, mode: "create" } }] };
      }
      if (turns === 2) {
        assert.equal(await fs.readFile(join(root, "report.json"), "utf8"), head);
        assert.throws(() => JSON.parse(head), "Intermediate JSON is intentionally incomplete");
        const context = writingContext(request);
        assert.equal(context.committedWrites[0].bytes, Buffer.byteLength(head));
        assert.equal(context.committedWrites[0].tail.content, head.slice(-800));
        return { content: "", finishReason: "length", toolCalls: [{ id: "truncated", name: "computer_write_file",
          arguments: '{"path":"report.json","mode":"append","content":"unfinished' }] };
      }
      if (turns === 3) {
        assert.equal(maxContent(request), 2048);
        assert.equal(writingContext(request).committedWrites[0].toolCallId, "first");
        assert.equal(await fs.readFile(join(root, "report.json"), "utf8"), head);
        assert.match(request.runtimeContext!.content, /next bounded chunk/);
        assert.equal(request.messages.some(message => message.toolCalls?.some(call => call.id === "truncated")), false);
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "tail", name: "computer_write_file",
          arguments: { path: "report.json", content: tail, mode: "append" } }] };
      }
      const content = await fs.readFile(join(root, "report.json"), "utf8");
      assert.equal(content, head + tail);
      assert.equal(JSON.parse(content).title, "报告");
      assert.equal(writingContext(request).committedWrites[0].bytes, Buffer.byteLength(content));
      assert.equal(maxContent(request), 2048, "Successful progress retains the safer chunk ceiling");
      return done;
    } };
    await runAgentLoop({ runId: "budget-run", systemPrompt: "Create complete JSON", input: "create report.json", model,
      tools: new ToolRegistry(createComputerTools(new ComputerExecutor(root))), grant: grant(root), maxSteps: 6,
      emit: event => { events.push(event); } });
    assert.equal(turns, 4);
    assert.deepEqual(events.filter(event => event.type === "tool.completed").map(event => event.data.toolCallId), ["first", "tail"]);
    assert.equal(events.filter(event => event.type === "loop.output_budget.updated").length, 2);
    const budgetCheckpoint = events.findIndex(event => event.type === "loop.output_budget.updated" && event.data.reason === "output_truncated");
    const assistantCheckpoint = events.findIndex(event => event.type === "assistant.committed" && event.data.finishReason === "length");
    assert.ok(budgetCheckpoint >= 0 && assistantCheckpoint > budgetCheckpoint,
      "The smaller budget must be durable before the truncated assistant checkpoint can survive a crash");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("recovery preserves reduced budgets, ResultRefs and committed write continuation without duplicate appends", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "bounded-resume-"));
  try {
    const registry = new ToolRegistry(createComputerTools(new ComputerExecutor(root)));
    const first = registry.materialize(grant(root)).prepare({ id: "first", name: "computer_write_file",
      arguments: { path: "resume.txt", content: "committed\n", mode: "create" } });
    const receipt = await first.execute({ grant: grant(root) });
    const ref = { schema: "agentloop.resultRef/v1", resultId: "rr_11111111-1111-4111-8111-111111111111" };
    const records: RuntimeEvent[] = [
      { type: "plan.step.started", data: { stepId: "step-1" } },
      { type: "assistant.committed", data: { step: 1, toolCalls: [first.call], content: "", finishReason: "tool_calls" } },
      { type: "tool.completed", data: { step: 1, toolCallId: "first", toolName: "computer_write_file", result: JSON.stringify(receipt), isError: false } },
      { type: "tool.result_committed", data: { toolCallId: "first", resultRef: ref } },
      { type: "loop.output_budget.updated", data: { schema: "agentloop.outputBudgetState/v1", shrinkCount: 1, consecutiveTruncations: 1 } },
      { type: "assistant.committed", data: { step: 2, toolCalls: [], content: "", finishReason: "length" } },
    ];
    const recovered = reconstructRecoveryTranscript({ userInput: "continue", stepId: "step-1",
      events: records.map((event, seq) => ({ seq: seq + 1, ...event })) });
    assert.deepEqual(recovered.facts.outputBudgetState, { shrinkCount: 1, consecutiveTruncations: 1 });
    assert.deepEqual(recovered.toolEvidence[0]!.resultRef, ref);
    const projected = boundedAuthoringContext(registry.materialize(grant(root)).boundedContentTools,
      toolContentBudget(16_384, recovered.facts.outputBudgetState!), recovered.facts.outputBudgetState!,
      recovered.toolEvidence);
    assert.deepEqual(JSON.parse(projected!).committedWrites[0].resultRef, ref);
    let turns = 0;
    await runAgentLoop({ runId: "budget-run", systemPrompt: "Continue only missing content", input: "continue", tools: registry,
      grant: grant(root), maxSteps: 3, initialMessages: recovered.messages, initialToolEvidence: recovered.toolEvidence,
      initialOutputBudgetState: recovered.facts.outputBudgetState,
      model: { limits, complete: async request => {
        assert.equal(maxContent(request), 2048);
        assert.equal(writingContext(request).committedWrites[0].target, "resume.txt");
        return ++turns === 1 ? { content: "", finishReason: "tool_calls", toolCalls: [{ id: "append", name: "computer_write_file",
          arguments: { path: "resume.txt", content: "remaining\n", mode: "append" } }] } : done;
      } },
    });
    assert.equal(await fs.readFile(join(root, "resume.txt"), "utf8"), "committed\nremaining\n");
    const crashWindow = reconstructRecoveryTranscript({ userInput: "continue", stepId: "step-1",
      events: records.slice(0, -1).map((event, seq) => ({ seq, ...event })) });
    assert.deepEqual(crashWindow.facts.outputBudgetState, { shrinkCount: 1, consecutiveTruncations: 1 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a completed streamed chunk survives a truncated trailing call and is never replayed", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "bounded-stream-tail-"));
  try {
    let turns = 0;
    const model: ModelAdapter = { limits, complete: async () => { throw new Error("stream required"); },
      streamComplete: async (request, sink) => {
        turns++;
        if (turns === 1) {
          const call = { id: "head", name: "computer_write_file", arguments: { path: "stream.txt", content: "head\n", mode: "create" } };
          await sink({ type: "tool_call_ready", index: 0, ...call });
          return { content: "", finishReason: "length", toolCalls: [call,
            { id: "incomplete", name: "computer_write_file", arguments: '{"path":"stream.txt","content":"unfinished' }] };
        }
        assert.equal(maxContent(request), 2048);
        assert.equal(writingContext(request).recovery.consecutiveTruncations, 0);
        if (turns === 2) {
          assert.equal(await fs.readFile(join(root, "stream.txt"), "utf8"), "head\n");
          assert.equal(request.messages.filter(message => message.role === "tool").length, 1);
          const call = { id: "tail", name: "computer_write_file", arguments: { path: "stream.txt", content: "tail\n", mode: "append" } };
          await sink({ type: "tool_call_ready", index: 0, ...call });
          return { content: "", finishReason: "tool_calls", toolCalls: [call] };
        }
        return done;
      },
    };
    await runAgentLoop({ runId: "budget-run", systemPrompt: "Write the whole file", input: "create stream.txt", model,
      tools: new ToolRegistry(createComputerTools(new ComputerExecutor(root))), grant: grant(root), maxSteps: 4 });
    assert.equal(await fs.readFile(join(root, "stream.txt"), "utf8"), "head\ntail\n");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("changing truncated arguments or producing no call cannot bypass the no-progress budget", async () => {
  for (const hasCalls of [false, true]) {
    let turns = 0;
    const events: RuntimeEvent[] = [];
    const registry = new ToolRegistry([]);
    await assert.rejects(runAgentLoop({ runId: "budget-run", systemPrompt: "complete", input: "create", tools: registry,
      grant: grant(undefined, []), maxSteps: 20, candidateRepairGraceSteps: 4, deferFailureReport: true,
      emit: event => { events.push(event); }, model: { limits, complete: async () => {
        turns++;
        return { content: "", finishReason: "length", toolCalls: hasCalls ? [{ id: `call-${turns}`, name: `changing-${turns}`,
          arguments: "different".repeat(turns) }] : [] };
      } },
    }), (error: any) => error.code === "RUN_LIMIT_EXCEEDED");
    assert.equal(turns, 3);
    assert.equal(events.filter(event => event.type === "loop.output_budget.updated").length, 3);
  }
});
