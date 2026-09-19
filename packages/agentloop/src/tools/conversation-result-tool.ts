import type { ConversationResultRepository } from "../storage/repositories/conversation-result-repository.ts";
import { badRequest, forbidden, notFound } from "../shared/errors.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export const CONVERSATION_RESULT_TOOL_NAME = "read_conversation_result";
const DEFAULT_WINDOW_CHARACTERS = 12_000;
const MAX_WINDOW_CHARACTERS = 40_000;

interface ReadConversationResultInput {
  readonly runId: string;
  readonly sha256: string;
  readonly offset: number;
  readonly maxCharacters: number;
}

/**
 * Materializes a bounded window of a prior accepted Outcome selected by the
 * server. It exposes no filesystem location and cannot cross a conversation
 * or user boundary.
 */
export function createConversationResultTool(repository: ConversationResultRepository): RuntimeTool<ReadConversationResultInput> {
  return {
    name: CONVERSATION_RESULT_TOOL_NAME,
    description: "Read a bounded window from an immutable, prior accepted Outcome result in this conversation. Use a result contentRef supplied by Runtime; do not use this tool to discover unrelated Runs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "sha256"],
      properties: {
        runId: { type: "string", minLength: 1, maxLength: 120 },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        offset: { type: "integer", minimum: 0 },
        maxCharacters: { type: "integer", minimum: 1, maximum: MAX_WINDOW_CHARACTERS },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    parse(input: unknown): ReadConversationResultInput {
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw badRequest("arguments must be an object");
      const value = input as Record<string, unknown>;
      const runId = typeof value.runId === "string" ? value.runId.trim() : "";
      const sha256 = typeof value.sha256 === "string" ? value.sha256.trim() : "";
      if (runId.length === 0) throw badRequest("runId is required");
      if (!/^[a-f0-9]{64}$/u.test(sha256)) throw badRequest("sha256 must be a lowercase SHA-256 digest");
      const offset = value.offset === undefined ? 0 : value.offset;
      const maxCharacters = value.maxCharacters === undefined ? DEFAULT_WINDOW_CHARACTERS : value.maxCharacters;
      if (!Number.isInteger(offset) || (offset as number) < 0) throw badRequest("offset must be a non-negative integer");
      if (!Number.isInteger(maxCharacters) || (maxCharacters as number) < 1 || (maxCharacters as number) > MAX_WINDOW_CHARACTERS) {
        throw badRequest(`maxCharacters must be an integer between 1 and ${MAX_WINDOW_CHARACTERS}`);
      }
      return { runId, sha256, offset: offset as number, maxCharacters: maxCharacters as number };
    },
    async execute(context, input) {
      if (context.grant.conversationId === undefined) throw forbidden("Conversation result access requires a conversation-scoped Run");
      const result = await repository.readCompleted({
        actorUserId: context.grant.actorUserId,
        conversationId: context.grant.conversationId,
        runId: input.runId,
        sha256: input.sha256,
      });
      if (result === undefined) throw notFound("Conversation result");
      const content = result.output.slice(input.offset, input.offset + input.maxCharacters);
      return {
        schema: "agentloop.conversationResultRead/v1",
        result: {
          schema: "agentloop.conversationResultRef/v1",
          runId: result.runId,
          sha256: result.sha256,
          characters: result.characters,
        },
        ...(result.planId === undefined ? {} : { planId: result.planId }),
        offset: input.offset,
        content,
        returnedCharacters: content.length,
        hasMore: input.offset + content.length < result.characters,
      };
    },
  };
}
