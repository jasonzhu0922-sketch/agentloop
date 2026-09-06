const STOPWORDS = new Set([
  "请",
  "帮",
  "一下",
  "一个",
  "这个",
  "那个",
  "进行",
  "调用",
  "查询",
  "搜索",
  "获取",
  "返回",
  "给出",
  "说明",
  "结果",
  "信息",
  "参数",
  "内容",
  "并",
  "和",
  "与",
  "到",
  "从",
  "对",
  "的",
  "latest",
  "recent",
  "current",
  "please",
  "query",
  "search",
]);

export function tokenizeInstructionText(value: string): readonly string[] {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return [];
  const tokens = new Set<string>();
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : undefined;
  if (segmenter !== undefined) {
    for (const part of segmenter.segment(normalized)) {
      const token = normalizeToken(part.segment);
      if (token.length > 0 && !STOPWORDS.has(token)) tokens.add(token);
    }
    return [...tokens];
  }
  for (const raw of normalized.split(/[^a-z0-9\u3400-\u9fff]+/giu)) {
    const token = normalizeToken(raw);
    if (token.length > 0 && !STOPWORDS.has(token)) tokens.add(token);
  }
  return [...tokens];
}

function normalizeToken(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : "";
}
