import type { ConversationTurnMode } from "../planning/contracts.ts";
import type { RuntimeTool } from "../tools/tool-registry.ts";

/** A turn may narrow the existing catalog; it cannot grant new tools. */
export function toolNamesForConversationMode(
  mode: ConversationTurnMode | undefined,
  tools: readonly RuntimeTool<unknown>[],
  authorizedNames: readonly string[],
): string[] {
  if (mode === "clarify") return [];
  if (mode !== "reply") return [...authorizedNames];
  const readers = new Set(tools.filter(tool => tool.effect === "read").map(tool => tool.name));
  return authorizedNames.filter(name => readers.has(name));
}
