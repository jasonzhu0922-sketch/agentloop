import { badRequest, forbidden, notFound } from "../shared/errors.ts";
import type { RuntimeResultRepository } from "../runtime/runtime-result-repository.ts";
import { isRuntimeResultId, RUNTIME_RESULT_ID_PATTERN, type RuntimeResultRef } from "../runtime/runtime-result.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export const RESULT_READER_NAME = "read_result";
const MAX_RESULT_WINDOW_CHARACTERS = 12_000;
const MAX_RESULT_ARRAY_ITEMS = 200;

interface ReadResultInput {
  readonly resultId: string;
  readonly view: "result" | "step_history" | "producer_exchange";
  readonly toolCallId?: string;
  readonly assistantEventSeq?: number;
  readonly pointer?: string;
  readonly offset: number;
  readonly limit: number;
  readonly characterOffset: number;
  readonly characterLimit: number;
}

/** Read a bounded exact window from an authorized Runtime-owned result. */
export function createResultTool(repository: RuntimeResultRepository, options?: { readonly resolveEventData: (data: Readonly<Record<string, unknown>>, context: import("./tool-registry.ts").ToolExecutionContext) => Promise<Readonly<Record<string, unknown>>> }): RuntimeTool<ReadResultInput> {
  return {
    name: RESULT_READER_NAME,
    effect: "read",
    description: [
      "Read exact values from a committed Tool result, an assessed dependency Step result, an explicitly bound earlier Round result, or an explicitly bound completed Run result through one opaque Runtime result ref.",
      'For current-Step history, use view="step_history", pointer="/entries", offset/limit to locate original toolCallIds. Then use view="producer_exchange" and toolCallId with the same anchor resultId to read the exact assistant statement, arguments and committed outcome. JSON pointers and character windows apply to these views too. History access never grants access to another Step or Run; default view="result" retains existing Result semantics.',
      "Pass resultId from agentloop.resultRef/v1; never supply a filesystem path or digest.",
      "For JSON results, use a pointer rooted in the persisted result envelope and optional array offset/limit. For agentloop.jsonRead/v1, use the returned resultPointer such as /queries/0/value; the displayed sourcePointer belongs to the original file and must not be passed to read_result. Omit pointer for a bounded serialized character window. If a pointer is accidentally sent for a text result, Runtime returns the exact text window with pointerApplied=false and a repair diagnostic; do not retry another pointer.",
      "For command output, pointer /stdout or /stderr selects the original stream in this same Result. String selections support characterOffset/characterLimit and nextCharacterOffset; no file path or digest is needed.",
      "Array offset and nextOffset address only the selected persisted Result window, starting at zero. A sourceWindow describes the original computer_read_json source range: use computer_read_json with its path, sourcePointer and nextOffset for later original-file items; read_result cannot fetch items outside the stored window.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resultId"],
      properties: {
        view: { type: "string", enum: ["result", "step_history", "producer_exchange"] },
        toolCallId: { type: "string", minLength: 1, maxLength: 200 },
        assistantEventSeq: { type: "integer", minimum: 1, description: "Exact history index event sequence to disambiguate a reused ToolCall id" },
        resultId: {
          type: "string",
          minLength: 39,
          maxLength: 39,
          pattern: RUNTIME_RESULT_ID_PATTERN,
          description: "Complete opaque resultId copied exactly from agentloop.resultRef/v1; abbreviated prefixes are invalid.",
        },
        pointer: { type: "string", minLength: 1, maxLength: 2_000 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_ARRAY_ITEMS },
        characterOffset: { type: "integer", minimum: 0 },
        characterLimit: { type: "integer", minimum: 1, maximum: MAX_RESULT_WINDOW_CHARACTERS },
      },
    },
    executionMode: "parallel",
    // The selected window is bounded before JSON escaping adds transport bytes.
    maxResultCharacters: MAX_RESULT_WINDOW_CHARACTERS * 6 + 32_000,
    replaySafe: true,
    availableDuringCompletionPreparation: true,
    publishesRuntimeResult: false,
    parse(input: unknown): ReadResultInput {
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw badRequest("arguments must be an object");
      const value = input as Record<string, unknown>;
      const resultId = typeof value.resultId === "string" ? value.resultId.trim() : "";
      if (!isRuntimeResultId(resultId)) {
        throw badRequest("resultId must be the complete opaque Runtime result id from agentloop.resultRef/v1; abbreviated prefixes are invalid");
      }
      const view = value.view ?? "result";
      if (!["result", "step_history", "producer_exchange"].includes(String(view))) throw badRequest("Unknown Result view");
      const toolCallId = value.toolCallId === undefined ? undefined : requireString(value.toolCallId, "toolCallId");
      if (toolCallId !== undefined && (toolCallId.length > 200 || view !== "producer_exchange")) throw badRequest("toolCallId requires producer_exchange view");
      if (value.assistantEventSeq !== undefined && view !== "producer_exchange") throw badRequest("assistantEventSeq requires producer_exchange view");
      const pointer = value.pointer === undefined ? undefined : requireString(value.pointer, "pointer");
      return {
        resultId,
        view: view as ReadResultInput["view"],
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(value.assistantEventSeq === undefined ? {} : { assistantEventSeq: boundedInteger(value.assistantEventSeq, "assistantEventSeq", 1, Number.MAX_SAFE_INTEGER, 1) }),
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
      let payload = record.payload;
      if (input.view !== "result") {
        let history = await repository.readHistoryAuthorized({ resultId: input.resultId,
          runId: context.grant.runId, planId, stepId, actorUserId: context.grant.actorUserId,
          conversationId: context.grant.conversationId,
          assistantEventSeq: input.assistantEventSeq,
          ...(input.view === "producer_exchange" ? { toolCallId: input.toolCallId ?? record.producer.toolCallId } : {}) });
        if (!history) throw notFound("Authorized execution history");
        if (input.view === "producer_exchange" && history.assistant && typeof history.assistant === "object") {
          const assistant = history.assistant as Record<string, unknown>;
          const call = assistant.toolCall as Record<string, unknown>;
          if (options) {
            const resolved = await options.resolveEventData(call, context);
            history = { ...history, assistant: { ...assistant, toolCall: resolved } };
          } else if (call.argumentsRef !== undefined) {
            history = { ...history, gaps: [...(Array.isArray(history.gaps) ? history.gaps : []), "Exact arguments require the host's ToolArgumentsReferenceStore resolver; the displayed arguments are a projection."] };
          }
        }
        const content = JSON.stringify(history);
        payload = { ...record.payload, resultSchema: String(history.schema), content, contentFormat: "json", characters: content.length, bytes: Buffer.byteLength(content) };
      }
      const source = {
        view: input.view,
        kind: record.kind,
        ...(record.producer.toolName === undefined ? {} : { toolName: record.producer.toolName }),
        ...(payload.resultSchema === undefined ? {} : { resultSchema: payload.resultSchema }),
        contentFormat: payload.contentFormat,
        characters: payload.characters,
        bytes: payload.bytes,
      };
      if (input.pointer === undefined) {
        return readTextWindow(payload.content, record.ref, source, input.characterOffset, input.characterLimit);
      }
      if (payload.contentFormat !== "json") {
        return {
          ...readTextWindow(payload.content, record.ref, source, input.characterOffset, input.characterLimit),
          pointer: input.pointer,
          pointerApplied: false,
          repair: "Text Runtime results do not have JSON pointer selectors. The pointer was ignored; use characterOffset/characterLimit or omit pointer on the next read.",
        };
      }
      const document = JSON.parse(payload.content) as unknown;
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
      if (typeof selected === "string") {
        return {
          ...readTextWindow(selected, record.ref, source, input.characterOffset, input.characterLimit),
          pointer: input.pointer,
          pointerApplied: true,
        };
      }
      const array = selectedArray !== undefined;
      const value = selectedArray === undefined
        ? selected
        : selectedArray.slice(input.offset, input.offset + input.limit);
      const serialized = JSON.stringify(value);
      if (serialized.length > MAX_RESULT_WINDOW_CHARACTERS) {
        throw oversizedJsonSelection(input.pointer, value, serialized.length);
      }
      return {
        schema: "agentloop.resultRead/v1",
        sourceResultRef: record.ref,
        source,
        pointer: input.pointer,
        ...jsonReadSourceWindow(document, input.pointer),
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

function oversizedJsonSelection(pointer: string, value: unknown, characters: number) {
  const type = Array.isArray(value) ? "array" : isRecord(value) ? "object" : value === null ? "null" : typeof value;
  const childPointers = isRecord(value)
    ? Object.keys(value).slice(0, 40).map((key) => `${pointer}/${escapePointerToken(key)}`)
    : Array.isArray(value)
      ? value.slice(0, 40).map((_, index) => `${pointer}/${index}`)
      : [];
  const repair = Array.isArray(value)
    ? "Retry the same pointer with a smaller array limit, or select one listed child pointer. characterLimit applies only when the selected value is a string."
    : isRecord(value)
      ? "Select one of the listed child pointers. characterLimit applies only when the selected value is a string."
      : "Select a narrower JSON Pointer. characterLimit applies only when the selected value is a string.";
  return badRequest(
    `Selected Runtime result ${pointer} is a ${type} whose serialized value is ${characters} characters, above the ${MAX_RESULT_WINDOW_CHARACTERS}-character model window. ${repair}`,
    {
      schema: "agentloop.resultReadDiagnostic/v1",
      pointer,
      selectedType: type,
      selectedCharacters: characters,
      maximumCharacters: MAX_RESULT_WINDOW_CHARACTERS,
      childPointers,
      omittedChildPointers: Math.max(0, (Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : 0) - childPointers.length),
      repair,
    },
  );
}

/** Provenance of an exact stored JSON read window, never a redirected read. */
function jsonReadSourceWindow(document: unknown, pointer: string): Record<string, unknown> {
  if (!isRecord(document) || document.schema !== "agentloop.jsonRead/v1" || !Array.isArray(document.queries)) return {};
  const index = document.queries.findIndex((_, index) => pointer === `/queries/${index}/value`);
  const query = document.queries[index];
  if (!isRecord(query) || !Array.isArray(query.value)) return {};
  return { sourceWindow: {
    path: document.path,
    sourcePointer: query.sourcePointer,
    sourceRange: query.sourceRange,
    offset: query.offset,
    returned: query.returned,
    totalItems: query.totalItems,
    nextOffset: query.nextOffset,
  } };
}

function readTextWindow(
  content: string,
  sourceResultRef: RuntimeResultRef,
  source: Readonly<Record<string, unknown>>,
  characterOffset: number,
  characterLimit: number,
) {
  if (characterOffset > content.length) throw badRequest("characterOffset exceeds Runtime result length");
  const window = content.slice(characterOffset, characterOffset + characterLimit);
  return {
    schema: "agentloop.resultRead/v1" as const,
    sourceResultRef,
    source,
    characterOffset,
    returnedCharacters: window.length,
    nextCharacterOffset: characterOffset + window.length < content.length
      ? characterOffset + window.length
      : null,
    content: window,
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

function escapePointerToken(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
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
