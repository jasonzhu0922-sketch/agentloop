import { createParser } from "eventsource-parser";
import { AppError } from "../shared/errors.ts";
import type { ModelInvocation, ModelRequestLogContext, ModelStreamRawCaptureWriter } from "./contracts.ts";
import * as policy from "./model-provider-policy.ts";

type RecordValue = Record<string, any>;
export type ProviderProtocol = "chat-completions" | "responses";

// Enumerate observed lifecycle/output events so a future or malformed
// response.* event still produces diagnostic evidence rather than disappearing.
const RESPONSE_EVENTS = new Set([
  "error", "response.created", "response.in_progress", "response.completed",
  "response.incomplete", "response.failed", "response.output_item.added",
  "response.output_item.done", "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done", "response.output_text.annotation.added",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.refusal.delta", "response.refusal.done",
]);

/** One attempt, one upstream response. Raw evidence is recorded before normalization. */
export class ProviderTransport {
  response?: Response;
  jsonPayload?: RecordValue;
  terminal?: RecordValue;
  failure?: unknown;
  diagnostics: policy.StreamFailureDiagnostics = {
    eventsSeen: 0, hadSinkEmission: false, readChunkCount: 0, sseEventCount: 0,
    jsonEventCount: 0, nonJsonEventCount: 0, doneEventCount: 0,
    unrecognizedJsonEventCount: 0, unterminatedFinalEventBytes: 0,
    finishReasonObserved: false, observedDeltaFields: new Set(),
  };
  collector?: ReturnType<typeof policy.createStreamReceiptCollector>;
  private readonly outputIndexes = new Map<string, number>();

  readonly options: {
    protocol: ProviderProtocol;
    sdkReasoning?: boolean;
    invocation: ModelInvocation;
    request: ModelRequestLogContext;
    apiKey: string;
    model: string;
    budget: policy.ModelResponseBudget;
    parameters: Readonly<Record<string, unknown>>;
    recordActivity(): void;
    writer?: ModelStreamRawCaptureWriter;
    continuation?: readonly Record<string, unknown>[];
    reasoning?: { effort?: string; summary?: string };
  };
  constructor(options: ProviderTransport["options"]) { this.options = options; }

  /** SDK uses this fetch; it neither owns retries nor receives an unbounded tee. */
  fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const body = JSON.parse(String(init?.body)) as RecordValue;
      const wire = { ...this.options.parameters, ...body };
      // The registry owns these fields, even when the SDK omits an empty list.
      wire.tools = (body.tools ?? []).map((encoded: RecordValue) => {
        const fn = this.options.protocol === "responses" ? encoded : encoded.function;
        const source = this.options.invocation.tools.find(tool => tool.name === fn.name);
        if (!source) throw new AppError("MODEL_ERROR", "SDK encoded an undeclared model tool", 502);
        // Treat external JSON Schema as opaque. OpenAI-specific schema rewriting
        // is not valid for every Responses-compatible server.
        const restored = { ...fn, parameters: source.inputSchema };
        if (source.strict === undefined) delete restored.strict;
        else restored.strict = source.strict;
        return this.options.protocol === "responses" ? restored : { ...encoded, function: restored };
      });
      if (this.options.protocol === "responses") {
        delete wire.temperature;
        delete wire.top_p;
        // Explicit server configuration is authoritative. The OpenAI catalog
        // may otherwise remove an effort or add a default summary for a proxy.
        if (!this.options.sdkReasoning) {
          if (this.options.reasoning) wire.reasoning = this.options.reasoning;
          else delete wire.reasoning;
        }
        wire.input = (body.input ?? []).map((item: RecordValue) => {
          // A generic Responses server may require the opaque item itself.
          // Replaying its original envelope does not change remote store policy.
          if (item.type === "item_reference") return this.options.continuation?.find(saved => saved.id === item.id) ?? item;
          if (!item.role) return item;
          return { type: "message", ...item, content: typeof item.content === "string"
            ? [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.content }] : item.content };
        });
      }
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      this.response = await fetch(url, { ...init, headers, body: JSON.stringify(wire) });
      const response = this.response;
      if (!response.ok) throw await policy.providerHttpError(response, this.options.request, this.options.apiKey);
      if (policy.isJsonResponse(response) || !this.options.request.stream) {
        const payload = await policy.readJsonResponseWithinLimit(response, this.options.budget);
        this.assertProtocol(payload);
        this.jsonPayload = payload as RecordValue;
        const normalized = normalizeJsonPayload(payload as RecordValue, this.options.protocol);
        if (this.options.request.stream) {
          // Select the decoder for the received representation, without replaying
          // the upstream request. The adapter will decode this same envelope.
          throw new JsonProviderResponse();
        }
        return new Response(JSON.stringify(normalized), { status: response.status, headers: response.headers });
      }
      return this.observeStream(response);
    } catch (error) {
      this.failure = error;
      throw error;
    }
  };

  private assertProtocol(payload: unknown): void {
    if (this.options.protocol === "responses") policy.assertResponsesPayload(payload);
    else policy.assertChatCompletionsPayload(payload);
  }

  private observeStream(response: Response): Response {
    if (!response.body) throw new AppError("MODEL_ERROR", "Model provider returned no streaming body", 502);
    this.collector = policy.createStreamReceiptCollector({
      response, runId: this.options.invocation.runId, request: this.options.request,
      diagnostics: this.diagnostics, writer: this.options.writer,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pendingFrame = "";
    let ended = false;
    let released = false;
    let output: string[] = [];
    const release = () => { if (!released) { released = true; reader.releaseLock(); } };
    const parser = createParser({
      maxBufferSize: this.options.budget.maxResponseBytes,
      onError: error => {
        if (error.type === "max-buffer-size-exceeded") this.options.budget.assertEventBytes("x".repeat(this.options.budget.maxResponseBytes + 1));
      },
      onEvent: event => {
        this.diagnostics.sseEventCount += 1;
        this.diagnostics.eventsSeen += 1;
        this.diagnostics.lastEvent = policy.summarizeStreamEvent(event.data);
        if (event.data.trim() === "[DONE]") {
          this.diagnostics.doneEventCount += 1;
          output.push("data: [DONE]\n\n");
          return;
        }
        this.options.budget.assertEventBytes(event.data);
        let payload: RecordValue;
        try { payload = JSON.parse(event.data); }
        catch { this.diagnostics.nonJsonEventCount += 1; return; }
        this.diagnostics.jsonEventCount += 1;
        this.assertProtocol(payload);
        this.observePayload(payload);
        if (this.options.protocol === "responses" && payload.type === "error") {
          const nested = payload.error && typeof payload.error === "object" ? payload.error : {};
          const reason = policy.boundedProviderErrorText(nested.message ?? payload.message ?? payload.error, this.options.apiKey, 500);
          throw new AppError("MODEL_ERROR", reason ? `Responses Provider error: ${reason.slice(0, 200)}` : "Responses Provider returned an error event", 502, {
            streamFailureStage: "provider_error_event", streamEventsSeen: this.diagnostics.eventsSeen,
            lastStreamEvent: this.diagnostics.lastEvent, request: this.options.request,
            ...(reason ? { providerErrorMessage: reason } : {}),
            ...(typeof (nested.code ?? payload.code) === "string" ? { providerErrorCode: policy.boundedProviderErrorText(nested.code ?? payload.code, this.options.apiKey, 120) } : {}),
            ...(typeof nested.type === "string" ? { providerErrorType: policy.boundedProviderErrorText(nested.type, this.options.apiKey, 120) } : {}),
          });
        }
        const normalized = this.options.protocol === "responses" ? this.normalizeResponseEvent(payload) : normalizeChatPayload(payload, true);
        output.push(`data: ${JSON.stringify(normalized)}\n\n`);
      },
    });
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          while (!ended && output.length === 0) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try { next = await reader.read(); }
            catch (error) { throw new policy.StreamConsumptionError("read", error, this.diagnostics); }
            if (next.done) {
              ended = true;
              const finalText = decoder.decode();
              pendingFrame += finalText;
              parser.feed(finalText);
              if (pendingFrame.trim()) {
                this.diagnostics.unterminatedFinalEventBytes = Buffer.byteLength(pendingFrame);
                // Preserve the current final-event contract. Raw evidence still
                // records that the upstream omitted the SSE delimiter.
                parser.feed("\n\n");
              }
              if (this.options.protocol === "chat-completions" && !this.diagnostics.finishReasonObserved) {
                throw new AppError("MODEL_ERROR", "Chat Completions Provider stream ended without a terminal response event", 502, {
                  streamFailureStage: "missing_terminal_event", request: this.options.request,
                  streamEventsSeen: this.diagnostics.eventsSeen, lastStreamEvent: this.diagnostics.lastEvent,
                });
              }
              release();
              break;
            }
            this.diagnostics.readChunkCount += 1;
            this.collector!.recordChunk(next.value);
            this.options.recordActivity();
            const text = decoder.decode(next.value, { stream: true });
            pendingFrame = (pendingFrame + text).replaceAll("\r\n", "\n");
            const boundary = pendingFrame.lastIndexOf("\n\n");
            if (boundary >= 0) pendingFrame = pendingFrame.slice(boundary + 2);
            this.options.budget.assertEventBytes(pendingFrame);
            parser.feed(text);
          }
          if (output.length) { const chunk = output.join(""); output = []; controller.enqueue(encoder.encode(chunk)); }
          if (ended) controller.close();
        } catch (error) {
          this.failure = error;
          await reader.cancel().catch(() => undefined);
          release();
          controller.error(error);
        }
      },
      cancel: async reason => { ended = true; try { await reader.cancel(reason); } finally { release(); } },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, headers: response.headers });
  }

  private observePayload(payload: RecordValue): void {
    const d = this.diagnostics;
    const id = this.options.protocol === "responses" ? payload.response?.id : payload.id;
    if (typeof id === "string" && id) d.providerResponseId = id;
    if (this.options.protocol === "responses") {
      const type = payload.type;
      if (["response.completed", "response.incomplete", "response.failed"].includes(type)) {
        d.finishReasonObserved = true;
        this.terminal = payload.response;
      }
      if (type === "response.output_text.delta") d.observedDeltaFields.add("content");
      if (type === "response.reasoning_summary_text.delta") d.observedDeltaFields.add("reasoning_content");
      if (type === "response.function_call_arguments.delta") d.observedDeltaFields.add("tool_calls");
      if (!RESPONSE_EVENTS.has(type)) d.unrecognizedJsonEventCount += 1;
    } else {
      const choice = payload.choices?.[0];
      for (const field of Object.keys(choice?.delta ?? {})) d.observedDeltaFields.add(field);
      if (choice?.finish_reason != null) d.finishReasonObserved = true;
      if (!choice?.finish_reason && !payload.usage && !Object.values(choice?.delta ?? {}).some(Boolean)) d.unrecognizedJsonEventCount += 1;
    }
  }

  private normalizeResponseEvent(payload: RecordValue): RecordValue {
    const result = { ...payload };
    const item = payload.item;
    if (item?.id) this.outputIndexes.set(item.id, payload.output_index ?? this.outputIndexes.get(item.id) ?? this.outputIndexes.size);
    if (item) result.item = normalizeResponseItem(item, payload.output_index ?? 0);
    if (typeof payload.type === "string" && /(?:output_item|function_call_arguments)\./u.test(payload.type)) {
      result.output_index ??= this.outputIndexes.get(item?.id ?? payload.item_id) ?? 0;
    }
    if (payload.type === "response.function_call_arguments.done") result.arguments = wireArguments(payload.arguments ?? "");
    if (payload.type === "response.output_text.delta") result.item_id ??= "agentloop-text";
    if (payload.type === "response.reasoning_summary_text.delta") {
      result.item_id ??= "agentloop-reasoning";
      result.summary_index ??= 0;
    }
    if (["response.created", "response.in_progress"].includes(payload.type)) {
      result.response = { created_at: 0, model: this.options.model, ...payload.response, id: payload.response?.id ?? "" };
    }
    if (payload.type === "response.failed") result.sequence_number ??= this.diagnostics.eventsSeen;
    return result;
  }
}

export class JsonProviderResponse extends Error {}

function wireArguments(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }

function normalizeChatPayload(payload: RecordValue, stream: boolean): RecordValue {
  return { ...payload, choices: payload.choices?.map((choice: RecordValue, index: number) => {
    const key = stream ? "delta" : "message";
    const message = choice[key];
    return { ...choice, index: choice.index ?? index, ...(message ? { [key]: {
      ...message,
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call: RecordValue) => ({
        ...call, type: call.type ?? "function",
        ...(call.function ? { function: { ...call.function,
          ...(call.function.arguments != null ? { arguments: wireArguments(call.function.arguments) } : {}) } } : {}),
      })) } : {}),
    } } : {}) };
  }) };
}

function normalizeResponseItem(item: RecordValue, index: number): RecordValue {
  if (item.type === "message") return { role: "assistant", id: `agentloop-message-${index}`, ...item, content: item.content?.map((part: RecordValue) => part.type === "output_text" ? { annotations: [], ...part } : part) ?? [] };
  if (item.type === "reasoning") return { id: `agentloop-reasoning-${index}`, summary: [], ...item };
  if (item.type === "function_call") return { status: "completed", id: `agentloop-function-${index}`, ...item, arguments: wireArguments(item.arguments ?? "") };
  return item;
}

/** Representation normalization only; generated content is decoded by the SDK. */
export function normalizeJsonPayload(payload: RecordValue, protocol: ProviderProtocol): RecordValue {
  if (protocol === "chat-completions") return normalizeChatPayload(payload, false);
  const output = (payload.output ?? []).map(normalizeResponseItem);
  if (typeof payload.output_text === "string" && !output.some((item: RecordValue) => item.type === "message")) {
    output.push(normalizeResponseItem({ type: "message", content: [{ type: "output_text", text: payload.output_text }] }, output.length));
  }
  return { ...payload, output };
}
