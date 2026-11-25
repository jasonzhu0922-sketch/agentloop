import { createHash } from "node:crypto";
import { contentStructure, CONTENT_REFERENCE_WINDOW_CHARACTERS } from "./content-reference.ts";
import { parseRuntimeResultRef } from "./runtime-result.ts";

const RECEIPT_FACT_PREVIEW_CHARACTERS = 4_000;

export function isCommandResult(value: unknown): value is Record<string, unknown> & { stdout: string; stderr: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "exitCode" in value && "stdout" in value && typeof value.stdout === "string"
    && "stderr" in value && typeof value.stderr === "string";
}

/** A view of an already committed command Result; never a replacement payload. */
export function projectCommandResult(value: unknown): Record<string, unknown> | undefined {
  if (!isCommandResult(value)) return undefined;
  const result = value;
  if (result.schema === "agentloop.contextCommandResult/v1") return undefined;
  const resultRef = parseRuntimeResultRef(result.resultRef);
  if (resultRef === undefined) return undefined;
  // Keep a bounded observation usable in this same Result view. Stream
  // structure and executor receipts cannot replace the actual returned values.
  const completeStreams = result.stdout.length + result.stderr.length <= CONTENT_REFERENCE_WINDOW_CHARACTERS;
  let stdout: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) stdout = parsed as Record<string, unknown>;
  } catch { /* Plain command output is still exactly readable through the Result. */ }
  return {
    schema: "agentloop.contextCommandResult/v1",
    resultRef,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    fileChanges: result.fileChanges,
    fileChangesTruncated: result.fileChangesTruncated,
    outputBindings: result.outputBindings,
    executionReceipt: projectReceipt(result.executionReceipt),
    evidenceReceipt: projectReceipt(result.evidenceReceipt),
    computationReceipt: projectReceipt(result.computationReceipt),
    computationEvidenceError: result.computationEvidenceError,
    computationEvidenceFailure: result.computationEvidenceFailure,
    computationObservation: projectReceipt(result.computationObservation),
    workflowEvidenceReceipt: projectReceipt(result.workflowEvidenceReceipt),
    // Only the executor may promote Skill-root control signals. Raw stdout is content.
    controlSignals: result.controlSignals,
    sourceSchema: stdout?.schema,
    deliveryCandidate: stdout?.deliveryCandidate,
    delivery_markdown: stdout?.delivery_markdown,
    assessmentProjection: stdout?.assessmentProjection,
    assessment_summary: stdout?.assessment_summary,
    decisionClaim: stdout?.decisionClaim,
    streams: ["stdout", "stderr"].map((name) => {
      const content = result[name] as string;
      return { pointer: `/${name}`, characters: content.length,
        returnedCharacters: completeStreams ? content.length : Math.min(content.length, 800),
        complete: completeStreams || content.length <= 800,
        summary: contentStructure(content) };
    }),
    stdout: completeStreams ? result.stdout : result.stdout.slice(0, 800),
    stderr: completeStreams ? result.stderr : result.stderr.slice(0, 800),
    instruction: "This is a bounded model-visible view of the same committed Runtime Result. A stream with complete=true contains its exact stored text here; use it directly. Large receipts retain their explicit protocol identity, declared source refs, caveats, top-level structure and immutable digest while their full facts stay in this Result. Use read_result with this resultRef.resultId and the exact receipt pointer shown by contentReference.pointer; use character windows only when the selected value is a string. For oversized objects or arrays, use the returned childPointers or a narrower JSON Pointer. Do not reopen a file or rerun the command to recover omitted output. Projection completeness does not change execution/source truncation, and structural summaries do not replace the persisted facts.",
  };
}

/** Preserve receipt authority while keeping repeated model transport bounded. */
function projectReceipt(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object") return value;
  const serialized = JSON.stringify(value);
  if (serialized.length <= CONTENT_REFERENCE_WINDOW_CHARACTERS) return value;
  const record = !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const facts = record?.facts;
  const deliveryFacts = record?.deliveryFacts;
  return removeUndefined({
    schema: "agentloop.contextReceiptProjection/v1",
    sourceSchema: typeof record?.schema === "string" ? record.schema : undefined,
    receiptId: typeof record?.receiptId === "string" ? record.receiptId : undefined,
    sourceType: typeof record?.sourceType === "string" ? record.sourceType : undefined,
    sourceRefs: boundedArray(record?.sourceRefs, 12),
    output: boundedValue(record?.output, 2_000),
    evidenceKinds: record?.evidenceKinds,
    workflowProgress: boundedValue(record?.workflowProgress, 2_000),
    caveats: boundedArray(record?.caveats, 24),
    factCount: Array.isArray(facts) ? facts.length : objectSize(facts),
    factPreview: boundedValue(facts, RECEIPT_FACT_PREVIEW_CHARACTERS),
    deliveryFacts: deliveryFacts === undefined ? undefined : projectedValueReference(deliveryFacts),
    structure: valueStructure(value),
    contentReference: {
      schema: "agentloop.resultValueReference/v1",
      pointer: receiptPointer(record?.schema),
      valueType: valueType(value),
    },
    originalCharacters: serialized.length,
    originalSha256: sha256(serialized),
    complete: false,
  });
}

function projectedValueReference(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  return removeUndefined({
    schema: "agentloop.contextValueReference/v1",
    sourceSchema: value !== null && typeof value === "object" && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).schema === "string"
      ? (value as Record<string, unknown>).schema : undefined,
    originalCharacters: serialized.length,
    originalSha256: sha256(serialized),
    preview: serialized.slice(0, 2_000),
    topLevelFields: value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).slice(0, 64) : undefined,
    itemCount: Array.isArray(value) ? value.length : undefined,
  });
}

function receiptPointer(schema: unknown): string | undefined {
  if (schema === "agentloop.commandExecutionReceipt/v1") return "/executionReceipt";
  if (schema === "agentloop.toolEvidenceReceipt/v1") return "/evidenceReceipt";
  if (schema === "agentloop.commandComputationReceipt/v1") return "/computationReceipt";
  if (schema === "agentloop.workflowEvidenceReceipt/v1") return "/workflowEvidenceReceipt";
  return undefined;
}

function valueStructure(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    return { type: "object", keys: keys.slice(0, 64), omittedKeys: Math.max(0, keys.length - 64) };
  }
  return { type: valueType(value) };
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function boundedArray(value: unknown, limit: number): unknown {
  return Array.isArray(value) ? value.slice(0, limit).map(item => boundedValue(item, 1_000)) : undefined;
}

function boundedValue(value: unknown, maximum: number): unknown {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return serialized.length <= maximum ? value : {
    schema: "agentloop.contextValueReference/v1",
    originalCharacters: serialized.length,
    originalSha256: sha256(serialized),
    preview: serialized.slice(0, maximum),
  };
}

function objectSize(value: unknown): number | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
