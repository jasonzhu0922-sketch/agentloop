import type {
  ModelAdapter,
  ModelInvocation,
  ModelResponse,
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
  if (model.streamComplete === undefined) {
    return model.complete(invocation, signal);
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

  const response = await model.streamComplete(invocation, async (event) => {
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
  return response;
}
