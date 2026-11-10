import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AppError } from "../shared/errors.ts";
import type { ModelAdapter, ModelInvocation, ModelRequestLogContext, ModelResponse, ModelRetryReporter, ModelStreamRawCaptureWriter, ModelStreamSink, ModelToolCall } from "./contracts.ts";
import { encodeOpenAICompatiblePrompt, type RuntimeContextPlacement } from "./prompt-protocol.ts";
import { type OpenAICompatibleModelOptions, type ResponsesReasoningContinuationStore } from "./model-provider-options.ts";
import { ProviderTransport, JsonProviderResponse, normalizeJsonPayload, type ProviderProtocol } from "./model-provider-transport.ts";
import * as policy from "./model-provider-policy.ts";
export { InMemoryResponsesReasoningContinuationStore } from "./model-provider-options.ts";
export type { OpenAICompatibleModelOptions, ResponsesReasoningContinuationStore } from "./model-provider-options.ts";

class AiSdkModel implements ModelAdapter {
  readonly limits: Readonly<{ contextWindowTokens: number; maxOutputTokens: number }>;
  readonly completeTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly reasoningVisibility: "visible" | "hidden";
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly toolChoiceMode: "native" | "constrained-as-auto" | "named-as-required";
  private readonly runtimeContextPlacement: RuntimeContextPlacement;
  private readonly reasoningSummary?: "auto" | "detailed";
  private readonly temperature?: number;
  private readonly topP?: number;
  private readonly reasoningEffort?: "none" | "low" | "medium" | "high";
  private readonly thinkingMode?: "enabled" | "disabled";
  private readonly enableThinking?: boolean;
  private readonly thinkingEffort?: "low" | "medium" | "high";
  private readonly planningThinkingMode?: "enabled" | "disabled";
  private readonly chatTemplateKwargs?: Readonly<Record<string, unknown>>;
  private readonly providerParameters: Readonly<Record<string, unknown>>;
  private readonly onRetry?: ModelRetryReporter;
  private readonly streamRawCaptureWriter?: ModelStreamRawCaptureWriter;

  private readonly reasoningEncryptedContent: boolean;
  private readonly reasoningContinuationStore?: ResponsesReasoningContinuationStore;
  private readonly reasoningContinuationScope: string;
  private readonly protocol: ProviderProtocol;
  constructor(options: OpenAICompatibleModelOptions, protocol: ProviderProtocol) {
    this.protocol = protocol;
    const base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new TypeError("LLM base URL must use http or https");
    }
    this.endpoint = new URL(protocol === "responses" ? "responses" : "chat/completions", base);
    this.apiKey = options.apiKey;
    this.model = options.model;
    if (!Number.isSafeInteger(options.contextWindowTokens) || options.contextWindowTokens < 4_096) {
      throw new TypeError("LLM context window must be an integer of at least 4096 tokens");
    }
    if (
      !Number.isSafeInteger(options.maxOutputTokens)
      || options.maxOutputTokens < 1
      || options.maxOutputTokens >= options.contextWindowTokens
    ) {
      throw new TypeError("LLM max output must be a positive integer smaller than its context window");
    }
    this.limits = {
      contextWindowTokens: options.contextWindowTokens,
      maxOutputTokens: options.maxOutputTokens,
    };
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.completeTimeoutMs = this.timeoutMs;
    this.operationTimeoutMs = policy.streamOperationTimeoutMs(this.timeoutMs);
    this.reasoningVisibility = options.reasoningVisibility ?? "visible";
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.toolChoiceMode = options.toolChoiceMode ?? "native";
    this.runtimeContextPlacement = options.runtimeContextPlacement ?? "system";
    this.reasoningSummary = options.reasoningSummary;
    this.reasoningEncryptedContent = options.reasoningEncryptedContent ?? false;
    this.reasoningContinuationStore = options.reasoningContinuationStore;
    this.reasoningContinuationScope = options.reasoningContinuationScope ?? this.model;
    if (this.reasoningEncryptedContent && !this.reasoningContinuationStore) throw new TypeError("Responses encrypted reasoning requires an adapter-owned continuation store");
    for (const [name, value, max] of [["temperature", options.temperature, 2], ["topP", options.topP, 1]] as const) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)) {
        throw new TypeError(`LLM ${name} must be a number between 0 and ${max}`);
      }
    }
    this.temperature = options.temperature;
    this.topP = options.topP;
    this.reasoningEffort = options.reasoningEffort;
    this.thinkingMode = options.thinkingMode;
    this.enableThinking = options.enableThinking;
    this.thinkingEffort = options.thinkingEffort;
    this.planningThinkingMode = options.planningThinkingMode;
    this.chatTemplateKwargs = options.chatTemplateKwargs;
    this.providerParameters = options.providerParameters ?? {};
    this.onRetry = options.onRetry;
    this.streamRawCaptureWriter = options.streamRawCaptureWriter;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 5) {
      throw new TypeError("LLM max attempts must be an integer between 1 and 5");
    }
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0 || this.retryDelayMs > 30_000) {
      throw new TypeError("LLM retry delay must be an integer between 0 and 30000 milliseconds");
    }
    if (
      this.toolChoiceMode !== "native"
      && this.toolChoiceMode !== "constrained-as-auto"
      && this.toolChoiceMode !== "named-as-required"
    ) {
      throw new TypeError("LLM tool choice mode must be native, constrained-as-auto, or named-as-required");
    }
    if (this.runtimeContextPlacement !== "system" && this.runtimeContextPlacement !== "user-envelope") {
      throw new TypeError("runtime context placement must be system or user-envelope");
    }
    if (this.reasoningSummary !== undefined && this.reasoningSummary !== "auto" && this.reasoningSummary !== "detailed") {
      throw new TypeError("reasoning summary must be auto or detailed");
    }
    if (
      this.reasoningEffort !== undefined
      && this.reasoningEffort !== "none"
      && this.reasoningEffort !== "low"
      && this.reasoningEffort !== "medium"
      && this.reasoningEffort !== "high"
    ) {
      throw new TypeError("reasoning effort must be none, low, medium, or high");
    }
    if (protocol === "chat-completions" && this.reasoningEffort !== undefined && this.reasoningEffort !== "none") {
      throw new TypeError("Chat Completions reasoning effort must be none; low, medium, and high require Responses");
    }
    if (this.thinkingMode !== undefined && this.thinkingMode !== "enabled" && this.thinkingMode !== "disabled") {
      throw new TypeError("thinking mode must be enabled or disabled");
    }
    if (
      this.thinkingEffort !== undefined
      && this.thinkingEffort !== "low"
      && this.thinkingEffort !== "medium"
      && this.thinkingEffort !== "high"
    ) {
      throw new TypeError("thinking effort must be low, medium, or high");
    }
    if (this.thinkingEffort !== undefined && this.thinkingMode === "disabled") {
      throw new TypeError("thinking effort cannot be set when thinking mode is disabled");
    }
    if (this.reasoningVisibility !== "visible" && this.reasoningVisibility !== "hidden") {
      throw new TypeError("reasoning visibility must be visible or hidden");
    }
    if (this.planningThinkingMode !== undefined && this.planningThinkingMode !== "enabled" && this.planningThinkingMode !== "disabled") {
      throw new TypeError("planning thinking mode must be enabled or disabled");
    }
  }


  estimateInputTokens(invocation: ModelInvocation): number {
    const encoded = encodeOpenAICompatiblePrompt(invocation, this.runtimeContextPlacement);
    return policy.estimateWireTokens(JSON.stringify({ messages: encoded.messages, tools: invocation.tools })) + encoded.messages.length * 4 + invocation.tools.length * 4;
  }

  requestLogContext(invocation: ModelInvocation, stream: boolean): ModelRequestLogContext {
    const messages = encodeOpenAICompatiblePrompt(invocation, this.runtimeContextPlacement).messages;
    const input = messages.filter(message => message.role !== "system");
    const count = input.reduce((total, message) => total + (message.role === "assistant"
      ? (typeof message.content === "string" && message.content.length > 0 ? 1 : 0) + (Array.isArray(message.tool_calls) ? message.tool_calls.length : 0) : 1), 0);
    const choice = this.sdkToolChoice(invocation);
    const wireChoice = choice?.type === "tool"
      ? this.protocol === "responses" ? { type: "function", name: choice.toolName } : { type: "function", function: { name: choice.toolName } }
      : choice?.type;
    return policy.modelRequestLogContext({
      protocol: this.protocol, model: this.model, invocation, stream,
      runtimeContextPlacement: this.runtimeContextPlacement,
      ...(this.protocol === "responses" ? { providerInputItemCount: Math.max(1, count), insertedEmptyInputSentinel: count === 0 } : { providerMessageCount: messages.length }),
      toolChoice: wireChoice,
    });
  }

  complete(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
    // Responses-compatible servers already use the stream path for semantic complete.
    return this.invoke(invocation, this.protocol === "responses", async () => undefined, signal);
  }

  streamComplete(invocation: ModelInvocation, sink: ModelStreamSink, signal?: AbortSignal): Promise<ModelResponse> {
    return this.invoke(invocation, true, sink, signal);
  }

  private sdkToolChoice(invocation: ModelInvocation): LanguageModelV4CallOptions["toolChoice"] {
    if (!invocation.tools.length) return undefined;
    const choice = invocation.toolChoice ?? "auto";
    if (this.toolChoiceMode === "constrained-as-auto" && choice !== "auto") return { type: "auto" };
    if (this.toolChoiceMode === "named-as-required" && typeof choice !== "string") return { type: invocation.tools.length === 1 ? "required" : "auto" };
    return typeof choice === "string" ? { type: choice } : { type: "tool", toolName: choice.name };
  }

  private callOptions(invocation: ModelInvocation, signal: AbortSignal): LanguageModelV4CallOptions {
    const encoded = encodeOpenAICompatiblePrompt(invocation, this.runtimeContextPlacement).messages;
    const prompt: LanguageModelV4Prompt = [];
    for (const message of encoded) {
      if (message.role === "system") {
        if (this.protocol === "chat-completions") prompt.push({ role: "system", content: String(message.content) });
      } else if (message.role === "user") {
        prompt.push({ role: "user", content: [{ type: "text", text: String(message.content) }] });
      } else if (message.role === "tool") {
        prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: String(message.tool_call_id), toolName: "", output: { type: "text", value: String(message.content) } }] });
      } else {
        const content: Extract<LanguageModelV4Prompt[number], { role: "assistant" }>["content"] = [];
        if (typeof message.content === "string" && message.content.length) content.push({ type: "text", text: message.content });
        if (this.protocol === "chat-completions" && typeof message.reasoning_content === "string") content.push({ type: "reasoning", text: message.reasoning_content });
        for (const call of (message.tool_calls ?? []) as Array<Record<string, any>>) {
          content.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input: JSON.parse(call.function.arguments) });
        }
        if (content.length) prompt.push({ role: "assistant", content });
      }
    }
    if (this.protocol === "responses") {
      const continuation = this.reasoningEncryptedContent ? this.reasoningContinuationStore?.get(this.reasoningContinuationScope, invocation.runId) ?? [] : [];
      if (continuation.length) {
        const index = prompt.findLastIndex(message => message.role === "user");
        prompt.splice(index < 0 ? prompt.length : index, 0, { role: "assistant", content: continuation.map(item => ({
          type: "reasoning" as const, text: "", providerOptions: { openai: { itemId: item.id as string, reasoningEncryptedContent: item.encrypted_content as string } },
        })) });
      }
      if (!prompt.length) prompt.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
    }
    const thinkingMode = invocation.plannerRequest && this.planningThinkingMode !== undefined ? this.planningThinkingMode : this.thinkingMode;
    const vendorOptions = {
      ...(this.enableThinking === undefined && thinkingMode !== undefined ? { thinking: { type: thinkingMode } } : {}),
      ...(this.enableThinking !== false && this.thinkingEffort !== undefined ? { reasoning_effort: this.thinkingEffort } : {}),
      ...(this.reasoningEffort === undefined ? {} : { reasoning_effort: this.reasoningEffort }),
      ...(this.chatTemplateKwargs === undefined ? {} : { chat_template_kwargs: this.chatTemplateKwargs }),
      ...(this.enableThinking === undefined ? {} : { enable_thinking: this.enableThinking }),
    };
    return {
      prompt, abortSignal: signal, includeRawChunks: true,
      maxOutputTokens: Math.min(invocation.maxOutputTokens ?? this.limits.maxOutputTokens, this.limits.maxOutputTokens),
      ...(this.protocol === "chat-completions" ? { temperature: this.temperature, topP: this.topP } : {}),
      tools: invocation.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description,
        // Responses-compatible tools keep their original schema at the transport
        // boundary instead of undergoing OpenAI-only constraint removal.
        inputSchema: this.protocol === "responses" ? {} : tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      })),
      toolChoice: this.sdkToolChoice(invocation),
      providerOptions: this.protocol === "chat-completions" ? { agentloop: vendorOptions as any } : { openai: {
        instructions: String(encoded.find(message => message.role === "system")?.content ?? ""),
        forceReasoning: this.reasoningSummary !== undefined || this.reasoningEffort !== undefined || this.reasoningEncryptedContent,
        ...(this.reasoningSummary === undefined ? {} : { reasoningSummary: this.reasoningSummary }),
        ...(this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort }),
        ...(this.reasoningEncryptedContent ? { include: ["reasoning.encrypted_content"] } : {}),
      } },
    };
  }

  private provider(fetch: typeof globalThis.fetch): LanguageModelV4 {
    const suffix = this.protocol === "responses" ? "responses" : "chat/completions";
    const baseURL = this.endpoint.href.slice(0, -suffix.length).replace(/\/$/u, "");
    return this.protocol === "responses"
      ? createOpenAI({ baseURL, apiKey: this.apiKey, fetch }).responses(this.model)
      : createOpenAICompatible({ baseURL, apiKey: this.apiKey, name: "agentloop", fetch }).chatModel(this.model);
  }

  private decode(result: LanguageModelV4GenerateResult, payload?: Record<string, any>): ModelResponse {
    const toolCalls = [...new Map(result.content.filter(part => part.type === "tool-call").map(part => {
      const original = originalSdkToolCall(part);
      const tool = { id: original.toolCallId, name: original.toolName, arguments: policy.parseToolArguments(original.input || "{}") };
      return [tool.id, tool] as const;
    })).values()];
    const content = result.content.filter(part => part.type === "text").map(part => part.text).join("");
    const reasoning = result.content.filter(part => part.type === "reasoning").map(part => part.text).join("");
    const usage = sdkUsage(result.usage);
    return {
      ...policy.providerResponseIdentity(payload), content, toolCalls,
      finishReason: this.finishReason(result.finishReason.unified, toolCalls.length, payload),
      ...(reasoning ? { reasoningContent: reasoning } : {}),
      ...(usage ? { usage } : {}),
      ...(typeof payload?.incomplete_details?.reason === "string" ? { finishReasonDetail: payload.incomplete_details.reason } : {}),
    };
  }

  private finishReason(reason: string, count: number, payload?: Record<string, any>): ModelResponse["finishReason"] {
    if (payload?.status === "failed" || payload?.status === "cancelled") return "error";
    if (payload?.status === "incomplete" || reason === "length") return "length";
    if (reason === "error" || reason === "interrupted" || reason === "content-filter") return "error";
    if (count || reason === "tool-calls") return "tool_calls";
    return reason === "stop" || payload?.status === "completed" ? "stop" : "error";
  }

  /** Decode the received JSON/terminal envelope locally; never make another upstream call. */
  private async decodeSnapshot(payload: Record<string, any>, call: LanguageModelV4CallOptions): Promise<ModelResponse> {
    if (payload.status === "failed") return { ...policy.providerResponseIdentity(payload), content: "", toolCalls: [], finishReason: "error" };
    const normalized = normalizeJsonPayload(payload, this.protocol);
    const provider = this.provider(async () => new Response(JSON.stringify(normalized), { headers: { "content-type": "application/json" } }));
    return this.decode(await provider.doGenerate(call), payload);
  }

  private rememberContinuation(runId: string, payload?: Record<string, any>): void {
    if (!this.reasoningEncryptedContent || !this.reasoningContinuationStore) return;
    const items = (Array.isArray(payload?.output) ? payload.output : []).filter((item: Record<string, unknown>) => item.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0);
    if (Buffer.byteLength(JSON.stringify(items)) > 256 * 1024) throw new AppError("MODEL_ERROR", "Responses reasoning continuation exceeded the configured size limit", 502);
    this.reasoningContinuationStore.set(this.reasoningContinuationScope, runId, items);
  }

  private async invoke(invocation: ModelInvocation, stream: boolean, sink: ModelStreamSink, signal?: AbortSignal): Promise<ModelResponse> {
    const request = this.requestLogContext(invocation, stream);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const timeout = policy.createStreamingModelTimeout(this.timeoutMs, signal);
      const budget = policy.createModelResponseBudget(invocation, this.limits);
      const transport = new ProviderTransport({ protocol: this.protocol, invocation, request, apiKey: this.apiKey, model: this.model,
        budget, parameters: this.providerParameters, recordActivity: timeout.recordActivity, writer: this.streamRawCaptureWriter,
        continuation: this.reasoningEncryptedContent ? this.reasoningContinuationStore?.get(this.reasoningContinuationScope, invocation.runId) : undefined,
        reasoning: this.reasoningEffort !== undefined || this.reasoningSummary !== undefined ? {
          ...(this.reasoningEffort === undefined ? {} : { effort: this.reasoningEffort }),
          ...(this.reasoningSummary === undefined ? {} : { summary: this.reasoningSummary }),
        } : undefined });
      const call = this.callOptions(invocation, timeout.signal);
      const provider = this.provider(transport.fetch);
      try {
        let result: ModelResponse;
        if (!stream) {
          result = this.decode(await provider.doGenerate(call), transport.jsonPayload);
        } else {
          try { result = await this.consumeSdkStream(provider, call, transport, sink, budget); }
          catch (error) {
            if (transport.failure instanceof JsonProviderResponse && transport.jsonPayload) result = await this.decodeSnapshot(transport.jsonPayload, call);
            else throw error;
          }
        }
        if (timeout.aborted) throw policy.modelRequestAborted(timeout.abortReason, timeout.details());
        budget.assertResponse(result);
        this.rememberContinuation(invocation.runId, transport.terminal ?? transport.jsonPayload);
        if (transport.response) result = { ...result, ...policy.providerRequestIdentity(transport.response) };
        if (policy.requestRequiresToolCall(request.toolChoice) && result.toolCalls.length === 0 && result.finishReason !== "error" && !transport.diagnostics.hadSinkEmission && attempt < this.maxAttempts) {
          await policy.retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, signal ?? policy.NEVER_ABORT_SIGNAL, undefined, request, result);
          continue;
        }
        return result;
      } catch (caught) {
        // A sink/Runtime failure takes precedence over transport read-ahead.
        // SDK wrappers may otherwise obscure the original transport failure.
        let error = caught instanceof AppError || caught instanceof policy.StreamConsumptionError || transport.failure instanceof JsonProviderResponse
          ? caught : transport.failure ?? caught;
        const response = transport.response;
        const emitted = transport.diagnostics.hadSinkEmission;
        const httpFailure = error instanceof AppError && typeof error.details?.status === "number" ? error.details.status as number : undefined;
        const retry = attempt < this.maxAttempts && !emitted && (timeout.aborted
          ? policy.isRetryableStreamingAbort(timeout.abortReason)
          : httpFailure !== undefined ? policy.isRetryableStatus(httpFailure)
            : !response || error instanceof policy.StreamConsumptionError || (!stream && !(error instanceof AppError)));
        if (timeout.aborted) error = policy.modelRequestAborted(timeout.abortReason, timeout.details());
        if (transport.collector) {
          if (!(error instanceof AppError) && !(error instanceof policy.StreamConsumptionError)) error = new policy.StreamConsumptionError("consume_event", error, transport.diagnostics);
          const receipt = await transport.collector.build(policy.streamFailureAnomalyReasons(error, transport.diagnostics), true);
          transport.diagnostics.streamReceipt = receipt;
          if (error instanceof AppError) error = new AppError(error.code, error.message, error.status, { ...error.details, streamReceipt: receipt });
        }
        if (retry) {
          const identity = response ? policy.providerRequestIdentity(response) : {};
          const providerErrorBody = error instanceof AppError ? error.details?.providerErrorBody : undefined;
          await policy.retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, signal ?? policy.NEVER_ABORT_SIGNAL, httpFailure, request, {
            ...identity, ...(typeof providerErrorBody === "string" ? { providerErrorBody } : {}),
          });
          continue;
        }
        if (!(error instanceof AppError)) {
          error = !response ? new AppError("MODEL_ERROR", "Model provider is unreachable", 502, { attempts: attempt, causeCode: policy.transportCauseCode(error), request })
            : stream ? policy.unreadableStreamingResponse(error, attempt, request)
              : new AppError("MODEL_ERROR", "Model provider returned an unreadable response", 502, { attempts: attempt, causeCode: policy.transportCauseCode(error), request });
        }
        if (response) error = policy.withProviderRequestIdentity(error as AppError, response);
        throw redactModelError(error as AppError, this.apiKey);
      } finally { timeout.dispose(); }
    }
    throw new AppError("MODEL_ERROR", "Model request exhausted its attempts", 502);
  }

  private async consumeSdkStream(provider: LanguageModelV4, call: LanguageModelV4CallOptions, transport: ProviderTransport, sink: ModelStreamSink, budget: policy.ModelResponseBudget): Promise<ModelResponse> {
    let content = "";
    let reasoningContent = "";
    let reason = "error";
    let usage: ModelResponse["usage"];
    const inputs = new Map<string, { index: number; name: string; raw: string }>();
    const itemIds = new Map<string, { id: string; index: number }>();
    const wireIndexes = new Map<string, number>();
    const calls = new Map<string, ModelToolCall>();
    const ready = new Set<string>();
    const emit = async (event: Parameters<ModelStreamSink>[0]) => {
      transport.diagnostics.hadSinkEmission = true;
      try { await sink(event); }
      catch (error) { throw new policy.StreamConsumptionError("consume_event", error, transport.diagnostics); }
    };
    const finishCall = async (id: string, name: string, raw: string, early: boolean) => {
      const existing = inputs.get(id);
      if (existing) { budget.replaceOutputBytes(existing.raw, raw, "toolCall.arguments"); existing.raw = raw; }
      else budget.addOutputBytes(raw, "toolCall.arguments");
      const tool = { id, name, arguments: policy.parseToolArguments(raw || "{}") };
      calls.set(id, tool);
      if (early && !ready.has(id)) { ready.add(id); await emit({ type: "tool_call_ready", index: existing?.index ?? calls.size - 1, ...tool }); }
    };
    try {
      const result = await provider.doStream(call);
      for await (const part of result.stream) {
        switch (part.type) {
          case "raw": {
            const raw = part.rawValue as Record<string, any>;
            if (!raw || typeof raw !== "object") break;
            for (const wire of raw.choices?.[0]?.delta?.tool_calls ?? []) if (wire.id) wireIndexes.set(wire.id, wire.index ?? wireIndexes.size);
            if (raw.type === "response.output_item.added" && raw.item?.type === "function_call") {
              itemIds.set(raw.item.id, { id: raw.item.call_id, index: raw.output_index });
              wireIndexes.set(raw.item.call_id, raw.output_index);
            }
            // The SDK emits a tool-call for output_item.done. Compatible servers
            // can use arguments.done as the authoritative earlier completion.
            if (raw.type === "response.function_call_arguments.done") {
              const meta = itemIds.get(raw.item_id);
              const input = meta && inputs.get(meta.id);
              if (meta && input) await finishCall(meta.id, input.name, raw.arguments || input.raw, true);
            }
            break;
          }
          case "text-delta": budget.addOutputBytes(part.delta, "content"); content += part.delta; await emit({ type: "text_delta", text: part.delta }); break;
          case "reasoning-delta": budget.addOutputBytes(part.delta, "reasoningContent"); reasoningContent += part.delta; await emit({ type: "reasoning_delta", text: part.delta }); break;
          case "tool-input-start":
            // SDK-expanded wrapper children are not native calls. Preserve the
            // original call below instead of projecting synthetic execution.
            if (this.protocol === "responses" && !wireIndexes.has(part.id)) break;
            inputs.set(part.id, { index: wireIndexes.get(part.id) ?? inputs.size, name: part.toolName, raw: "" }); break;
          case "tool-input-delta": {
            const input = inputs.get(part.id);
            if (!input && this.protocol === "responses" && !wireIndexes.has(part.id)) break;
            if (!input) throw new AppError("MODEL_ERROR", "Provider tool delta has no declared tool call", 502);
            budget.addOutputBytes(part.delta, "toolCall.arguments"); input.raw += part.delta;
            await emit({ type: "tool_call_delta", index: input.index, id: part.id, name: input.name, argumentsDelta: part.delta });
            break;
          }
          case "tool-call": {
            if (part.providerExecuted) throw new AppError("MODEL_ERROR", "Provider-executed tools are not enabled for this Runtime", 502);
            const original = originalSdkToolCall(part);
            if (!wireIndexes.has(original.toolCallId)) throw new AppError("MODEL_ERROR", "Provider tool call has no native call identity", 502);
            if (calls.has(original.toolCallId) && original !== part) break;
            await finishCall(original.toolCallId, original.toolName, original.input || inputs.get(original.toolCallId)?.raw || "", this.protocol === "responses");
            break;
          }
          case "error":
            if (transport.terminal?.status === "failed" && (part.error as any)?.data?.type === "response.failed") break;
            throw new policy.StreamConsumptionError("consume_event", part.error, transport.diagnostics);
          case "finish": reason = part.finishReason.unified; usage = sdkUsage(part.usage); break;
        }
      }
    } catch (error) {
      // A failed provider terminal is a failed ModelResponse, not a transport
      // retry. The Runtime decides recovery from its terminal semantics.
      if (!(transport.terminal?.status === "failed" && (error as any)?.data?.type === "response.failed")) throw error;
    }
    if (this.protocol === "responses" && !transport.diagnostics.finishReasonObserved) throw policy.missingResponsesTerminalEvent(transport.options.request, transport.diagnostics);
    if (this.protocol === "chat-completions" && (!transport.diagnostics.finishReasonObserved || reason === "error" || reason === "interrupted")) {
      throw new AppError("MODEL_ERROR", "Chat Completions Provider stream ended without a successful terminal event", 502, { streamFailureStage: "missing_terminal_event", request: transport.options.request });
    }
    let snapshot: ModelResponse | undefined;
    if (transport.terminal) snapshot = await this.decodeSnapshot(transport.terminal, call);
    const toolCalls = snapshot?.toolCalls.length ? snapshot.toolCalls : [...calls.values()];
    const response: ModelResponse = {
      ...policy.providerResponseIdentity({ id: transport.diagnostics.providerResponseId }),
      content: snapshot?.content || content, toolCalls,
      finishReason: snapshot?.finishReason === "error" || snapshot?.finishReason === "length" ? snapshot.finishReason : this.finishReason(reason, toolCalls.length, transport.terminal),
      ...(snapshot?.finishReasonDetail ? { finishReasonDetail: snapshot.finishReasonDetail } : {}),
      ...((reasoningContent || snapshot?.reasoningContent) ? { reasoningContent: reasoningContent || snapshot?.reasoningContent } : {}),
      ...((snapshot?.usage ?? usage) ? { usage: snapshot?.usage ?? usage } : {}),
    };
    budget.assertResponse(response);
    if (this.protocol === "chat-completions" && response.finishReason !== "error" && response.finishReason !== "length") {
      for (const tool of toolCalls) await emit({ type: "tool_call_ready", index: inputs.get(tool.id)?.index ?? 0, ...tool });
    }
    const streamReceipt = await transport.collector!.build(policy.streamAnomalyReasons(response, transport.diagnostics));
    return { ...response, streamReceipt };
  }
}

function sdkUsage(usage: LanguageModelV4GenerateResult["usage"]): ModelResponse["usage"] {
  const inputTokens = usage.inputTokens.total;
  const outputTokens = usage.outputTokens.total;
  return inputTokens === undefined && outputTokens === undefined ? undefined : {
    ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function originalSdkToolCall(part: Extract<LanguageModelV4StreamPart, { type: "tool-call" }>): { toolCallId: string; toolName: string; input: string } {
  // The provider can expand a wire-level `parallel` wrapper. Runtime admission
  // must see the actual provider intent, including an unknown tool, unchanged.
  const original = (part.providerMetadata?.openai as Record<string, any> | undefined)?.parallelToolCall;
  return original && typeof original.toolCallId === "string" && typeof original.toolName === "string" && typeof original.input === "string" ? original : part;
}

function redactModelError(error: AppError, apiKey: string): AppError {
  const redact = (value: unknown): any => typeof value === "string" ? (apiKey ? value.replaceAll(apiKey, "[REDACTED]") : value)
    : Array.isArray(value) ? value.map(redact)
      : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) : value;
  return new AppError(error.code, redact(error.message), error.status, redact(error.details));
}

/** Existing public adapters now share the standard SDK provider implementation. */
export class OpenAICompatibleModel extends AiSdkModel {
  constructor(options: OpenAICompatibleModelOptions) { super(options, "chat-completions"); }
}
export class ResponsesModel extends AiSdkModel {
  constructor(options: OpenAICompatibleModelOptions) { super(options, "responses"); }
}
