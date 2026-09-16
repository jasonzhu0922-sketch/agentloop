import { isToolResultLocator, type ToolResultStore } from "../storage/repositories/tool-result-store.ts";
import { badRequest } from "../shared/errors.ts";
import { optionalPositiveInteger, requireRecord, requireString } from "../shared/validation.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export const TOOL_RESULT_READER_NAME = "read_tool_result";
const DEFAULT_LIMIT = 16_000;
const MAX_LIMIT = 50_000;

interface ReadToolResultInput {
  readonly locator: string;
  readonly sha256: string;
  readonly offset: number;
  readonly limit: number;
}

export function createToolResultReader(store: ToolResultStore): RuntimeTool<ReadToolResultInput> {
  return {
    name: TOOL_RESULT_READER_NAME,
    description: [
      "Read one bounded character window from a complete oversized Tool result persisted by this Run.",
      "Use only a locator and sha256 returned by an earlier Tool result. Increase offset to continue; never guess locators.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["locator", "sha256"],
      properties: {
        locator: { type: "string", minLength: 3, maxLength: 512, pattern: "^[A-Za-z][A-Za-z0-9+.-]*:\\S+$" },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    maxResultCharacters: MAX_LIMIT + 2_000,
    parse(value) {
      const record = requireRecord(value, `${TOOL_RESULT_READER_NAME} arguments`);
      const limit = optionalPositiveInteger(record.limit, "limit", DEFAULT_LIMIT, MAX_LIMIT);
      if (limit < 1) throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
      const locator = requireString(record.locator, "locator", { max: 512 });
      if (!isToolResultLocator(locator)) throw badRequest("locator must be an opaque Tool result locator");
      return {
        locator,
        sha256: requireString(record.sha256, "sha256", { max: 64, pattern: /^[0-9a-f]{64}$/ }),
        offset: optionalPositiveInteger(record.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
        limit,
      };
    },
    async execute(context, input) {
      const result = await store.read({
        ownerUserId: context.grant.actorUserId,
        runId: context.grant.runId,
        locator: input.locator,
        expectedSha256: input.sha256,
        offset: input.offset,
        limit: input.limit,
      });
      return {
        schema: "agentloop.toolResultWindow/v1",
        locator: result.locator,
        sha256: result.sha256,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        characters: result.characters,
        offset: result.offset,
        returnedCharacters: result.content.length,
        truncated: result.truncated,
        ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }),
        content: result.content,
      };
    },
  };
}
