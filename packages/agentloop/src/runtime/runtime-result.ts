import { createHash, randomUUID } from "node:crypto";

export type RuntimeResultKind = "tool" | "step" | "run";

export type RuntimeResultBindingRelation =
  | "dependency"
  | "continue_prior"
  | "refine_prior"
  | "correct_prior"
  | "challenge_prior";

export interface RuntimeResultRef {
  readonly schema: "agentloop.resultRef/v1";
  readonly resultId: string;
}

/** A global declaration that a Plan/Step consumes a Runtime Result. */
export interface RuntimeResultBinding {
  readonly schema: "agentloop.resultBinding/v1";
  readonly result: RuntimeResultRef;
  readonly relation: RuntimeResultBindingRelation;
}

export function parseRuntimeResultBinding(value: unknown): RuntimeResultBinding | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result = parseRuntimeResultRef(record.result);
  if (
    record.schema !== "agentloop.resultBinding/v1"
    || result === undefined
    || !isRuntimeResultBindingRelation(record.relation)
  ) return undefined;
  return { schema: "agentloop.resultBinding/v1", result, relation: record.relation };
}

export interface RuntimeResultPayload {
  readonly content: string;
  readonly contentFormat: "json" | "text";
  readonly resultSchema?: string;
  readonly characters: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RuntimeResultRecord {
  readonly schema: "agentloop.runtimeResult/v1";
  readonly ref: RuntimeResultRef;
  readonly kind: RuntimeResultKind;
  readonly producer: {
    readonly runId: string;
    readonly planId?: string;
    readonly stepId?: string;
    readonly actionId?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
  };
  readonly inputs: readonly RuntimeResultRef[];
  readonly publication: {
    readonly status: "committed" | "published";
    readonly assessmentRef?: string;
    readonly decision?: "approved" | "caveated";
  };
  readonly payload: RuntimeResultPayload;
  readonly createdAt: number;
}

/** A bounded server view of the same Runtime Result, never a second identity. */
export interface RuntimeResultCard {
  readonly schema: "agentloop.resultCard/v1";
  readonly result: RuntimeResultRef;
  readonly kind: RuntimeResultKind;
  readonly producer: RuntimeResultRecord["producer"];
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly characters: number;
  readonly goal: string;
  readonly artifactPaths: readonly string[];
  readonly evidenceRefs: readonly string[];
}

/** A compact execution-context entry that preserves the same Result identity. */
export interface RuntimeResultContextEntry {
  readonly schema: "agentloop.resultContextEntry/v1";
  readonly result: RuntimeResultRef;
  readonly kind: RuntimeResultKind;
  readonly producer: RuntimeResultRecord["producer"];
  readonly resultSchema?: string;
  readonly selectors?: readonly Readonly<Record<string, unknown>>[];
}

export function createRuntimeResultCard(input: {
  readonly result: RuntimeResultRecord;
  readonly goal: string;
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly artifactPaths?: readonly string[];
  readonly evidenceRefs?: readonly string[];
}): RuntimeResultCard {
  return {
    schema: "agentloop.resultCard/v1",
    result: input.result.ref,
    kind: input.result.kind,
    producer: input.result.producer,
    goal: input.goal,
    summary: input.summary,
    summaryTruncated: input.summaryTruncated,
    characters: input.result.payload.characters,
    artifactPaths: Object.freeze([...(input.artifactPaths ?? [])]),
    evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])]),
  };
}

export function parseRuntimeResultCard(value: unknown): RuntimeResultCard | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result = parseRuntimeResultRef(record.result);
  const producer = record.producer;
  const kind = record.kind;
  const strings = [record.summary, record.goal];
  const artifactPaths = record.artifactPaths;
  const evidenceRefs = record.evidenceRefs;
  if (
    record.schema !== "agentloop.resultCard/v1"
    || result === undefined
    || !["tool", "step", "run"].includes(String(kind))
    || producer === null
    || typeof producer !== "object"
    || Array.isArray(producer)
    || !strings.every((item) => typeof item === "string")
    || typeof record.summaryTruncated !== "boolean"
    || !Number.isInteger(record.characters)
    || (record.characters as number) < 0
    || !Array.isArray(artifactPaths)
    || !artifactPaths.every((item) => typeof item === "string")
    || !Array.isArray(evidenceRefs)
    || !evidenceRefs.every((item) => typeof item === "string")
  ) return undefined;
  const producerRecord = producer as Record<string, unknown>;
  if (typeof producerRecord.runId !== "string" || !optionalStrings(producerRecord, ["planId", "stepId", "actionId", "toolCallId", "toolName"])) return undefined;
  return {
    schema: "agentloop.resultCard/v1",
    result,
    kind: kind as RuntimeResultKind,
    producer: producer as RuntimeResultRecord["producer"],
    summary: record.summary as string,
    summaryTruncated: record.summaryTruncated as boolean,
    characters: record.characters as number,
    goal: record.goal as string,
    artifactPaths: artifactPaths as string[],
    evidenceRefs: evidenceRefs as string[],
  };
}

export function createRuntimeResult(input: {
  readonly kind: RuntimeResultKind;
  readonly producer: RuntimeResultRecord["producer"];
  readonly value: unknown;
  readonly inputs?: readonly RuntimeResultRef[];
  readonly publication: RuntimeResultRecord["publication"];
  readonly createdAt?: number;
}): RuntimeResultRecord {
  const serialized = serializeRuntimeResult(input.value);
  const schema = resultSchema(input.value);
  return {
    schema: "agentloop.runtimeResult/v1",
    ref: { schema: "agentloop.resultRef/v1", resultId: `rr_${randomUUID()}` },
    kind: input.kind,
    producer: input.producer,
    inputs: Object.freeze([...(input.inputs ?? [])]),
    publication: input.publication,
    payload: {
      content: serialized.content,
      contentFormat: serialized.format,
      ...(schema === undefined ? {} : { resultSchema: schema }),
      characters: serialized.content.length,
      bytes: Buffer.byteLength(serialized.content),
      sha256: createHash("sha256").update(serialized.content).digest("hex"),
    },
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function parseRuntimeResult(value: unknown): RuntimeResultRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ref = parseRuntimeResultRef(record.ref);
  const producer = record.producer;
  const publication = record.publication;
  const payload = record.payload;
  if (
    record.schema !== "agentloop.runtimeResult/v1"
    || !["tool", "step", "run"].includes(String(record.kind))
    || ref === undefined
    || producer === null
    || typeof producer !== "object"
    || Array.isArray(producer)
    || publication === null
    || typeof publication !== "object"
    || Array.isArray(publication)
    || payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !Array.isArray(record.inputs)
    || typeof record.createdAt !== "number"
  ) return undefined;
  const producerRecord = producer as Record<string, unknown>;
  const publicationRecord = publication as Record<string, unknown>;
  const payloadRecord = payload as Record<string, unknown>;
  const content = payloadRecord.content;
  if (
    typeof producerRecord.runId !== "string"
    || !optionalStrings(producerRecord, ["planId", "stepId", "actionId", "toolCallId", "toolName"])
    || !["committed", "published"].includes(String(publicationRecord.status))
    || !optionalStrings(publicationRecord, ["assessmentRef"])
    || (publicationRecord.decision !== undefined && !["approved", "caveated"].includes(String(publicationRecord.decision)))
    || typeof content !== "string"
    || !["json", "text"].includes(String(payloadRecord.contentFormat))
    || (payloadRecord.resultSchema !== undefined && typeof payloadRecord.resultSchema !== "string")
    || typeof payloadRecord.characters !== "number"
    || typeof payloadRecord.bytes !== "number"
    || typeof payloadRecord.sha256 !== "string"
    || payloadRecord.characters !== content.length
    || payloadRecord.bytes !== Buffer.byteLength(content)
    || !/^[a-f0-9]{64}$/u.test(payloadRecord.sha256)
    || payloadRecord.sha256 !== createHash("sha256").update(content).digest("hex")
    || !Number.isFinite(record.createdAt)
    || (record.createdAt as number) < 0
  ) return undefined;
  if (payloadRecord.contentFormat === "json" && !isJson(content)) return undefined;
  const inputs = record.inputs.map(parseRuntimeResultRef);
  if (inputs.some((item) => item === undefined)) return undefined;
  if (
    (record.kind === "tool" && publicationRecord.status !== "committed")
    || (record.kind !== "tool" && publicationRecord.status !== "published")
    || (record.kind === "step" && (
      typeof producerRecord.planId !== "string"
      || typeof producerRecord.stepId !== "string"
      || typeof publicationRecord.assessmentRef !== "string"
      || !["approved", "caveated"].includes(String(publicationRecord.decision))
    ))
  ) return undefined;
  return value as RuntimeResultRecord;
}

export function parseRuntimeResultJson(value: string): RuntimeResultRecord | undefined {
  try {
    return parseRuntimeResult(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function parseRuntimeResultRef(value: unknown): RuntimeResultRef | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== "agentloop.resultRef/v1"
    || typeof record.resultId !== "string"
    || !/^rr_[0-9a-f-]{36}$/u.test(record.resultId)
  ) return undefined;
  return { schema: "agentloop.resultRef/v1", resultId: record.resultId };
}

function serializeRuntimeResult(value: unknown): { content: string; format: "json" | "text" } {
  if (typeof value === "string") return { content: value, format: "text" };
  try {
    return { content: JSON.stringify(value) ?? "null", format: "json" };
  } catch {
    return { content: "Runtime returned a value that could not be serialized", format: "text" };
  }
}

function resultSchema(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = (value as Record<string, unknown>).schema;
  return typeof schema === "string" && schema.length > 0 ? schema : undefined;
}

function optionalStrings(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => record[key] === undefined || typeof record[key] === "string");
}

function isRuntimeResultBindingRelation(value: unknown): value is RuntimeResultBindingRelation {
  return value === "dependency"
    || value === "continue_prior"
    || value === "refine_prior"
    || value === "correct_prior"
    || value === "challenge_prior";
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
