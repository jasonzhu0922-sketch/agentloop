import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModelAdapter, ModelInvocation, ModelResponse, ModelRetryInfo, ModelRetryReporter, ModelStreamEvent, ModelStreamSink } from "@zhujun/agentloop";

/** Credential-free execution metadata; never contains endpoints or upstream model identifiers. */
export interface CloudModelProfile {
  readonly key: string;
  readonly displayName: string;
  readonly limits: ModelAdapter["limits"];
  readonly completeTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly reasoningVisibility: "visible" | "hidden";
}

export class ModelProxyInvocationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ModelProxyRecord =
  | { readonly type: "delta"; readonly event: ModelStreamEvent }
  | { readonly type: "retry"; readonly info: ModelRetryInfo }
  | { readonly type: "result"; readonly response: ModelResponse }
  | { readonly type: "error"; readonly error: string };

export function invocationFrom(value: unknown): ModelInvocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("model_invocation_invalid");
  const input = value as ModelInvocation;
  if (typeof input.runId !== "string" || input.runId.length > 200 || !input.runId || typeof input.systemPrompt !== "string" || !["planning", "execution", "assessment", "compaction"].includes(input.phase) || !Array.isArray(input.messages) || !Array.isArray(input.tools)) throw new TypeError("model_invocation_invalid");
  return input;
}

export async function readModelRequest(request: IncomingMessage): Promise<{ modelKey: string; invocation: ModelInvocation }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16 * 1024 * 1024) throw new TypeError("model_request_too_large");
    chunks.push(buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { modelKey?: unknown; invocation?: unknown };
  if (typeof body?.modelKey !== "string" || body.modelKey.length > 120) throw new TypeError("model_key_invalid");
  return { modelKey: body.modelKey, invocation: invocationFrom(body.invocation) };
}

export function responseAbortSignal(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  return controller.signal;
}

export async function writeModelRecord(response: ServerResponse, record: ModelProxyRecord): Promise<void> {
  if (response.destroyed) throw new Error("model_proxy_disconnected");
  if (!response.write(`${JSON.stringify(record)}\n`)) await once(response, "drain");
}

export async function forwardModelResponse(upstream: Response, response: ServerResponse): Promise<void> {
  if (!upstream.ok || upstream.body === null) {
    await upstream.body?.cancel();
    response.statusCode = upstream.status >= 400 ? upstream.status : 502;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "cloud_model_unavailable" }));
    return;
  }
  response.setHeader("content-type", "application/x-ndjson");
  response.setHeader("cache-control", "no-store");
  try {
    for await (const chunk of upstream.body) {
      if (!response.write(chunk)) await once(response, "drain");
    }
    response.end();
  } catch {
    if (!response.destroyed) response.destroy();
  }
}

/** Decode serially so tool-call deltas and retry events retain provider ordering. */
export async function consumeModelResponse(upstream: Response, sink: ModelStreamSink, onRetry?: ModelRetryReporter): Promise<ModelResponse> {
  if (!upstream.ok || upstream.body === null) {
    await upstream.body?.cancel();
    throw new Error(`cloud_model_unavailable:${upstream.status}`);
  }
  let pending = "";
  let result: ModelResponse | undefined;
  const decoder = new TextDecoder();
  const consume = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    const record = JSON.parse(line) as ModelProxyRecord;
    if (result !== undefined) throw new Error("cloud_model_stream_after_result");
    if (record.type === "delta") await sink(record.event);
    else if (record.type === "retry") await onRetry?.(record.info);
    else if (record.type === "result") result = record.response;
    else if (record.type === "error") throw new ModelProxyInvocationError(502, record.error);
    else throw new Error("cloud_model_record_invalid");
  };
  for await (const chunk of upstream.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      await consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 16 * 1024 * 1024) throw new Error("cloud_model_record_too_large");
  }
  pending += decoder.decode();
  if (pending.trim()) await consume(pending);
  if (result === undefined) throw new Error("cloud_model_stream_incomplete");
  return result;
}
