import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import type { ModelInvocation, ModelProviderIdentity, ModelRequestLogContext, ModelResponse, ModelRetryReporter, ModelStreamRawCaptureWriter, ModelStreamReceipt } from "./contracts.ts";
import type { RuntimeContextPlacement } from "./prompt-protocol.ts";

// Shared Runtime policies. Provider wire encoding/decoding belongs to the AI SDK.
export interface StreamFailureDiagnostics {
  providerResponseId?: string;
  eventsSeen: number;
  hadSinkEmission: boolean;
  lastEvent?: StreamEventSummary;
  readChunkCount: number;
  sseEventCount: number;
  jsonEventCount: number;
  nonJsonEventCount: number;
  doneEventCount: number;
  unrecognizedJsonEventCount: number;
  unterminatedFinalEventBytes: number;
  finishReasonObserved: boolean;
  observedDeltaFields: Set<string>;
  streamReceipt?: ModelStreamReceipt;
}

export interface StreamEventSummary {
  readonly dataKind: "done" | "json" | "non-json";
  readonly byteLength: number;
  readonly shape?: readonly string[];
}

export class StreamConsumptionError extends Error {
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

export const STREAM_WALL_TIMEOUT_FACTOR = 3;
export const STREAM_WALL_TIMEOUT_MAX_MS = 15 * 60 * 1_000;
export const MODEL_OUTPUT_BYTES_PER_TOKEN = 32;
export const MIN_MODEL_OUTPUT_BYTES = 64 * 1024;
export const MODEL_RESPONSE_ENVELOPE_MULTIPLIER = 4;
export const MODEL_RESPONSE_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;
export const MAX_ANOMALOUS_RAW_SSE_CAPTURE_BYTES = 2 * 1024 * 1024;
export const NEVER_ABORT_SIGNAL = new AbortController().signal;

export function createStreamReceiptCollector(input: {
  readonly response: Response;
  readonly runId: string;
  readonly request: ModelRequestLogContext;
  readonly diagnostics: StreamFailureDiagnostics;
  readonly writer?: ModelStreamRawCaptureWriter;
}): Readonly<{
  recordChunk(value: Uint8Array): void;
  build(anomalyReasons: readonly string[], forceTruncated?: boolean): Promise<ModelStreamReceipt>;
}> {
  const rawHash = createHash("sha256");
  const rawCaptureChunks: Buffer[] = [];
  let rawBytes = 0;
  let capturedBytes = 0;
  return {
    recordChunk(value) {
      const rawChunk = Buffer.from(value);
      rawHash.update(rawChunk);
      rawBytes += rawChunk.length;
      if (capturedBytes >= MAX_ANOMALOUS_RAW_SSE_CAPTURE_BYTES) return;
      const retained = rawChunk.subarray(0, MAX_ANOMALOUS_RAW_SSE_CAPTURE_BYTES - capturedBytes);
      rawCaptureChunks.push(Buffer.from(retained));
      capturedBytes += retained.length;
    },
    async build(anomalyReasons, forceTruncated = false) {
      const contentType = input.response.headers.get("content-type") ?? undefined;
      const identity = { ...providerRequestIdentity(input.response), ...providerResponseIdentity({ id: input.diagnostics.providerResponseId }) };
      const rawSha256 = rawHash.copy().digest("hex");
      let rawCapture: ModelStreamReceipt["rawCapture"];
      let rawCaptureError: string | undefined;
      if (anomalyReasons.length > 0 && input.writer !== undefined) {
        try {
          rawCapture = await input.writer({
            schema: "agentloop.modelStreamRawCapture/v1",
            runId: input.runId,
            request: input.request,
            response: {
              status: input.response.status,
              ...(contentType === undefined ? {} : { contentType }),
              ...identity,
            },
            anomalyReasons,
            rawSse: Buffer.concat(rawCaptureChunks),
            rawBytes,
            rawSha256,
            truncated: forceTruncated || capturedBytes < rawBytes,
          });
        } catch (error) {
          rawCaptureError = safeErrorMessage(error) ?? "raw stream capture failed";
        }
      }
      return {
        schema: "agentloop.modelStreamReceipt/v1",
        transport: "sse",
        httpStatus: input.response.status,
        ...(contentType === undefined ? {} : { contentType }),
        ...identity,
        rawBytes,
        rawSha256,
        readChunkCount: input.diagnostics.readChunkCount,
        sseEventCount: input.diagnostics.sseEventCount,
        jsonEventCount: input.diagnostics.jsonEventCount,
        nonJsonEventCount: input.diagnostics.nonJsonEventCount,
        doneEventCount: input.diagnostics.doneEventCount,
        unrecognizedJsonEventCount: input.diagnostics.unrecognizedJsonEventCount,
        unterminatedFinalEventBytes: input.diagnostics.unterminatedFinalEventBytes,
        finishReasonObserved: input.diagnostics.finishReasonObserved,
        sinkEmissionObserved: input.diagnostics.hadSinkEmission,
        observedDeltaFields: [...input.diagnostics.observedDeltaFields].sort(),
        anomalyReasons,
        ...(rawCapture === undefined ? {} : { rawCapture }),
        ...(rawCaptureError === undefined ? {} : { rawCaptureError }),
      };
    },
  };
}

export interface ModelResponseBudget {
  readonly maxOutputTokens: number;
  readonly maxOutputBytes: number;
  readonly maxResponseBytes: number;
  addOutputBytes(value: string, field: string): void;
  replaceOutputBytes(previous: string, value: string, field: string): void;
  assertEventBytes(value: string): void;
  assertResponse(response: ModelResponse): void;
}

export function boundedProviderErrorText(value: unknown, apiKey: string, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) return undefined;
  if (apiKey.length > 0) compact = compact.replaceAll(apiKey, "[REDACTED]");
  compact = compact
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|credential|secret)\s*[:=]\s*["']?)[^\s,;}"']+/giu, "$1[REDACTED]");
  if (compact.length <= maximum) return compact;
  return `${compact.slice(0, Math.max(0, maximum - 3))}...`;
}

export function assertResponsesPayload(payload: unknown): void {
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

export function assertChatCompletionsPayload(payload: unknown): void {
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

export function estimateWireTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii));
}

export function modelRequestLogContext(options: {
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

export function describeToolChoice(value: unknown): string {
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

export function requestRequiresToolCall(toolChoice: string): boolean {
  return toolChoice === "required" || toolChoice.startsWith("function:");
}

export function createModelResponseBudget(
  invocation: ModelInvocation,
  limits: Readonly<{ maxOutputTokens: number }>,
): ModelResponseBudget {
  const maxOutputTokens = Math.min(invocation.maxOutputTokens ?? limits.maxOutputTokens, limits.maxOutputTokens);
  const maxOutputBytes = Math.max(MIN_MODEL_OUTPUT_BYTES, maxOutputTokens * MODEL_OUTPUT_BYTES_PER_TOKEN);
  const maxResponseBytes = maxOutputBytes * MODEL_RESPONSE_ENVELOPE_MULTIPLIER
    + MODEL_RESPONSE_ENVELOPE_OVERHEAD_BYTES;
  let outputBytes = 0;

  const assertOutputBytes = (observedBytes: number, field: string): void => {
    if (observedBytes <= maxOutputBytes) return;
    throw modelResponseLimitError({
      limitKind: "output",
      field,
      maxOutputTokens,
      maxBytes: maxOutputBytes,
      observedBytes,
    });
  };

  return {
    maxOutputTokens,
    maxOutputBytes,
    maxResponseBytes,
    addOutputBytes(value, field) {
      outputBytes += Buffer.byteLength(value);
      assertOutputBytes(outputBytes, field);
    },
    replaceOutputBytes(previous, value, field) {
      outputBytes = Math.max(0, outputBytes - Buffer.byteLength(previous)) + Buffer.byteLength(value);
      assertOutputBytes(outputBytes, field);
    },
    assertEventBytes(value) {
      const observedBytes = Buffer.byteLength(value);
      if (observedBytes <= maxResponseBytes) return;
      throw modelResponseLimitError({
        limitKind: "stream_event",
        field: "event",
        maxOutputTokens,
        maxBytes: maxResponseBytes,
        observedBytes,
      });
    },
    assertResponse(response) {
      assertOutputBytes(modelResponseOutputBytes(response), "response");
    },
  };
}

export function modelResponseOutputBytes(response: ModelResponse): number {
  let bytes = Buffer.byteLength(response.content);
  if (response.reasoningContent !== undefined) bytes += Buffer.byteLength(response.reasoningContent);
  for (const call of response.toolCalls) bytes += Buffer.byteLength(safeJsonStringify(call.arguments));
  return bytes;
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function modelResponseLimitError(input: {
  readonly limitKind: "output" | "response" | "stream_event";
  readonly field: string;
  readonly maxOutputTokens: number;
  readonly maxBytes: number;
  readonly observedBytes: number;
}): AppError {
  return new AppError("MODEL_ERROR", "Model provider response exceeded the configured output budget", 502, {
    limitKind: input.limitKind,
    field: input.field,
    maxOutputTokens: input.maxOutputTokens,
    maxBytes: input.maxBytes,
    observedBytes: input.observedBytes,
  });
}

export async function readJsonResponseWithinLimit(response: Response, budget: ModelResponseBudget): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const observedBytes = Number(declaredLength);
    if (Number.isFinite(observedBytes) && observedBytes > budget.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw modelResponseLimitError({
        limitKind: "response",
        field: "body",
        maxOutputTokens: budget.maxOutputTokens,
        maxBytes: budget.maxResponseBytes,
        observedBytes,
      });
    }
  }
  // Keep compatibility with injected/fake Responses that expose json() but no
  // ReadableStream while using the bounded reader for real fetch responses.
  if (response.body == null) return await response.json() as unknown;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let observedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      observedBytes += value.byteLength;
      if (observedBytes > budget.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw modelResponseLimitError({
          limitKind: "response",
          field: "body",
          maxOutputTokens: budget.maxOutputTokens,
          maxBytes: budget.maxResponseBytes,
          observedBytes,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return /\bapplication\/(?:[a-z0-9.+-]+\+)?json\b/u.test(contentType);
}

export function providerRequestIdentity(response: Response): ModelProviderIdentity {
  const providerRequestId = response.headers.get("x-request-id")?.trim();
  const providerGatewayRequestId = response.headers.get("x-oneapi-request-id")?.trim();
  return {
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerGatewayRequestId ? { providerGatewayRequestId } : {}),
  };
}

export function providerResponseIdentity(payload: unknown): ModelProviderIdentity {
  if (payload === null || typeof payload !== "object") return {};
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0 ? { providerResponseId: id } : {};
}

export function withProviderRequestIdentity(error: AppError, response: Response): AppError {
  const identity = providerRequestIdentity(response);
  if (Object.keys(identity).length === 0) return error;
  return new AppError(error.code, error.message, error.status, { ...error.details, ...identity });
}

export async function providerHttpError(response: Response, request: ModelRequestLogContext, apiKey = ""): Promise<AppError> {
  const bodyText = boundedProviderErrorText(await safeResponseBodyPreview(response), apiKey, 500);
  return new AppError("MODEL_ERROR", `Model provider returned HTTP ${response.status}`, 502, {
    status: response.status,
    ...providerRequestIdentity(response),
    request,
    ...(bodyText === undefined ? {} : { providerErrorBody: bodyText }),
  });
}

export function unreadableStreamingResponse(error: unknown, attempts: number, request: ModelRequestLogContext): AppError {
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
          ...(streamError.diagnostics.streamReceipt === undefined
            ? {}
            : { streamReceipt: streamError.diagnostics.streamReceipt }),
          ...(streamError.diagnostics.lastEvent === undefined
            ? {}
            : { lastStreamEvent: streamError.diagnostics.lastEvent }),
        }),
    request,
  });
}

export async function safeResponseBodyPreview(response: Response): Promise<string | undefined> {
  try {
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (bytes < 4096) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.subarray(0, 4096 - bytes);
        chunks.push(chunk); bytes += chunk.byteLength;
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString("utf8");
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length === 0) return undefined;
    return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`;
  } catch {
    return undefined;
  }
}

export function streamFailureAnomalyReasons(
  error: unknown,
  diagnostics: StreamFailureDiagnostics,
): string[] {
  const failureStage = error instanceof AppError && typeof error.details?.streamFailureStage === "string"
    ? error.details.streamFailureStage
    : undefined;
  const reasons = [failureStage === "provider_error_event"
    ? "provider_error_event"
    : failureStage === "missing_terminal_event"
      ? "missing_terminal_event"
      : error instanceof AppError && /protocol|payload/u.test(error.message.toLowerCase())
        ? "provider_protocol_mismatch"
        : "stream_consumption_failed"];
  if (diagnostics.nonJsonEventCount > 0) reasons.push("non_json_sse_data");
  if (diagnostics.unrecognizedJsonEventCount > 0) reasons.push("unrecognized_json_event");
  if (diagnostics.unterminatedFinalEventBytes > 0) reasons.push("unterminated_final_sse_event");
  return reasons;
}

export function streamAnomalyReasons(
  response: ModelResponse,
  diagnostics: StreamFailureDiagnostics,
): string[] {
  const reasons: string[] = [];
  const hasProviderOutput = response.content.length > 0
    || (response.reasoningContent?.length ?? 0) > 0
    || response.toolCalls.length > 0;
  // Reserved wire/control markers in visible content are useful forensic
  // evidence even when SSE and its terminal event are well formed. Preserve
  // the exact response and capture the wire bytes; never decode these strings
  // into executable calls or silently remove them from the model transcript.
  const normalizedContent = response.content.replaceAll("｜", "|");
  if (/<\|begin▁of▁sentence\|>|(?:<)?\|+DSML\|+\s*(?:calls|invoke|parameter)\b|<\/?ds_safety\b/iu.test(normalizedContent)) {
    reasons.push("provider_protocol_text_in_content");
  }
  if (response.finishReason === "stop" && response.content.trim().length === 0 && response.toolCalls.length === 0) {
    reasons.push("empty_stop_completion");
  }
  if (!diagnostics.hadSinkEmission) reasons.push("no_stream_delta");
  if (!diagnostics.finishReasonObserved) reasons.push("missing_finish_reason");
  if (diagnostics.nonJsonEventCount > 0) reasons.push("non_json_sse_data");
  if (diagnostics.unrecognizedJsonEventCount > 0) reasons.push("unrecognized_json_event");
  if (diagnostics.unterminatedFinalEventBytes > 0) reasons.push("unterminated_final_sse_event");
  if ((response.usage?.outputTokens ?? 0) > 0 && !hasProviderOutput) reasons.push("usage_output_without_payload");
  if (response.usage?.outputTokens === 0 && hasProviderOutput) reasons.push("zero_output_usage_with_payload");
  return reasons;
}

export function summarizeStreamEvent(data: string): StreamEventSummary {
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

export function errorName(error: unknown): string | undefined {
  return error instanceof Error && error.name.length > 0 ? error.name : undefined;
}

export function safeErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.message.length === 0) return undefined;
  const compact = error.message.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return undefined;
  return compact.length <= 200 ? compact : `${compact.slice(0, 197)}...`;
}

export function isRetryableStatus(status: number): boolean {
  // 400 is included so a transient provider-side rejection (malformed upstream
  // schema check, momentary quota gate) is retried within the same bounded
  // attempt budget instead of failing the Run immediately.
  return status === 400 || status === 408 || status === 429 || status >= 500;
}

export interface StreamingModelTimeout {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  readonly abortReason: ModelAbortReason | undefined;
  recordActivity(): void;
  details(): Readonly<Record<string, unknown>>;
  dispose(): void;
}

type ModelAbortReason = "request_timeout" | "stream_idle_timeout" | "stream_wall_timeout" | "cancelled";

export function isRetryableStreamingAbort(reason: ModelAbortReason | undefined): boolean {
  return reason === "request_timeout";
}

export function streamOperationTimeoutMs(timeoutMs: number): number {
  return Math.min(timeoutMs * STREAM_WALL_TIMEOUT_FACTOR, STREAM_WALL_TIMEOUT_MAX_MS);
}

export function createStreamingModelTimeout(timeoutMs: number, externalSignal?: AbortSignal): StreamingModelTimeout {
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

export function modelRequestAborted(reason?: ModelAbortReason, details?: Readonly<Record<string, unknown>>): AppError {
  if (reason === "cancelled") {
    return new AppError("CANCELLED", "Model request was cancelled", 409, details);
  }
  return new AppError("MODEL_ERROR", "Model request timed out", 502, details);
}

export function transportCauseCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return transportCauseCode(error.cause);
  return undefined;
}

export async function retryAfter(
  onRetry: ModelRetryReporter | undefined,
  maxAttempts: number,
  retryDelayMs: number,
  attempt: number,
  signal: AbortSignal,
  status?: number,
  request?: ModelRequestLogContext,
  providerFailure?: ModelProviderIdentity & Readonly<{ providerErrorBody?: string }>,
): Promise<void> {
  const delayMs = retryDelayMs * attempt;
  await onRetry?.({
    attempt,
    maxAttempts,
    ...(status === undefined ? {} : { status }),
    ...providerFailure,
    delayMs,
    ...(request === undefined ? {} : { request }),
  });
  await waitForRetry(delayMs, signal);
}

export function missingResponsesTerminalEvent(
  request: ModelRequestLogContext,
  diagnostics: StreamFailureDiagnostics,
): AppError {
  return new AppError("MODEL_ERROR", "Responses Provider stream ended without a terminal response event", 502, {
    streamFailureStage: "missing_terminal_event",
    streamEventsSeen: diagnostics.eventsSeen,
    ...(diagnostics.lastEvent === undefined ? {} : { lastStreamEvent: diagnostics.lastEvent }),
    request,
  });
}

export async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
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

export function parseToolArguments(rawArguments: unknown): unknown {
  let argumentsValue = rawArguments;
  // Providers occasionally encode function arguments more than once (for
  // example, a JSON string inside a JSON string). Normalize the transport
  // representation here so every protocol reaches Runtime with the same
  // object-or-invalid-value contract. Keep the bound to avoid chasing an
  // arbitrary string chain supplied by a provider.
  for (let depth = 0; depth < 4 && typeof argumentsValue === "string"; depth += 1) {
    const decodedValue = parseToolArgumentsJson(argumentsValue);
    if (decodedValue === undefined) break;
    argumentsValue = decodedValue;
  }
  return argumentsValue;
}

export function parseToolArgumentsJson(rawArguments: string): unknown | undefined {
  try {
    return JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
}
