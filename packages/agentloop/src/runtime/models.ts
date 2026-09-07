import { AppError } from "../shared/errors.ts";
import type {
  ModelAdapter,
  ModelMessage,
  ModelInvocation,
  ModelRequestLogContext,
  ModelResponse,
  ModelRetryReporter,
  ModelStreamSink,
  ModelToolCall,
} from "./contracts.ts";
import {
  encodeOpenAICompatiblePrompt,
  type RuntimeContextPlacement,
} from "./prompt-protocol.ts";

export interface OpenAICompatibleModelOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  /**
   * Some reasoning-mode OpenAI-compatible Providers reject named function
   * `tool_choice` values. `constrained-as-auto` keeps the legacy lowest common
   * denominator. `named-as-required` preserves single-tool structured phases by
   * requiring a tool call while leaving Runtime to validate the tool name.
   */
  readonly toolChoiceMode?: "native" | "constrained-as-auto" | "named-as-required";
  readonly runtimeContextPlacement?: RuntimeContextPlacement;
  /** Request a public reasoning summary from Responses-compatible models. */
  readonly reasoningSummary?: "auto";
  /** Optional server-authored reporter invoked before each retry attempt. */
  readonly onRetry?: ModelRetryReporter;
}

interface CompatibleResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface CompatibleStreamChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface ProviderRequest {
  readonly body: string;
  readonly logContext: ModelRequestLogContext;
}

interface StreamFailureDiagnostics {
  eventsSeen: number;
  hadSinkEmission: boolean;
  lastEvent?: StreamEventSummary;
}

interface StreamEventSummary {
  readonly dataKind: "done" | "json" | "non-json";
  readonly byteLength: number;
  readonly shape?: readonly string[];
}

class StreamConsumptionError extends Error {
  readonly stage: "read" | "consume_event";
  readonly diagnostics: StreamFailureDiagnostics;
  readonly cause: unknown;

  constructor(stage: "read" | "consume_event", error: unknown, diagnostics: StreamFailureDiagnostics) {
    super(stage === "read" ? "stream read failed" : "stream event consumption failed");
    this.name = "StreamConsumptionError";
    this.stage = stage;
    this.diagnostics = diagnostics;
    this.cause = error;
  }
}

const STREAM_WALL_TIMEOUT_FACTOR = 3;
const STREAM_WALL_TIMEOUT_MAX_MS = 15 * 60 * 1_000;
const NEVER_ABORT_SIGNAL = new AbortController().signal;

export class OpenAICompatibleModel implements ModelAdapter {
  readonly limits: Readonly<{ contextWindowTokens: number; maxOutputTokens: number }>;
  readonly operationTimeoutMs: number;
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly toolChoiceMode: "native" | "constrained-as-auto" | "named-as-required";
  private readonly runtimeContextPlacement: RuntimeContextPlacement;
  private readonly reasoningSummary?: "auto";
  private readonly onRetry?: ModelRetryReporter;

  constructor(options: OpenAICompatibleModelOptions) {
    const base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new TypeError("LLM base URL must use http or https");
    }
    this.endpoint = new URL("chat/completions", base);
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
    this.operationTimeoutMs = streamOperationTimeoutMs(this.timeoutMs);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.toolChoiceMode = options.toolChoiceMode ?? "native";
    this.runtimeContextPlacement = options.runtimeContextPlacement ?? "system";
    this.reasoningSummary = options.reasoningSummary;
    this.onRetry = options.onRetry;
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
    if (this.reasoningSummary !== undefined && this.reasoningSummary !== "auto") {
      throw new TypeError("reasoning summary must be auto");
    }
  }

  estimateInputTokens(invocation: ModelInvocation): number {
    const prompt = encodeOpenAICompatiblePrompt(invocation, this.runtimeContextPlacement);
    const providerTools = invocation.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    // This remains an estimate rather than a vendor tokenizer result, but it
    // measures the same system/user/assistant/tool envelope used by complete.
    return estimateWireTokens(JSON.stringify({ messages: prompt.messages, tools: providerTools }))
      + prompt.messages.length * 4
      + providerTools.length * 4;
  }

  requestLogContext(invocation: ModelInvocation, stream: boolean): ModelRequestLogContext {
    return this.buildRequest(invocation, stream).logContext;
  }

  async complete(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const request = this.buildRequest(invocation, false);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: request.body,
          signal: combinedSignal,
        });
      } catch (error) {
        if (combinedSignal.aborted) throw modelRequestAborted();
        if (attempt < this.maxAttempts) {
          await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, combinedSignal, undefined, request.logContext);
          continue;
        }
        throw new AppError("MODEL_ERROR", "Model provider is unreachable", 502, {
          attempts: attempt,
          causeCode: transportCauseCode(error),
          request: request.logContext,
        });
      }

      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
          await response.body?.cancel().catch(() => undefined);
          await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, combinedSignal, response.status, request.logContext);
          continue;
        }
        throw await providerHttpError(response, request.logContext);
      }

      let payload: CompatibleResponse;
      try {
        payload = (await response.json()) as CompatibleResponse;
        assertChatCompletionsPayload(payload);
      } catch (error) {
        if (combinedSignal.aborted) throw modelRequestAborted();
        if (error instanceof AppError) throw error;
        if (attempt < this.maxAttempts) {
          await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, combinedSignal, undefined, request.logContext);
          continue;
        }
        throw new AppError("MODEL_ERROR", "Model provider returned an unreadable response", 502, {
          attempts: attempt,
          causeCode: transportCauseCode(error),
          request: request.logContext,
        });
      }

      const choice = payload.choices?.[0];
      const message = choice?.message;
      if (message === undefined) throw new AppError("MODEL_ERROR", "Model provider returned no message", 502);
      const toolCalls = (message.tool_calls ?? []).map((call, index) => parseToolCall(call, index));
      if (requestRequiresToolCall(request.logContext.toolChoice) && toolCalls.length === 0 && attempt < this.maxAttempts) {
        await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, combinedSignal, undefined, request.logContext);
        continue;
      }
      return {
        content: message.content ?? "",
        toolCalls,
        finishReason: normalizeFinishReason(choice?.finish_reason, toolCalls.length),
        ...(typeof message.reasoning_content === "string" && message.reasoning_content.length > 0
          ? { reasoningContent: message.reasoning_content }
          : {}),
        ...(payload.usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: payload.usage.completion_tokens,
              },
            }),
      };
    }
    throw new AppError("MODEL_ERROR", "Model request exhausted its attempts", 502);
  }

  async streamComplete(
    invocation: ModelInvocation,
    sink: ModelStreamSink,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const request = this.buildRequest(invocation, true);
    const retrySignal = signal ?? NEVER_ABORT_SIGNAL;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const requestTimeout = createStreamingModelTimeout(this.timeoutMs, signal);
      try {
        let response: Response;
        try {
          response = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              "content-type": "application/json",
            },
            body: request.body,
            signal: requestTimeout.signal,
          });
        } catch (error) {
          if (requestTimeout.aborted) {
            if (isRetryableStreamingAbort(requestTimeout.abortReason) && attempt < this.maxAttempts) {
              await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, undefined, request.logContext);
              continue;
            }
            throw modelRequestAborted(requestTimeout.abortReason, requestTimeout.details());
          }
          if (attempt < this.maxAttempts) {
            await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, undefined, request.logContext);
            continue;
          }
          throw new AppError("MODEL_ERROR", "Model provider is unreachable", 502, {
            attempts: attempt,
            causeCode: transportCauseCode(error),
            request: request.logContext,
          });
        }

        if (!response.ok) {
          if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
            await response.body?.cancel().catch(() => undefined);
            await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, response.status, request.logContext);
            continue;
          }
          throw await providerHttpError(response, request.logContext);
        }

        try {
          return await this.consumeStream(response, sink, requestTimeout.recordActivity);
        } catch (error) {
          if (requestTimeout.aborted) {
            if (isRetryableStreamingAbort(requestTimeout.abortReason) && attempt < this.maxAttempts) {
              await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, undefined, request.logContext);
              continue;
            }
            throw modelRequestAborted(requestTimeout.abortReason, requestTimeout.details());
          }
          if (error instanceof StreamConsumptionError && !error.diagnostics.hadSinkEmission && attempt < this.maxAttempts) {
            await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, undefined, request.logContext);
            continue;
          }
          if (error instanceof AppError) throw error;
          // Partial deltas may already have been emitted to the sink, so a
          // mid-stream failure is never replayed through a second provider call.
          throw unreadableStreamingResponse(error, attempt, request.logContext);
        }
      } finally {
        requestTimeout.dispose();
      }
    }
    throw new AppError("MODEL_ERROR", "Model request exhausted its attempts", 502);
  }

  private buildRequest(invocation: ModelInvocation, stream: boolean): ProviderRequest {
    const prompt = encodeOpenAICompatiblePrompt(invocation, this.runtimeContextPlacement);
    const providerTools = invocation.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    const toolChoice = invocation.tools.length === 0
      ? undefined
      : toProviderToolChoice(invocation.toolChoice ?? "auto", this.toolChoiceMode, invocation.tools.length);
    const body = JSON.stringify({
      model: this.model,
      messages: prompt.messages,
      tools: providerTools,
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      max_tokens: Math.min(invocation.maxOutputTokens ?? this.limits.maxOutputTokens, this.limits.maxOutputTokens),
      ...(stream ? { stream: true } : {}),
    });
    return {
      body,
      logContext: modelRequestLogContext({
        protocol: "chat-completions",
        model: this.model,
        invocation,
        stream,
        runtimeContextPlacement: this.runtimeContextPlacement,
        providerMessageCount: prompt.messages.length,
        toolChoice,
      }),
    };
  }

  private async consumeStream(
    response: Response,
    sink: ModelStreamSink,
    recordActivity: () => void = () => undefined,
  ): Promise<ModelResponse> {
    if (response.body === null) {
      throw new AppError("MODEL_ERROR", "Model provider returned no streaming body", 502);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoningContent = "";
    const toolCallAccumulator = new Map<number, { id?: string; name?: string; arguments: string }>();
    let finishReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const diagnostics: StreamFailureDiagnostics = {
      eventsSeen: 0,
      hadSinkEmission: false,
    };
    const emit = async (event: Parameters<ModelStreamSink>[0]): Promise<void> => {
      diagnostics.hadSinkEmission = true;
      await sink(event);
    };

    const handleData = async (data: string): Promise<void> => {
      diagnostics.eventsSeen += 1;
      diagnostics.lastEvent = summarizeStreamEvent(data);
      if (data.trim() === "[DONE]") return;
      let payload: CompatibleStreamChunk;
      try {
        payload = JSON.parse(data) as CompatibleStreamChunk;
      } catch {
        return; // Ignore malformed or keep-alive data lines.
      }
      assertChatCompletionsPayload(payload);
      const choice = payload.choices?.[0];
      const deltaContent = choice?.delta?.content;
      if (typeof deltaContent === "string" && deltaContent.length > 0) {
        content += deltaContent;
        await emit({ type: "text_delta", text: deltaContent });
      }
      const reasoningDelta = choice?.delta?.reasoning_content;
      if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
        reasoningContent += reasoningDelta;
        await emit({ type: "reasoning_delta", text: reasoningDelta });
      }
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : toolCallAccumulator.size;
        const accumulated = toolCallAccumulator.get(index) ?? { arguments: "" };
        if (typeof call.id === "string" && call.id.length > 0) accumulated.id = call.id;
        const nameDelta = call.function?.name;
        if (typeof nameDelta === "string" && nameDelta.length > 0) accumulated.name = nameDelta;
        const rawArgumentsDelta = call.function?.arguments;
        const argumentsDelta = typeof rawArgumentsDelta === "string" ? rawArgumentsDelta : "";
        if (argumentsDelta.length > 0) accumulated.arguments += argumentsDelta;
        toolCallAccumulator.set(index, accumulated);
        await emit({
          type: "tool_call_delta",
          index,
          ...(accumulated.id === undefined ? {} : { id: accumulated.id }),
          ...(accumulated.name === undefined ? {} : { name: accumulated.name }),
          argumentsDelta,
        });
      }
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
      if (payload.usage?.prompt_tokens !== undefined) inputTokens = payload.usage.prompt_tokens;
      if (payload.usage?.completion_tokens !== undefined) outputTokens = payload.usage.completion_tokens;
    };

    try {
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          throw new StreamConsumptionError("read", error, diagnostics);
        }
        const { done, value } = result;
        if (done) break;
        recordActivity();
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.replaceAll("\r\n", "\n").split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const dataLines: string[] = [];
          for (const line of event.split("\n")) {
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          try {
            await handleData(dataLines.join("\n"));
          } catch (error) {
            if (error instanceof AppError) throw error;
            throw new StreamConsumptionError("consume_event", error, diagnostics);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const ordered = [...toolCallAccumulator.entries()].sort(([left], [right]) => left - right);
    const toolCalls: ModelToolCall[] = [];
    const readyCalls: Array<{ index: number; call: ModelToolCall }> = [];
    for (const [index, accumulated] of ordered) {
      if (accumulated.id === undefined || accumulated.name === undefined) continue;
      const call = parseAccumulatedToolCall(accumulated.id, accumulated.name, accumulated.arguments);
      toolCalls.push(call);
      readyCalls.push({ index, call });
    }
    const finalFinishReason = normalizeFinishReason(finishReason, toolCalls.length);
    // Chat Completions has no per-item "arguments done" signal. A length-truncated
    // response may carry incomplete arguments, so those calls are never marked
    // ready for early dispatch; the caller rejects them.
    if (finalFinishReason !== "length") {
      for (const { index, call } of readyCalls) {
        await sink({ type: "tool_call_ready", index, id: call.id, name: call.name, arguments: call.arguments });
      }
    }
    return {
      content,
      toolCalls,
      finishReason: finalFinishReason,
      ...(reasoningContent.length > 0 ? { reasoningContent } : {}),
      ...(inputTokens === undefined && outputTokens === undefined
        ? {}
        : {
            usage: {
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
            },
          }),
    };
  }
}

/**
 * OpenAI Responses API adapter (stateless). DeepSeek exposes this protocol at
 * the root base URL (https://api.deepseek.com, no /v1) for Codex compatibility.
 * Its streaming events carry per-item completion signals
 * (`function_call_arguments.done`), which lets the Runtime dispatch a tool the
 * moment its arguments finish instead of waiting for the whole response.
 */
export class ResponsesModel implements ModelAdapter {
  readonly limits: Readonly<{ contextWindowTokens: number; maxOutputTokens: number }>;
  readonly operationTimeoutMs: number;
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly toolChoiceMode: "native" | "constrained-as-auto" | "named-as-required";
  private readonly runtimeContextPlacement: RuntimeContextPlacement;
  private readonly reasoningSummary?: "auto";
  private readonly onRetry?: ModelRetryReporter;

  constructor(options: OpenAICompatibleModelOptions) {
    const base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new TypeError("LLM base URL must use http or https");
    }
    this.endpoint = new URL("responses", base);
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
    this.operationTimeoutMs = streamOperationTimeoutMs(this.timeoutMs);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.toolChoiceMode = options.toolChoiceMode ?? "native";
    this.runtimeContextPlacement = options.runtimeContextPlacement ?? "system";
    this.reasoningSummary = options.reasoningSummary;
    this.onRetry = options.onRetry;
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
    if (this.reasoningSummary !== undefined && this.reasoningSummary !== "auto") {
      throw new TypeError("reasoning summary must be auto");
    }
  }

  async complete(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse> {
    return await this.streamComplete(invocation, async () => undefined, signal);
  }

  requestLogContext(invocation: ModelInvocation, stream: boolean): ModelRequestLogContext {
    return this.buildRequest(invocation, stream).logContext;
  }

  async streamComplete(
    invocation: ModelInvocation,
    sink: ModelStreamSink,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const request = this.buildRequest(invocation, true);
    const retrySignal = signal ?? NEVER_ABORT_SIGNAL;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const requestTimeout = createStreamingModelTimeout(this.timeoutMs, signal);
      try {
        let response: Response;
        try {
          response = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              "content-type": "application/json",
            },
            body: request.body,
            signal: requestTimeout.signal,
          });
        } catch (error) {
          if (requestTimeout.aborted) {
            if (isRetryableStreamingAbort(requestTimeout.abortReason) && attempt < this.maxAttempts) {
              await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, undefined, request.logContext);
              continue;
            }
            throw modelRequestAborted(requestTimeout.abortReason, requestTimeout.details());
          }
          if (attempt < this.maxAttempts) {
            await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, undefined, request.logContext);
            continue;
          }
          throw new AppError("MODEL_ERROR", "Model provider is unreachable", 502, {
            attempts: attempt,
            causeCode: transportCauseCode(error),
            request: request.logContext,
          });
        }

        if (!response.ok) {
          if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
            await response.body?.cancel().catch(() => undefined);
            await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, response.status, request.logContext);
            continue;
          }
          throw await providerHttpError(response, request.logContext);
        }

        try {
          if (isJsonResponse(response)) {
            const payload = await response.json();
            assertResponsesPayload(payload);
            return parseResponsesResponse(payload);
          }
          return await this.consumeStream(response, sink, requestTimeout.recordActivity);
        } catch (error) {
          if (requestTimeout.aborted) {
            if (isRetryableStreamingAbort(requestTimeout.abortReason) && attempt < this.maxAttempts) {
              await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, undefined, request.logContext);
              continue;
            }
            throw modelRequestAborted(requestTimeout.abortReason, requestTimeout.details());
          }
          if (error instanceof StreamConsumptionError && !error.diagnostics.hadSinkEmission && attempt < this.maxAttempts) {
            await retryAfter(this.onRetry, this.maxAttempts, this.retryDelayMs, attempt, retrySignal, undefined, request.logContext);
            continue;
          }
          if (error instanceof AppError) throw error;
          throw unreadableStreamingResponse(error, attempt, request.logContext);
        }
      } finally {
        requestTimeout.dispose();
      }
    }
    throw new AppError("MODEL_ERROR", "Model request exhausted its attempts", 502);
  }

  private buildRequest(invocation: ModelInvocation, stream: boolean): ProviderRequest {
    const encoded = encodeOpenAICompatiblePrompt(invocation, this.runtimeContextPlacement);
    const system = encoded.messages.find((message) => message.role === "system");
    const instructions = typeof system?.content === "string" ? system.content : "";
    const encodedInput = encoded.messages
      .filter((message) => message.role !== "system")
      .flatMap((message) => toResponsesInputItems(message));
    const input = encodedInput.length === 0 ? [responsesEmptyInputSentinel()] : encodedInput;
    const providerTools = invocation.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    const toolChoice = invocation.tools.length === 0
      ? undefined
      : toResponsesToolChoice(invocation.toolChoice ?? "auto", this.toolChoiceMode, invocation.tools.length);
    const body = JSON.stringify({
      model: this.model,
      ...(instructions.length === 0 ? {} : { instructions }),
      input,
      tools: providerTools,
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      ...(this.reasoningSummary === undefined ? {} : { reasoning: { summary: this.reasoningSummary } }),
      max_output_tokens: Math.min(
        invocation.maxOutputTokens ?? this.limits.maxOutputTokens,
        this.limits.maxOutputTokens,
      ),
      ...(stream ? { stream: true } : {}),
    });
    return {
      body,
      logContext: modelRequestLogContext({
        protocol: "responses",
        model: this.model,
        invocation,
        stream,
        runtimeContextPlacement: this.runtimeContextPlacement,
        providerInputItemCount: input.length,
        insertedEmptyInputSentinel: encodedInput.length === 0,
        toolChoice,
      }),
    };
  }

  private async consumeStream(
    response: Response,
    sink: ModelStreamSink,
    recordActivity: () => void = () => undefined,
  ): Promise<ModelResponse> {
    if (response.body === null) {
      throw new AppError("MODEL_ERROR", "Model provider returned no streaming body", 502);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoningContent = "";
    const functionCalls = new Map<string, {
      itemId: string; index: number; callId?: string; name?: string; arguments: string;
    }>();
    const readyEmitted = new Set<string>();
    let finalResponse: Record<string, unknown> | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const diagnostics: StreamFailureDiagnostics = {
      eventsSeen: 0,
      hadSinkEmission: false,
    };

    const handleData = async (data: string): Promise<void> => {
      diagnostics.eventsSeen += 1;
      diagnostics.lastEvent = summarizeStreamEvent(data);
      let chunk: ResponsesStreamChunk;
      try {
        chunk = JSON.parse(data) as ResponsesStreamChunk;
      } catch {
        return;
      }
      assertResponsesPayload(chunk);
      switch (chunk.type) {
        case "response.reasoning_summary_text.delta":
          if (typeof chunk.delta === "string" && chunk.delta.length > 0) {
            reasoningContent += chunk.delta;
            await sink({ type: "reasoning_delta", text: chunk.delta });
          }
          break;
        case "response.output_text.delta":
          if (typeof chunk.delta === "string" && chunk.delta.length > 0) {
            content += chunk.delta;
            await sink({ type: "text_delta", text: chunk.delta });
          }
          break;
        case "response.output_item.added": {
          const item = chunk.item;
          if (item?.type !== "function_call") break;
          const itemId = item.id;
          if (itemId === undefined) break;
          functionCalls.set(itemId, {
            itemId,
            index: chunk.output_index ?? functionCalls.size,
            ...(item.call_id === undefined ? {} : { callId: item.call_id }),
            ...(item.name === undefined ? {} : { name: item.name }),
            arguments: "",
          });
          break;
        }
        case "response.function_call_arguments.delta": {
          if (chunk.item_id === undefined || typeof chunk.delta !== "string") break;
          const call = functionCalls.get(chunk.item_id);
          if (call === undefined) break;
          call.arguments += chunk.delta;
          await sink({
            type: "tool_call_delta",
            index: call.index,
            ...(call.callId === undefined ? {} : { id: call.callId }),
            ...(call.name === undefined ? {} : { name: call.name }),
            argumentsDelta: chunk.delta,
          });
          break;
        }
        case "response.function_call_arguments.done": {
          if (chunk.item_id === undefined) break;
          const call = functionCalls.get(chunk.item_id);
          if (call === undefined) break;
          if (typeof chunk.arguments === "string") call.arguments = chunk.arguments;
          await emitReadyIfComplete(call);
          break;
        }
        case "response.output_item.done": {
          const item = chunk.item;
          if (item?.type !== "function_call" || item.id === undefined) break;
          const call = functionCalls.get(item.id);
          if (call === undefined) break;
          if (item.call_id !== undefined) call.callId = item.call_id;
          if (item.name !== undefined) call.name = item.name;
          if (typeof item.arguments === "string" && call.arguments.length === 0) call.arguments = item.arguments;
          await emitReadyIfComplete(call);
          break;
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
          if (chunk.response !== undefined) finalResponse = chunk.response;
          break;
        default:
          break;
      }
    };

    const emitReadyIfComplete = async (call: {
      itemId: string; index: number; callId?: string; name?: string; arguments: string;
    }): Promise<void> => {
      if (readyEmitted.has(call.itemId)) return;
      if (call.callId === undefined || call.name === undefined) return;
      readyEmitted.add(call.itemId);
      await sink({
        type: "tool_call_ready",
        index: call.index,
        id: call.callId,
        name: call.name,
        arguments: parseToolArguments(call.arguments === "" ? "{}" : call.arguments),
      });
    };

    try {
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          throw new StreamConsumptionError("read", error, diagnostics);
        }
        const { done, value } = result;
        if (done) break;
        recordActivity();
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.replaceAll("\r\n", "\n").split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const dataLines: string[] = [];
          for (const line of event.split("\n")) {
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          try {
            await handleData(dataLines.join("\n"));
          } catch (error) {
            if (error instanceof AppError) throw error;
            throw new StreamConsumptionError("consume_event", error, diagnostics);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const final = finalResponse === undefined
      ? undefined
      : parseResponsesResponse(finalResponse, content);
    const usage = finalResponse?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage?.input_tokens !== undefined) inputTokens = usage.input_tokens;
    if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;

    const streamedToolCalls = responseStreamToolCalls(functionCalls);
    if (final !== undefined) {
      const finalToolCalls = final.toolCalls.length > 0 ? final.toolCalls : streamedToolCalls;
      return {
        ...final,
        toolCalls: finalToolCalls,
        finishReason: normalizeFinishReason(final.finishReason, finalToolCalls.length),
        ...(reasoningContent.length === 0 ? {} : { reasoningContent }),
        ...(inputTokens === undefined && outputTokens === undefined
          ? {}
          : {
              usage: {
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
              },
            }),
      };
    }
    const toolCalls = streamedToolCalls;
    return {
      content,
      toolCalls,
      finishReason: normalizeFinishReason(undefined, toolCalls.length),
      ...(reasoningContent.length === 0 ? {} : { reasoningContent }),
      ...(inputTokens === undefined && outputTokens === undefined
        ? {}
        : {
            usage: {
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
            },
          }),
    };
  }
}

function responseStreamToolCalls(
  functionCalls: ReadonlyMap<string, { itemId: string; index: number; callId?: string; name?: string; arguments: string }>,
): ModelToolCall[] {
  const ordered = [...functionCalls.values()].sort((left, right) => left.index - right.index);
  const toolCalls: ModelToolCall[] = [];
  for (const call of ordered) {
    if (call.callId === undefined || call.name === undefined) continue;
    toolCalls.push({
      id: call.callId,
      name: call.name,
      arguments: parseToolArguments(call.arguments === "" ? "{}" : call.arguments),
    });
  }
  return toolCalls;
}

interface ResponsesStreamChunk {
  type?: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  arguments?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: Record<string, unknown>;
}

function parseResponsesResponse(payload: unknown, fallbackContent = ""): ModelResponse {
  const record = payload as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output as Array<Record<string, unknown>> : [];
  const toolCalls: ModelToolCall[] = [];
  const content = responseOutputText(record, output, fallbackContent);
  const reasoningContent = responseReasoningSummary(output);
  for (const [index, item] of output.entries()) {
    if (item.type !== "function_call") continue;
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    const name = typeof item.name === "string" ? item.name : undefined;
    if (callId === undefined || name === undefined) continue;
    toolCalls.push({
      id: callId,
      name,
      arguments: parseToolArguments(typeof item.arguments === "string" ? item.arguments : "{}"),
    });
  }
  const status = typeof record.status === "string" ? record.status : "completed";
  const incompleteDetails = record.incomplete_details as Record<string, unknown> | undefined;
  const finishReason = status === "completed"
    ? (toolCalls.length > 0 ? "tool_calls" as const : "stop" as const)
    : status === "incomplete" ? "length" as const : "error" as const;
  const usage = record.usage as Record<string, unknown> | undefined;
  return {
    content,
    toolCalls,
    finishReason,
    ...(reasoningContent.length === 0 ? {} : { reasoningContent }),
    ...(status === "incomplete" && typeof incompleteDetails?.reason === "string"
      ? { finishReasonDetail: incompleteDetails.reason }
      : {}),
    ...(usage === undefined
      ? {}
      : {
          usage: {
            ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens as number }),
            ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens as number }),
          },
        }),
  };
}

function responseReasoningSummary(output: readonly Record<string, unknown>[]): string {
  const text: string[] = [];
  for (const item of output) {
    if (item.type !== "reasoning" || !Array.isArray(item.summary)) continue;
    for (const part of item.summary) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
      const record = part as Record<string, unknown>;
      if (record.type === "summary_text" && typeof record.text === "string") text.push(record.text);
    }
  }
  return text.join("\n");
}

function assertResponsesPayload(payload: unknown): void {
  if (payload === null || typeof payload !== "object") return;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.choices) && record.output === undefined) {
    throw new AppError(
      "MODEL_ERROR",
      "Configured Responses Provider returned a Chat Completions payload; set protocol to chat-completions",
      502,
      {
        expectedProtocol: "responses",
        observedProtocol: "chat-completions",
        responseShape: ["choices"],
      },
    );
  }
}

function assertChatCompletionsPayload(payload: unknown): void {
  if (payload === null || typeof payload !== "object") return;
  const record = payload as Record<string, unknown>;
  const responseRecord = record.response !== null && typeof record.response === "object"
    ? record.response as Record<string, unknown>
    : undefined;
  const isResponsesPayload = Array.isArray(record.output) && record.choices === undefined;
  const isResponsesStreamEvent = typeof record.type === "string"
    && record.type.startsWith("response.")
    && record.choices === undefined;
  const isNestedResponsesPayload = responseRecord !== undefined
    && Array.isArray(responseRecord.output)
    && record.choices === undefined;
  if (isResponsesPayload || isResponsesStreamEvent || isNestedResponsesPayload) {
    throw new AppError(
      "MODEL_ERROR",
      "Configured Chat Completions Provider returned a Responses payload; set protocol to responses",
      502,
      {
        expectedProtocol: "chat-completions",
        observedProtocol: "responses",
        responseShape: isResponsesStreamEvent ? ["type", "response"] : ["output"],
      },
    );
  }
}

function responseOutputText(
  record: Record<string, unknown>,
  output: readonly Record<string, unknown>[],
  fallbackContent: string,
): string {
  if (typeof record.output_text === "string" && record.output_text.length > 0) return record.output_text;
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type !== "output_text") continue;
      if (typeof part.text === "string" && part.text.length > 0) parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join("") : fallbackContent;
}

function toResponsesInputItems(message: Record<string, unknown>): Record<string, unknown>[] {
  const role = message.role as string;
  if (role === "user") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: message.content as string }] }];
  }
  if (role === "tool") {
    return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
  }
  if (role !== "assistant") return [];
  const text = typeof message.content === "string" ? message.content : "";
  const items: Record<string, unknown>[] = [];
  if (text.length > 0) {
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls as Array<Record<string, unknown>>
    : [];
  for (const call of toolCalls) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: (call.function as Record<string, unknown> | undefined)?.name,
      arguments: (call.function as Record<string, unknown> | undefined)?.arguments ?? "{}",
    });
  }
  return items;
}

function responsesEmptyInputSentinel(): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Continue." }],
  };
}

function toResponsesToolChoice(
  choice: NonNullable<ModelInvocation["toolChoice"]>,
  mode: "native" | "constrained-as-auto" | "named-as-required",
  toolCount: number,
): "auto" | "required" | Readonly<{ type: "function"; name: string }> {
  if (mode === "constrained-as-auto" && choice !== "auto") return "auto";
  if (mode === "named-as-required" && typeof choice !== "string") {
    return toolCount === 1 ? "required" : "auto";
  }
  if (typeof choice === "string") return choice;
  return { type: "function", name: choice.name };
}

function estimateWireTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii));
}

function toProviderToolChoice(
  choice: NonNullable<ModelInvocation["toolChoice"]>,
  mode: "native" | "constrained-as-auto" | "named-as-required",
  toolCount: number,
): "auto" | "required" | Readonly<{ type: "function"; function: { name: string } }> {
  if (mode === "constrained-as-auto" && choice !== "auto") return "auto";
  if (mode === "named-as-required" && typeof choice !== "string") {
    return toolCount === 1 ? "required" : "auto";
  }
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function modelRequestLogContext(options: {
  protocol: ModelRequestLogContext["protocol"];
  model: string;
  invocation: ModelInvocation;
  stream: boolean;
  runtimeContextPlacement: RuntimeContextPlacement;
  providerMessageCount?: number;
  providerInputItemCount?: number;
  insertedEmptyInputSentinel?: boolean;
  toolChoice?: unknown;
}): ModelRequestLogContext {
  return {
    protocol: options.protocol,
    model: options.model,
    phase: options.invocation.phase ?? "unknown",
    stream: options.stream,
    canonicalMessageCount: options.invocation.messages.length,
    ...(options.providerMessageCount === undefined ? {} : { providerMessageCount: options.providerMessageCount }),
    ...(options.providerInputItemCount === undefined ? {} : { providerInputItemCount: options.providerInputItemCount }),
    ...(options.insertedEmptyInputSentinel === undefined ? {} : { insertedEmptyInputSentinel: options.insertedEmptyInputSentinel }),
    toolCount: options.invocation.tools.length,
    toolChoice: describeToolChoice(options.toolChoice),
    runtimeContextPlacement: options.runtimeContextPlacement,
  };
}

function describeToolChoice(value: unknown): string {
  if (value === undefined) return "none";
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "function") {
      const fn = record.function as Record<string, unknown> | undefined;
      const name = typeof record.name === "string" ? record.name : typeof fn?.name === "string" ? fn.name : undefined;
      return name === undefined ? "function" : `function:${name}`;
    }
  }
  return "unknown";
}

function requestRequiresToolCall(toolChoice: string): boolean {
  return toolChoice === "required" || toolChoice.startsWith("function:");
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return /\bapplication\/(?:[a-z0-9.+-]+\+)?json\b/u.test(contentType);
}

async function providerHttpError(response: Response, request: ModelRequestLogContext): Promise<AppError> {
  const bodyText = await safeResponseBodyPreview(response);
  return new AppError("MODEL_ERROR", `Model provider returned HTTP ${response.status}`, 502, {
    status: response.status,
    providerRequestId: response.headers.get("x-request-id") ?? undefined,
    request,
    ...(bodyText === undefined ? {} : { providerErrorBody: bodyText }),
  });
}

function unreadableStreamingResponse(error: unknown, attempts: number, request: ModelRequestLogContext): AppError {
  const streamError = error instanceof StreamConsumptionError ? error : undefined;
  const cause = streamError?.cause ?? error;
  return new AppError("MODEL_ERROR", "Model provider returned an unreadable streaming response", 502, {
    attempts,
    causeName: errorName(cause),
    causeMessage: safeErrorMessage(cause),
    causeCode: transportCauseCode(cause),
    ...(streamError === undefined
      ? {}
      : {
          streamFailureStage: streamError.stage,
          streamEventsSeen: streamError.diagnostics.eventsSeen,
          ...(streamError.diagnostics.lastEvent === undefined
            ? {}
            : { lastStreamEvent: streamError.diagnostics.lastEvent }),
        }),
    request,
  });
}

async function safeResponseBodyPreview(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length === 0) return undefined;
    return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`;
  } catch {
    return undefined;
  }
}

function summarizeStreamEvent(data: string): StreamEventSummary {
  const trimmed = data.trim();
  if (trimmed === "[DONE]") {
    return { dataKind: "done", byteLength: Buffer.byteLength(data, "utf8") };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return {
      dataKind: "json",
      byteLength: Buffer.byteLength(data, "utf8"),
      ...(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? { shape: Object.keys(parsed).sort().slice(0, 12) }
        : {}),
    };
  } catch {
    return { dataKind: "non-json", byteLength: Buffer.byteLength(data, "utf8") };
  }
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error && error.name.length > 0 ? error.name : undefined;
}

function safeErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.message.length === 0) return undefined;
  const compact = error.message.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return undefined;
  return compact.length <= 200 ? compact : `${compact.slice(0, 197)}...`;
}

function isRetryableStatus(status: number): boolean {
  // 400 is included so a transient provider-side rejection (malformed upstream
  // schema check, momentary quota gate) is retried within the same bounded
  // attempt budget instead of failing the Run immediately.
  return status === 400 || status === 408 || status === 429 || status >= 500;
}

interface StreamingModelTimeout {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  readonly abortReason: ModelAbortReason | undefined;
  recordActivity(): void;
  details(): Readonly<Record<string, unknown>>;
  dispose(): void;
}

type ModelAbortReason = "request_timeout" | "stream_idle_timeout" | "stream_wall_timeout" | "cancelled";

function isRetryableStreamingAbort(reason: ModelAbortReason | undefined): boolean {
  return reason === "request_timeout";
}

function streamOperationTimeoutMs(timeoutMs: number): number {
  return Math.min(timeoutMs * STREAM_WALL_TIMEOUT_FACTOR, STREAM_WALL_TIMEOUT_MAX_MS);
}

function createStreamingModelTimeout(timeoutMs: number, externalSignal?: AbortSignal): StreamingModelTimeout {
  const controller = new AbortController();
  const wallTimeoutMs = streamOperationTimeoutMs(timeoutMs);
  let abortReason: ModelAbortReason | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let sawStreamActivity = false;

  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const abort = (reason: ModelAbortReason): void => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    clearIdleTimer();
    if (wallTimer !== undefined) clearTimeout(wallTimer);
    wallTimer = undefined;
    controller.abort(reason);
  };
  const scheduleIdleTimer = (): void => {
    clearIdleTimer();
    const reason = sawStreamActivity ? "stream_idle_timeout" : "request_timeout";
    idleTimer = setTimeout(() => abort(reason), timeoutMs);
    (idleTimer as { unref?: () => void }).unref?.();
  };
  const onExternalAbort = (): void => abort("cancelled");

  if (externalSignal?.aborted) {
    abort("cancelled");
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    scheduleIdleTimer();
    wallTimer = setTimeout(() => abort("stream_wall_timeout"), wallTimeoutMs);
    (wallTimer as { unref?: () => void }).unref?.();
  }

  return {
    signal: controller.signal,
    get aborted() {
      return controller.signal.aborted;
    },
    get abortReason() {
      return abortReason ?? (controller.signal.aborted ? "request_timeout" : undefined);
    },
    recordActivity: () => {
      sawStreamActivity = true;
      scheduleIdleTimer();
    },
    details: () => ({
      abortReason: abortReason ?? "request_timeout",
      idleTimeoutMs: timeoutMs,
      wallTimeoutMs,
    }),
    dispose: () => {
      clearIdleTimer();
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      wallTimer = undefined;
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function modelRequestAborted(reason?: ModelAbortReason, details?: Readonly<Record<string, unknown>>): AppError {
  if (reason === "cancelled") {
    return new AppError("CANCELLED", "Model request was cancelled", 409, details);
  }
  return new AppError("MODEL_ERROR", "Model request timed out", 502, details);
}

function transportCauseCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return transportCauseCode(error.cause);
  return undefined;
}

async function retryAfter(
  onRetry: ModelRetryReporter | undefined,
  maxAttempts: number,
  retryDelayMs: number,
  attempt: number,
  signal: AbortSignal,
  status?: number,
  request?: ModelRequestLogContext,
): Promise<void> {
  const delayMs = retryDelayMs * attempt;
  await onRetry?.({
    attempt,
    maxAttempts,
    ...(status === undefined ? {} : { status }),
    delayMs,
    ...(request === undefined ? {} : { request }),
  });
  await waitForRetry(delayMs, signal);
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw modelRequestAborted();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(modelRequestAborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseToolCall(
  call: { id?: string; function?: { name?: string; arguments?: string } },
  index: number,
): ModelToolCall {
  const id = call.id;
  const name = call.function?.name;
  if (id === undefined || name === undefined) {
    throw new AppError("MODEL_ERROR", `Model provider returned an invalid tool call at index ${index}`, 502);
  }
  const rawArguments = call.function?.arguments ?? "{}";
  return { id, name, arguments: parseToolArguments(rawArguments === "" ? "{}" : rawArguments) };
}

function parseAccumulatedToolCall(id: string, name: string, rawArguments: string): ModelToolCall {
  return { id, name, arguments: parseToolArguments(rawArguments === "" ? "{}" : rawArguments) };
}

function parseToolArguments(rawArguments: string): unknown {
  let argumentsValue = parseToolArgumentsJson(rawArguments);
  if (argumentsValue === undefined) return rawArguments;
  if (typeof argumentsValue === "string") {
    const decodedValue = parseToolArgumentsJson(argumentsValue);
    if (decodedValue !== undefined) argumentsValue = decodedValue;
  }
  return argumentsValue;
}

function parseToolArgumentsJson(rawArguments: string): unknown | undefined {
  try {
    return JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
}

function normalizeFinishReason(reason: string | undefined, toolCallCount: number): ModelResponse["finishReason"] {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || toolCallCount > 0) return "tool_calls";
  if (reason === "stop" || reason === undefined) return "stop";
  return "error";
}
