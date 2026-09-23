import { badRequest, forbidden, notFound } from "../shared/errors.ts";
import type { RuntimeResultRepository } from "../runtime/runtime-result-repository.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export const RESULT_READER_NAME = "read_result";
const MAX_RESULT_WINDOW_CHARACTERS = 12_000;
const MAX_RESULT_ARRAY_ITEMS = 200;

interface ReadResultInput {
  readonly resultId: string;
  readonly pointer?: string;
  readonly offset: number;
  readonly limit: number;
  readonly characterOffset: number;
  readonly characterLimit: number;
}

/** Read a bounded exact window from an authorized Runtime-owned result. */
export function createResultTool(repository: RuntimeResultRepository): RuntimeTool<ReadResultInput> {
  return {
    name: RESULT_READER_NAME,
    description: [
      "Read exact values from a committed Tool result, an assessed dependency Step result, or an explicitly bound completed Run result through one opaque Runtime result ref.",
      "Pass resultId from agentloop.resultRef/v1; never supply a filesystem path or digest.",
      "For JSON results, use a pointer rooted in the persisted result envelope and optional array offset/limit. For agentloop.jsonRead/v1, use the returned resultPointer such as /queries/0/value; the displayed sourcePointer belongs to the original file and must not be passed to read_result. Omit pointer for a bounded serialized character window.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resultId"],
      properties: {
        resultId: { type: "string", minLength: 4, maxLength: 120 },
        pointer: { type: "string", minLength: 1, maxLength: 2_000 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_ARRAY_ITEMS },
        characterOffset: { type: "integer", minimum: 0 },
        characterLimit: { type: "integer", minimum: 1, maximum: MAX_RESULT_WINDOW_CHARACTERS },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    publishesRuntimeResult: false,
    parse(input: unknown): ReadResultInput {
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw badRequest("arguments must be an object");
      const value = input as Record<string, unknown>;
      const resultId = typeof value.resultId === "string" ? value.resultId.trim() : "";
      if (!/^rr_[0-9a-f-]{36}$/u.test(resultId)) throw badRequest("resultId must be an opaque Runtime result id");
      const pointer = value.pointer === undefined ? undefined : requireString(value.pointer, "pointer");
      return {
        resultId,
        ...(pointer === undefined ? {} : { pointer }),
        offset: boundedInteger(value.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0),
        limit: boundedInteger(value.limit, "limit", 1, MAX_RESULT_ARRAY_ITEMS, 50),
        characterOffset: boundedInteger(value.characterOffset, "characterOffset", 0, Number.MAX_SAFE_INTEGER, 0),
        characterLimit: boundedInteger(value.characterLimit, "characterLimit", 1, MAX_RESULT_WINDOW_CHARACTERS, MAX_RESULT_WINDOW_CHARACTERS),
      };
    },
    async execute(context, input) {
      const planId = context.grant.planId;
      const stepId = context.grant.stepId;
      if (planId === undefined || stepId === undefined) {
        throw forbidden("Runtime result access requires a Plan-step-scoped Runtime grant");
      }
      const record = await repository.readAuthorized({
        resultId: input.resultId,
        runId: context.grant.runId,
        planId,
        stepId,
        actorUserId: context.grant.actorUserId,
        ...(context.grant.conversationId === undefined ? {} : { conversationId: context.grant.conversationId }),
      });
      if (record === undefined) throw notFound("Runtime result");
      const source = {
        kind: record.kind,
        ...(record.producer.toolName === undefined ? {} : { toolName: record.producer.toolName }),
        ...(record.payload.resultSchema === undefined ? {} : { resultSchema: record.payload.resultSchema }),
        characters: record.payload.characters,
        bytes: record.payload.bytes,
      };
      if (input.pointer === undefined) {
        if (input.characterOffset > record.payload.content.length) throw badRequest("characterOffset exceeds Runtime result length");
        const content = record.payload.content.slice(input.characterOffset, input.characterOffset + input.characterLimit);
        return {
          schema: "agentloop.resultRead/v1",
          sourceResultRef: record.ref,
          source,
          characterOffset: input.characterOffset,
          returnedCharacters: content.length,
          nextCharacterOffset: input.characterOffset + content.length < record.payload.content.length
            ? input.characterOffset + content.length
            : null,
          content,
        };
      }
      if (record.payload.contentFormat !== "json") throw badRequest("pointer requires a JSON Runtime result");
      const document = JSON.parse(record.payload.content) as unknown;
      let selected: unknown;
      try {
        selected = resolveJsonPointer(document, input.pointer);
      } catch (error) {
        if (error instanceof Error && /pointer does not exist/u.test(error.message)) {
          throw jsonResultPointerDiagnostic(document, input.pointer);
        }
        throw error;
      }
      const selectedArray = Array.isArray(selected) ? selected : undefined;
      const array = selectedArray !== undefined;
      const value = selectedArray === undefined
        ? selected
        : selectedArray.slice(input.offset, input.offset + input.limit);
      const serialized = JSON.stringify(value);
      if (serialized.length > MAX_RESULT_WINDOW_CHARACTERS) {
        throw badRequest(`Selected Runtime result exceeds ${MAX_RESULT_WINDOW_CHARACTERS} characters; use a narrower pointer or array window`);
      }
      return {
        schema: "agentloop.resultRead/v1",
        sourceResultRef: record.ref,
        source,
        pointer: input.pointer,
        ...(array ? {
          offset: input.offset,
          limit: input.limit,
          returnedItems: (value as unknown[]).length,
          totalItems: selectedArray.length,
          nextOffset: input.offset + (value as unknown[]).length < selectedArray.length
            ? input.offset + (value as unknown[]).length
            : null,
        } : {}),
        value,
      };
    },
  };
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) throw badRequest("pointer must be a JSON Pointer beginning with /");
  let current = document;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(token)) throw badRequest(`pointer array index is invalid: ${token}`);
      const index = Number(token);
      if (index >= current.length) throw badRequest(`pointer array index is out of range: ${token}`);
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object" || !(token in current)) {
      throw badRequest(`pointer does not exist: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/**
 * A computer_read_json result has two pointer namespaces: the source pointer
 * addresses the original JSON file, while read_result must address the
 * persisted result envelope. Keep that distinction explicit instead of
 * silently translating arbitrary pointers.
 */
function jsonResultPointerDiagnostic(document: unknown, pointer: string) {
  if (!isRecord(document) || document.schema !== "agentloop.jsonRead/v1" || !Array.isArray(document.queries)) {
    return badRequest(`pointer does not exist: ${pointer}`);
  }
  const queries = document.queries.filter(isRecord);
  const pairs = queries.slice(0, 8).map((query, index) => {
    const sourcePointer = typeof query.pointer === "string" ? query.pointer : "?";
    return `${sourcePointer} -> /queries/${index}/value`;
  });
  const matchingIndex = queries.findIndex((query) => query.pointer === pointer);
  if (matchingIndex >= 0) {
    return badRequest(
      `pointer does not exist in the Runtime result envelope: ${pointer}; this is a sourcePointer. Use resultPointer /queries/${matchingIndex}/value with read_result, or call computer_read_json with the sourcePointer directly`,
      { namespace: "runtime_result_envelope", sourcePointer: pointer, resultPointer: `/queries/${matchingIndex}/value` },
    );
  }
  const singleQueryHint = queries.length === 1 && (pointer === "/value" || pointer === "/result")
    ? " For this single query, the exact value is at /queries/0/value."
    : "";
  return badRequest(
    `pointer does not exist in the Runtime result envelope: ${pointer}; read_result uses /queries/<index>/value, not the source JSON pointer.${singleQueryHint} Available sourcePointer -> resultPointer pairs: ${pairs.join("; ") || "none"}`,
    { namespace: "runtime_result_envelope", availablePointers: pairs },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw badRequest(`${name} must be a non-empty string`);
  return value;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw badRequest(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}
