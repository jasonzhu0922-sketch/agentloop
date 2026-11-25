import { AppError } from "../shared/errors.ts";
import type {
  ModelAdapter,
  ModelProviderIdentity,
  ModelInvocation,
  ModelRequestLogContext,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  RuntimeEventSink,
} from "./contracts.ts";
import { modelPerformanceTimingFromError } from "./model-provider-policy.ts";

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
  /**
   * `internal` turns still publish request lifecycle telemetry, but their
   * provider text, reasoning, and tool-call argument deltas must not become a
   * user-facing assistant draft.
   */
  readonly responseVisibility?: "public" | "internal";
  /** Keep provider reasoning internal for phases such as planning. */
  readonly suppressReasoningContent?: boolean;
  /** Invoked when one tool call's arguments are confirmed complete. */
  readonly onToolCallReady?: (call: ModelToolCall) => void | Promise<void>;
}

export interface ModelRequestTelemetryOptions {
  readonly model: ModelAdapter;
  readonly invocation: ModelInvocation;
  readonly emit: RuntimeEventSink;
  readonly signal?: AbortSignal;
  /** Extra fields carried on the request lifecycle events. */
  readonly base: Readonly<Record<string, unknown>>;
}

/**
 * Execute a non-streaming model request while publishing the same durable
 * request lifecycle used by the streaming path. This is for structured
 * pre-planning calls such as conversation-turn resolution: they have no
 * user-visible deltas, but must never appear as a silent dispatched Action.
 */
export async function completeWithRequestTelemetry(options: ModelRequestTelemetryOptions): Promise<ModelResponse> {
  const { model, invocation, emit, signal, base } = options;
  const request = model.requestLogContext?.(invocation, false) ?? fallbackRequestLogContext(invocation, false);
  const contextComposition = modelInvocationComposition(invocation);
  const startedAt = Date.now();
  await emit({ type: "model.request.started", data: { ...base, request, contextComposition } });
  try {
    const response = await model.complete(invocation, signal);
    if (signal?.aborted === true) throw new AppError("CANCELLED", "Run was cancelled", 409);
    await emit({
      type: "model.request.completed",
      data: {
        ...base,
        request,
        durationMs: Date.now() - startedAt,
        finishReason: response.finishReason,
        contentLength: response.content.length,
        toolCallCount: response.toolCalls.length,
        ...providerIdentity(response),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(response.streamReceipt === undefined ? {} : { streamReceipt: response.streamReceipt }),
        ...(response.performanceTiming === undefined ? {} : { performanceTiming: response.performanceTiming }),
      },
    });
    return response;
  } catch (error) {
    const streamReceipt = streamReceiptFromError(error);
    const identity = error instanceof AppError ? providerIdentity(error.details) : {};
    const performanceTiming = modelPerformanceTimingFromError(error);
    await emit({
      type: "model.request.failed",
      data: {
        ...base,
        request,
        durationMs: Date.now() - startedAt,
        ...(typeof (error as { code?: unknown })?.code === "string" ? { code: (error as { code: string }).code } : {}),
        message: safeErrorMessage(error),
        ...identity,
        ...(performanceTiming === undefined ? {} : { performanceTiming }),
        ...(streamReceipt === undefined ? {} : { streamReceipt }),
      },
    });
    throw error;
  }
}

/**
 * Prefer the model adapter's streaming path. Incremental reply, reasoning, and
 * tool-call argument deltas are coalesced into throttled `assistant.streaming` events;
 * the aggregated ModelResponse is returned unchanged. Adapters without native
 * streaming fall back to complete().
 */
export async function completeWithStreaming(options: ModelStreamingOptions): Promise<ModelResponse> {
  const { model, invocation, emit, signal, base, onToolCallReady } = options;
  const internalResponse = options.responseVisibility === "internal";
  const visibility = internalResponse ? { responseVisibility: "internal" } : {};
  // Planner responses never retain reasoning. The global visibility setting
  // instead hides only events: DeepSeek still needs the opaque state in the
  // internal response/transcript for the next Chat Completions turn.
  const suppressResponseReasoning = internalResponse || options.suppressReasoningContent === true || invocation.plannerRequest === true;
  const suppressReasoningEvents = suppressResponseReasoning || model.reasoningVisibility === "hidden";
  const stream = model.streamComplete !== undefined;
  const request = model.requestLogContext?.(invocation, stream) ?? fallbackRequestLogContext(invocation, stream);
  const contextComposition = modelInvocationComposition(invocation);
  const startedAt = Date.now();
  let firstEventAt: number | undefined;
  await emit({ type: "model.request.started", data: { ...base, ...visibility, request, contextComposition } });
  const completed = async (response: ModelResponse): Promise<ModelResponse> => {
    await emit({
      type: "model.request.completed",
      data: {
        ...base,
        ...visibility,
        request,
        durationMs: Date.now() - startedAt,
        ...(firstEventAt === undefined ? {} : { timeToFirstEventMs: firstEventAt - startedAt }),
        finishReason: response.finishReason,
        contentLength: response.content.length,
        toolCallCount: response.toolCalls.length,
        ...providerIdentity(response),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(response.streamReceipt === undefined ? {} : { streamReceipt: response.streamReceipt }),
        ...(response.performanceTiming === undefined ? {} : { performanceTiming: response.performanceTiming }),
      },
    });
    return response;
  };
  const failed = async (error: unknown): Promise<never> => {
    const streamReceipt = streamReceiptFromError(error);
    const identity = error instanceof AppError ? providerIdentity(error.details) : {};
    const performanceTiming = modelPerformanceTimingFromError(error);
    await emit({
      type: "model.request.failed",
      data: {
        ...base,
        ...visibility,
        request,
        durationMs: Date.now() - startedAt,
        ...(firstEventAt === undefined ? {} : { timeToFirstEventMs: firstEventAt - startedAt }),
        ...(typeof (error as { code?: unknown })?.code === "string" ? { code: (error as { code: string }).code } : {}),
        message: safeErrorMessage(error),
        ...identity,
        ...(performanceTiming === undefined ? {} : { performanceTiming }),
        ...(streamReceipt === undefined ? {} : { streamReceipt }),
      },
    });
    throw error;
  };
  if (model.streamComplete === undefined) {
    try {
      const response = await model.complete(invocation, signal);
      return await completed(suppressResponseReasoning ? withoutReasoningContent(response) : response);
    } catch (error) {
      return await failed(error);
    }
  }
  let partialContent = "";
  let partialReasoningContent = "";
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
    if (internalResponse) return;
    const now = Date.now();
    if (!force && now - lastFlush < STREAM_FLUSH_INTERVAL_MS) return;
    if (partialContent.length === 0 && partialReasoningContent.length === 0 && partialToolCalls.size === 0) return;
    lastFlush = now;
    await emit({
      type: "assistant.streaming",
      data: {
        ...base,
        content: partialContent,
        ...(partialReasoningContent.length === 0 ? {} : { reasoningContent: partialReasoningContent }),
        toolCalls: snapshot(),
      },
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
            ...visibility,
            request,
            elapsedMs: firstEventAt - startedAt,
            eventType: event.type,
            ...streamEventIdentity(event),
          },
        });
      }
      if (event.type === "text_delta") {
        partialContent += event.text;
      } else if (event.type === "reasoning_delta") {
        if (!suppressReasoningEvents) partialReasoningContent += event.text;
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
    return await completed(suppressResponseReasoning ? withoutReasoningContent(response) : response);
  } catch (error) {
    return await failed(error);
  }
}

function withoutReasoningContent(response: ModelResponse): ModelResponse {
  if (response.reasoningContent === undefined) return response;
  const { reasoningContent: _reasoningContent, ...withoutReasoning } = response;
  return withoutReasoning;
}

/** Neutral request-size telemetry. Top-level components are mutually exclusive and additive. */
export function modelInvocationComposition(invocation: ModelInvocation): Readonly<Record<string, unknown>> {
  const components: Record<string, { text: string; references: number }> = {
    systemPrompt: { text: invocation.systemPrompt, references: invocation.systemPrompt.length === 0 ? 0 : 1 },
    toolSchemas: { text: JSON.stringify(invocation.tools), references: invocation.tools.length },
    runtimeContext: { text: invocation.runtimeContext?.content ?? "", references: invocation.runtimeContext === undefined ? 0 : 1 },
    userMessages: { text: "", references: 0 },
    assistantText: { text: "", references: 0 },
    assistantReasoning: { text: "", references: 0 },
    assistantToolArguments: { text: "", references: 0 },
    skillResults: { text: "", references: 0 },
    otherToolResults: { text: "", references: 0 },
  };
  for (const message of invocation.messages) {
    if (message.role === "user") appendComponent(components.userMessages, message.content);
    else if (message.role === "assistant") {
      appendComponent(components.assistantText, message.content);
      if (message.reasoningContent !== undefined) appendComponent(components.assistantReasoning, message.reasoningContent);
      for (const call of message.toolCalls ?? []) appendComponent(components.assistantToolArguments, JSON.stringify(call.arguments));
    } else if (message.name === "load_skill") appendComponent(components.skillResults, message.content);
    else appendComponent(components.otherToolResults, message.content);
  }
  const componentCharacters = Object.fromEntries(Object.entries(components).map(([key, value]) => [key, value.text.length]));
  const componentEstimatedTokens = Object.fromEntries(Object.entries(components).map(([key, value]) => [key, estimateTextTokens(value.text)]));
  const componentReferences = Object.fromEntries(Object.entries(components).map(([key, value]) => [key, value.references]));
  const totalCharacters = Object.values(componentCharacters).reduce((total, value) => total + value, 0);
  const totalEstimatedTokens = Object.values(componentEstimatedTokens).reduce((total, value) => total + value, 0);
  const totalReferences = Object.values(componentReferences).reduce((total, value) => total + value, 0);
  const runtimeDiagnostics = invocation.runtimeContext === undefined
    ? undefined : structuredFieldDiagnostics(invocation.runtimeContext.content, ["candidateOutput", "deliveryFacts", "evidenceTimeline", "runtimeEvidenceBundles"]);
  return {
    schema: "agentloop.modelContextComposition/v1",
    phase: invocation.phase,
    accounting: "top_level_components_are_mutually_exclusive; diagnostics_are_subcomponents_and_must_not_be_added_to_totals",
    componentCharacters,
    componentEstimatedTokens,
    componentReferences,
    totalCharacters,
    totalEstimatedTokens,
    totalReferences,
    decisionContextDiagnostics: decisionContextDiagnostics(invocation),
    ...(runtimeDiagnostics === undefined || Object.keys(runtimeDiagnostics).length === 0 ? {} : { runtimeContextDiagnostics: runtimeDiagnostics }),
  };
}

/** Subcomponent diagnostics, never added to the mutually exclusive top-level totals. */
function decisionContextDiagnostics(invocation: ModelInvocation): Record<string, unknown> {
  const content = invocation.runtimeContext?.content ?? "";
  const section = (tag: string) => {
    const match = content.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    const value = match?.[1] ?? "";
    return { characters: value.length, estimatedTokens: estimateTextTokens(value) };
  };
  const native = invocation.messages.filter(message => message.role === "tool" || message.role === "assistant" && (message.toolCalls?.length || message.reasoningContent !== undefined));
  const measure = (value: unknown) => { const text = typeof value === "string" ? value : JSON.stringify(value); return { characters: text.length, estimatedTokens: estimateTextTokens(text) }; };
  let assessment: Record<string, any> | undefined;
  let items: Array<{ category?: string }> = [];
  let workingSet: Record<string, any> | undefined;
  try {
    const encoded = content.match(/<assessment_context[^>]*>([\s\S]*?)<\/assessment_context>/)?.[1];
    if (encoded) assessment = JSON.parse(encoded);
    workingSet = assessment?.decisionWorkingSet ?? JSON.parse(content.match(/<decision_working_set[^>]*>([\s\S]*?)<\/decision_working_set>/)?.[1] ?? "{}");
    items = workingSet?.items ?? [];
    if (!Array.isArray(items)) items = [];
  } catch { /* Diagnostics cannot affect execution. */ }
  const details = invocation.messages.filter(message => message.role === "tool" && message.name === "read_result");
  return { accounting: "diagnostic_subcomponents_not_additive_to_totals; character_estimates_are_not_provider_usage_or_billing",
    currentStateAndProducts: assessment ? measure({ canonicalRunState: assessment.canonicalRunState, currentDecisionView: assessment.currentDecisionView }) : section("loop_step_frame"),
    currentWorkingSetAndHistoryIndex: assessment ? measure(assessment.decisionWorkingSet ?? {}) : section("decision_working_set"),
    historicalHints: section("execution_history"),
    currentSemanticState: measure(items.filter(item => !["decision", "commitment"].includes(item.category ?? ""))),
    semanticHistoricalHints: measure(items.filter(item => ["decision", "commitment"].includes(item.category ?? ""))),
    exactCurrentEvidence: measure(workingSet?.currentEvidence ?? []),
    historyDetails: assessment ? measure({ evidence: assessment.evidence, evidenceTimeline: assessment.evidenceTimeline }) : measure(details.map(message => message.content)),
    ...(assessment?.evidenceEncoding === undefined ? {} : { assessmentEvidenceEncoding: {
      sourceCharacters: assessment.evidenceEncoding.sourceCharacters, projectedCharacters: assessment.evidenceEncoding.projectedCharacters,
      parsedResults: assessment.evidenceEncoding.parsedResults, sharedReferences: assessment.evidenceEncoding.sharedReferences,
    } }),
    nativeProtocol: { messages: native.length, characters: JSON.stringify(native).length,
      reasoningCharacters: invocation.messages.reduce((sum, message) => sum + (message.role === "assistant" ? message.reasoningContent?.length ?? 0 : 0), 0) },
    residentHistoryReadCount: details.length,
  };
}

function appendComponent(component: { text: string; references: number }, value: string): void {
  component.text += value;
  component.references += 1;
}

function structuredFieldDiagnostics(content: string, fields: readonly string[]): Readonly<Record<string, unknown>> {
  const metrics = Object.fromEntries(fields.map((field) => [field, { characters: 0, references: 0 }])) as Record<string, { characters: number; references: number }>;
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const metric = metrics[key];
      if (metric !== undefined) { metric.characters += JSON.stringify(child).length; metric.references += 1; }
      visit(child, depth + 1);
    }
  };
  try { visit(JSON.parse(content), 0); } catch { return {}; }
  return Object.fromEntries(Object.entries(metrics).filter(([, metric]) => metric.references > 0));
}

function estimateTextTokens(value: string): number {
  if (value.length === 0) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) character.codePointAt(0)! <= 0x7f ? ascii += 1 : nonAscii += 1;
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii));
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
  if (event.type === "text_delta" || event.type === "reasoning_delta") return {};
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

function streamReceiptFromError(error: unknown): unknown | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) return undefined;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("streamReceipt" in details)) return undefined;
  return details.streamReceipt;
}

function providerIdentity(value: unknown): ModelProviderIdentity {
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const receipt = record.streamReceipt as Record<string, unknown> | undefined;
  const identity: Record<string, string> = {};
  for (const key of ["providerRequestId", "providerGatewayRequestId", "providerResponseId"]) {
    const id = record[key] ?? receipt?.[key];
    if (typeof id === "string" && id.trim().length > 0) identity[key] = id;
  }
  return identity;
}
