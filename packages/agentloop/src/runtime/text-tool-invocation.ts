/**
 * Detect a model's literal rendering of a tool invocation when the Runtime
 * intentionally exposed no executable tools. Providers use different markup
 * envelopes, so this is protocol-shape detection rather than provider logic.
 */
export function isTextToolInvocation(content: string): boolean {
  const normalized = content
    .replaceAll("＜", "<")
    .replaceAll("＞", ">")
    .replaceAll("｜", "|")
    .toLowerCase();
  return /<(?:antml:)?(?:invoke|parameter)\b|<tool_calls?\b|<\|*(?:dsml\|*)?(?:tool_calls?(?:_section_begin)?|tool_call_begin|invoke|function_call)\b/.test(normalized);
}
