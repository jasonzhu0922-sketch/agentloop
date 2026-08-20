/**
 * Detect a model's literal rendering of a tool invocation when the Runtime
 * intentionally exposed no executable tools. Providers use different markup
 * envelopes, so this is protocol-shape detection rather than provider logic.
 */
export function isTextToolInvocation(content: string): boolean {
  const normalized = content
    .trimStart()
    .replaceAll("＜", "<")
    .replaceAll("＞", ">")
    .replaceAll("｜", "|")
    .toLowerCase();
  if (!normalized.startsWith("<")) return false;
  return /^<(?:antml:)?(?:invoke|parameter)|^<tool_calls?\b|^<\|*dsml\|*(?:tool_calls?|invoke|function_call)\b/.test(normalized);
}
