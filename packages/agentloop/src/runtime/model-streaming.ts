import type {
  ModelAdapter,
  ModelInvocation,
  ModelRequestLogContext,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  RuntimeEventSink,
} from "./contracts.ts";

/**
 * Throttle interval for coalescing per-token stream deltas into a bounded set
 * of `assistant.streaming` events. Deltas arrive at token frequency; persisting
 * each one would explode the durable event log, so the live projection is
 * flushed at most once per interval and once more at stream end.
 */
export const STREAM_FLUSH_INTERVAL_MS = 500;

export interface PartialStreamToolCall {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments: string;
}

export interface ModelStreamingOptions {
  readonly model: ModelAdapter;
  readonly invocation: ModelInvocation;
  readonly emit: RuntimeEventSink;
  readonly signal?: AbortSignal;
  /** Extra fields carried on each `assistant.streaming` event (e.g. phase). */
  readonly base: Readonly<Record<string, unknown>>;
  /** Invoked when one tool call's arguments are confirmed complete. */
  readonly onToolCallReady?: (call: ModelToolCall) => void | Promise<void>;
}

/**
 * Prefer the model adapter's streaming path. Incremental text and tool-call
 * argument deltas are coalesced into throttled `assistant.streaming` events;
 * the aggregated ModelResponse is returned unchanged. Adapters without native
 * streaming fall back to complete().
 */
export async function completeWithStreaming(options: ModelStreamingOptions): Promise<ModelResponse> {
  const { model, invocation, emit, signal, base, onToolCallReady } = options;
  const stream = model.streamComplete !== undefined;
  const request = model.requestLogContext?.(invocation, stream) ?? fallbackRequestLogContext(invocation, stream);
  const startedAt = Date.now();
  let firstEventAt: number | undefined;
  await emit({ type: "model.request.started", data: { ...base, request } });
  const completed = async (response: ModelResponse): Promise<ModelResponse> => {
    await emit({
      type: "model.request.completed",
      data: {
        ...base,
        request,
        durationMs: Date.now() - startedAt,
        ...(firstEventAt === undefined ? {} : { timeToFirstEventMs: firstEventAt - startedAt }),
        finishReason: response.finishReason,
        contentLength: response.content.length,
        toolCallCount: response.toolCalls.length,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      },
    });
    return response;
  };
  const failed = async (error: unknown): Promise<never> => {
    await emit({
      type: "model.request.failed",
      data: {
        ...base,
        request,
        durationMs: Date.now() - startedAt,
        ...(firstEventAt === undefined ? {} : { timeToFirstEventMs: firstEventAt - startedAt }),
        ...(typeof (error as { code?: unknown })?.code === "string" ? { code: (error as { code: string }).code } : {}),
        message: safeErrorMessage(error),
      },
    });
    throw error;
  };
  if (model.streamComplete === undefined) {
    try {
      return await completed(await model.complete(invocation, signal));
    } catch (error) {
      return await failed(error);
    }
  }
  let partialContent = "";
  const partialToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  let lastFlush = 0;

  const snapshot = (): PartialStreamToolCall[] =>
    [...partialToolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, accumulated]) => ({
        index,
        ...(accumulated.id === undefined ? {} : { id: accumulated.id }),
        ...(accumulated.name === undefined ? {} : { name: accumulated.name }),
        arguments: accumulated.arguments,
      }));

  const flush = async (force: boolean): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastFlush < STREAM_FLUSH_INTERVAL_MS) return;
    if (partialContent.length === 0 && partialToolCalls.size === 0) return;
    lastFlush = now;
    await emit({
      type: "assistant.streaming",
      data: { ...base, content: partialContent, toolCalls: snapshot() },
    });
  };

  try {
    const response = await model.streamComplete(invocation, async (event) => {
      if (firstEventAt === undefined) {
        firstEventAt = Date.now();
        await emit({
          type: "model.stream.first_event",
          data: {
            ...base,
            request,
            elapsedMs: firstEventAt - startedAt,
            eventType: event.type,
            ...streamEventIdentity(event),
          },
        });
      }
      if (event.type === "text_delta") {
        partialContent += event.text;
      } else if (event.type === "tool_call_delta") {
        const accumulated = partialToolCalls.get(event.index) ?? { arguments: "" };
        if (event.id !== undefined) accumulated.id = event.id;
        if (event.name !== undefined) accumulated.name = event.name;
        accumulated.arguments += event.argumentsDelta;
        partialToolCalls.set(event.index, accumulated);
      } else {
        await onToolCallReady?.({ id: event.id, name: event.name, arguments: event.arguments });
      }
      await flush(false);
    }, signal);

    await flush(true);
    return await completed(response);
  } catch (error) {
    return await failed(error);
  }
}

function fallbackRequestLogContext(invocation: ModelInvocation, stream: boolean): ModelRequestLogContext {
  return {
    protocol: "chat-completions",
    model: "unknown",
    phase: invocation.phase ?? "unknown",
    stream,
    canonicalMessageCount: invocation.messages.length,
    toolCount: invocation.tools.length,
    toolChoice: describeInvocationToolChoice(invocation.toolChoice),
    runtimeContextPlacement: invocation.runtimeContext === undefined ? "none" : "unknown",
  };
}

function describeInvocationToolChoice(value: ModelInvocation["toolChoice"]): string {
  if (value === undefined) return "none";
  if (typeof value === "string") return value;
  return `function:${value.name}`;
}

function streamEventIdentity(event: ModelStreamEvent): Record<string, unknown> {
  if (event.type === "text_delta") return {};
  if (event.type === "tool_call_delta") {
    return {
      index: event.index,
      ...(event.id === undefined ? {} : { toolCallId: event.id }),
      ...(event.name === undefined ? {} : { toolName: event.name }),
    };
  }
  return { index: event.index, toolCallId: event.id, toolName: event.name };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return "Model request failed";
  return compact.length <= 200 ? compact : `${compact.slice(0, 197)}...`;
}
