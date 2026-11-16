import type { ConversationTurnMode } from "../planning/contracts.ts";

/** Clarification is tool-free; reply and execute retain the same Run authority. */
export function toolNamesForConversationMode(
  mode: ConversationTurnMode | undefined,
  authorizedNames: readonly string[],
): string[] {
  return mode === "clarify" ? [] : [...authorizedNames];
}
