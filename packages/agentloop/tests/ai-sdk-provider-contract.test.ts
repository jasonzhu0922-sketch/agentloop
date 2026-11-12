import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AppError } from "../src/shared/errors.ts";
import { InMemoryResponsesReasoningContinuationStore, OpenAICompatibleModel, ResponsesModel } from "../src/runtime/models.ts";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import type { ModelInvocation, ModelStreamEvent } from "../src/runtime/contracts.ts";

const settings = { baseUrl: "https://provider.example.test/v1", apiKey: "private-provider-key", model: "custom-proxy-model", contextWindowTokens: 128_000, maxOutputTokens: 4096, retryDelayMs: 0 };
const invocation: ModelInvocation = {
  runId: "sdk-contract-run", systemPrompt: "Use observed evidence", phase: "execution",
  messages: [{ role: "user", content: "Look up evidence" }],
  tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }, strict: true }],
};
const sse = (...events: unknown[]) => events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const response = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream", "x-request-id": "sdk-contract-request" } });

test("a committed script write reaches the next provider request as the original call and matching success result", async () => {
  const previous = globalThis.fetch;
  const content = '# -*- coding: utf-8 -*-\n' + '# 游戏介绍演示文稿\n'.repeat(2_000) + 'print("ready")\n';
  const originalCall = { id: "call-write-script", name: "computer_write_file", arguments: { path: "make_spec.py", content, mode: "create" } };
  let sent: any;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "observed" } }] }),
      { headers: { "content-type": "application/json" } });
  };
  try {
    const model = new OpenAICompatibleModel({ ...settings, contextWindowTokens: 64_000 });
    const assembler = new ContextAssembler({ runId: "write-then-execute", systemPrompt: "Create and execute the requested script.",
      runtimeContext: { phase: "execution", content: "Task in progress" }, model });
    const toolResult = JSON.stringify({ path: "make_spec.py", sha256: "script-hash", bytes: Buffer.byteLength(content),
      resultRef: { schema: "agentloop.resultRef/v1", resultId: "rr_11111111-1111-4111-8111-111111111111" },
      artifactReceipt: { schema: "agentloop.artifactReceipt/v1", receiptId: "artifact:script", sourceTool: "computer_write_file",
        artifact: { path: "make_spec.py", sha256: "script-hash", bytes: Buffer.byteLength(content) },
        evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "artifact_integrity"], caveated: [], failed: [] } } });
    const canonical: ModelInvocation["messages"] = [
      { role: "user", content: "Create the presentation, then build it." },
      { role: "assistant", content: "", toolCalls: [originalCall] },
      { role: "tool", name: "computer_write_file", toolCallId: originalCall.id, content: toolResult, isError: false },
    ];
    const assembly = await assembler.assemble(canonical, []);
    await model.complete({ ...invocation, messages: assembly.messages, runtimeContext: assembly.runtimeContext });
    const write = sent.messages.find((message: any) => message.role === "assistant" && message.tool_calls?.some((call: any) => call.id === originalCall.id));
    assert.ok(write, "the provider must see its own completed write in the chronological transcript");
    assert.deepEqual(JSON.parse(write.tool_calls[0].function.arguments), originalCall.arguments);
    const receipt = sent.messages[sent.messages.indexOf(write) + 1];
    assert.equal(receipt.role, "tool");
    assert.equal(receipt.tool_call_id, originalCall.id);
    assert.match(receipt.content, /script-hash/);
    assert.match(receipt.content, /"state":"committed"/);
    assert.match(receipt.content, /rr_11111111-1111-4111-8111-111111111111/);
    assert.deepEqual(canonical[1], { role: "assistant", content: "", toolCalls: [originalCall] });
  } finally { globalThis.fetch = previous; }
});

test("well-formed streams with visible protocol residue retain exact raw evidence without executing or stripping it", async () => {
  const previous = globalThis.fetch;
  try {
    for (const content of [
      '｜DSML｜ invoke name="computer_run_command"',
      '<｜begin▁of▁sentence｜># Validation protect',
      '<ds_safety>[分类]其他</ds_safety>',
    ]) {
      const raw = sse(chunk({ role: "assistant", content }, "stop"), "[DONE]");
      let captured: any;
      globalThis.fetch = async () => response(raw);
      const result = await new OpenAICompatibleModel({ ...settings, streamRawCaptureWriter: async input => {
        captured = input;
        return { schema: "agentloop.modelStreamRawCaptureRef/v1", ref: "private-anomalous-content",
          capturedBytes: input.rawSse.byteLength, rawBytes: input.rawBytes, rawSha256: input.rawSha256, truncated: input.truncated };
      } }).streamComplete(invocation, () => undefined);
      assert.equal(result.content, content);
      assert.deepEqual(result.toolCalls, []);
      assert.equal(result.finishReason, "stop");
      assert.deepEqual(result.streamReceipt?.anomalyReasons, ["provider_protocol_text_in_content"]);
      assert.equal(result.streamReceipt?.rawCapture?.ref, "private-anomalous-content");
      assert.equal(Buffer.from(captured.rawSse).toString(), raw);
      assert.equal(result.streamReceipt?.rawSha256, createHash("sha256").update(raw).digest("hex"));
    }
  } finally { globalThis.fetch = previous; }
});

test("ordinary content mentioning protocol names does not cause raw capture", async () => {
  const previous = globalThis.fetch;
  let captures = 0;
  globalThis.fetch = async () => response(sse(chunk({ content: "DSML and safety classification are protocol concepts. The total is 140." }, "stop"), "[DONE]"));
  try {
    const result = await new OpenAICompatibleModel({ ...settings, streamRawCaptureWriter: async () => {
      captures += 1;
      throw new Error("must not capture ordinary content");
    } }).streamComplete(invocation, () => undefined);
    assert.deepEqual(result.streamReceipt?.anomalyReasons, []);
    assert.equal(captures, 0);
  } finally { globalThis.fetch = previous; }
});

test("SDK migration preserves opaque Responses schemas including constraints OpenAI would remove", async () => {
  const previous = globalThis.fetch;
  const schema = { type: "object", propertyNames: true, properties: { q: { type: "string", pattern: "^(?!bad).*$" } }, required: ["q"], additionalProperties: false };
  let sent: any;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ status: "completed", output_text: "done" }), { headers: { "content-type": "application/json" } });
  };
  try {
    const model = new ResponsesModel({ ...settings, reasoningEffort: "high", providerParameters: { custom_extension: { preserve: true } } });
    const result = await model.complete({ ...invocation, tools: [{ ...invocation.tools[0], inputSchema: schema }] });
    assert.equal(result.content, "done");
    assert.deepEqual(sent.tools[0].parameters, schema);
    assert.deepEqual(sent.reasoning, { effort: "high" });
    assert.deepEqual(sent.custom_extension, { preserve: true });
    assert.equal(sent.temperature, undefined);
    assert.equal(sent.top_p, undefined);
  } finally { globalThis.fetch = previous; }
});

test("SDK transport preserves original stream bytes while canonicalizing object tool arguments", async () => {
  const previous = globalThis.fetch;
  const raw = sse(chunk({ tool_calls: [{ index: 0, id: "call-object", function: { name: "lookup", arguments: { q: "evidence" } } }] }, "tool_calls"), "[DONE]");
  globalThis.fetch = async () => response(raw);
  const events: ModelStreamEvent[] = [];
  try {
    const result = await new OpenAICompatibleModel(settings).streamComplete(invocation, event => { events.push(event); });
    assert.deepEqual(result.toolCalls, [{ id: "call-object", name: "lookup", arguments: { q: "evidence" } }]);
    assert.equal(result.streamReceipt?.rawBytes, Buffer.byteLength(raw));
    assert.equal(result.streamReceipt?.rawSha256, createHash("sha256").update(raw).digest("hex"));
    assert.equal(result.streamReceipt?.doneEventCount, 1);
    assert.equal(events.filter(event => event.type === "tool_call_ready").length, 1);
  } finally { globalThis.fetch = previous; }
});

test("truncated Chat tool stream never authorizes execution or replays partial output", async () => {
  const previous = globalThis.fetch;
  let attempts = 0;
  const events: ModelStreamEvent[] = [];
  globalThis.fetch = async () => { attempts += 1; return response(sse(chunk({ tool_calls: [{ index: 0, id: "call-partial", function: { name: "lookup", arguments: '{"q":"evidence"}' } }] }))); };
  try {
    await assert.rejects(() => new OpenAICompatibleModel(settings).streamComplete(invocation, event => { events.push(event); }), error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.streamFailureStage, "missing_terminal_event");
      assert.equal((error.details?.streamReceipt as any)?.sinkEmissionObserved, true);
      return true;
    });
    assert.equal(attempts, 1);
    assert.equal(events.some(event => event.type === "tool_call_delta"), true);
    assert.equal(events.some(event => event.type === "tool_call_ready"), false);
  } finally { globalThis.fetch = previous; }
});

test("provider-generated Chat call identity cannot authorize a tool without a native id", async () => {
  const previous = globalThis.fetch;
  const events: ModelStreamEvent[] = [];
  globalThis.fetch = async () => response(sse(chunk({ tool_calls: [{ index: 0, function: { name: "lookup", arguments: '{"q":"evidence"}' } }] }, "tool_calls")));
  try {
    await assert.rejects(() => new OpenAICompatibleModel({ ...settings, maxAttempts: 1 }).streamComplete(invocation, event => { events.push(event); }));
    assert.equal(events.some(event => event.type === "tool_call_ready"), false);
  } finally { globalThis.fetch = previous; }
});

test("SDK expansion of an undeclared parallel wrapper preserves the original Runtime intent", async () => {
  const previous = globalThis.fetch;
  const input = { tool_uses: [{ recipient_name: "functions.lookup", parameters: { q: "evidence" } }] };
  const item = { type: "function_call", id: "fc-wrapper", call_id: "call-wrapper", name: "parallel", arguments: JSON.stringify(input) };
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return response(sse(
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [item] } },
    ));
  };
  const events: ModelStreamEvent[] = [];
  try {
    const result = await new ResponsesModel(settings).streamComplete(invocation, event => { events.push(event); });
    assert.equal(requests, 1);
    assert.deepEqual(result.toolCalls, [{ id: "call-wrapper", name: "parallel", arguments: input }]);
    assert.deepEqual(events.filter(event => event.type === "tool_call_ready").map(event => event.name), ["parallel"]);
    assert.equal(events.some(event => event.type === "tool_call_delta" && event.name === "lookup"), false);
  } finally { globalThis.fetch = previous; }
});

test("Responses JSON received for a streaming request is decoded from the same response", async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ id: "json-envelope", status: "completed", output: [{ type: "function_call", call_id: "call-json", name: "lookup", arguments: '{"q":"evidence"}' }] }), { headers: { "content-type": "application/json", "x-request-id": "json-request" } });
  };
  try {
    const result = await new ResponsesModel(settings).streamComplete(invocation, () => undefined);
    assert.equal(requests, 1);
    assert.equal(result.providerResponseId, "json-envelope");
    assert.equal(result.providerRequestId, "json-request");
    assert.deepEqual(result.toolCalls[0].arguments, { q: "evidence" });
  } finally { globalThis.fetch = previous; }
});

test("unknown response events retain raw evidence while SDK decodes known content", async () => {
  const previous = globalThis.fetch;
  const raw = sse(
    { type: "response.future_unknown_event", delta: "uninterpreted" },
    { type: "response.output_text.delta", delta: "known" },
    { type: "response.completed", response: { status: "completed", output_text: "known" } },
  );
  let captured: any;
  globalThis.fetch = async () => response(raw);
  try {
    const result = await new ResponsesModel({ ...settings, streamRawCaptureWriter: async input => {
      captured = input;
      return { schema: "agentloop.modelStreamRawCaptureRef/v1", ref: "private-capture", capturedBytes: input.rawSse.byteLength,
        rawBytes: input.rawBytes, rawSha256: input.rawSha256, truncated: input.truncated };
    } }).streamComplete(invocation, () => undefined);
    assert.equal(result.content, "known");
    assert.equal(result.streamReceipt?.unrecognizedJsonEventCount, 1);
    assert.ok(result.streamReceipt?.anomalyReasons.includes("unrecognized_json_event"));
    assert.equal(Buffer.from(captured.rawSse).toString(), raw);
  } finally { globalThis.fetch = previous; }
});

test("post-stream continuation rejection preserves its error and original stream receipt", async () => {
  const previous = globalThis.fetch;
  const raw = sse({ type: "response.completed", response: { status: "completed", output: [
    { type: "reasoning", id: "private-item", encrypted_content: "x".repeat(257 * 1024), summary: [] },
    { type: "message", content: [{ type: "output_text", text: "done" }] },
  ] } });
  globalThis.fetch = async () => response(raw);
  try {
    const model = new ResponsesModel({ ...settings, maxAttempts: 1, reasoningEncryptedContent: true,
      reasoningContinuationStore: new InMemoryResponsesReasoningContinuationStore() });
    await assert.rejects(() => model.streamComplete(invocation, () => undefined), error => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /reasoning continuation exceeded/);
      assert.equal((error.details?.streamReceipt as any)?.rawSha256, createHash("sha256").update(raw).digest("hex"));
      return true;
    });
  } finally { globalThis.fetch = previous; }
});

test("stream idle timeout retains receipt and never retries after a visible delta", async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  const events: ModelStreamEvent[] = [];
  globalThis.fetch = async (_url, init) => {
    requests += 1;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse(chunk({ content: "partial" }))));
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  // Runtime timeout timers are unref'd, as in production. Keep the test alive.
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(() => new OpenAICompatibleModel({ ...settings, timeoutMs: 20 }).streamComplete(invocation, event => { events.push(event); }), error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.abortReason, "stream_idle_timeout");
      assert.equal((error.details?.streamReceipt as any)?.sinkEmissionObserved, true);
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(events.some(event => event.type === "text_delta"), true);
  } finally { clearTimeout(keepAlive); globalThis.fetch = previous; }
});

test("reflected provider credentials are redacted in HTTP failures and retry telemetry", async () => {
  const previous = globalThis.fetch;
  const retries: unknown[] = [];
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ error: { message: `invalid credential: ${settings.apiKey}` } }), { status: 429, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(() => new OpenAICompatibleModel({ ...settings, maxAttempts: 2, onRetry: info => { retries.push(info); } }).complete(invocation), error => {
      assert.equal(JSON.stringify(error).includes(settings.apiKey), false);
      assert.ok(JSON.stringify(error).includes("[REDACTED]"));
      return true;
    });
    assert.equal(requests, 2);
    assert.equal(retries.length, 1);
    assert.equal(JSON.stringify(retries).includes(settings.apiKey), false);
  } finally { globalThis.fetch = previous; }
});
