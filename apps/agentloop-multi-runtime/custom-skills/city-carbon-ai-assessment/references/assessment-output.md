# Assessment Output

## Prompt Contract

For each indicator, ask the AI to return this JSON shape:

```json
{
  "schemaVersion": "indicator-ai-assessment.v2",
  "indicators": [
    {
      "indicatorCode": "I302",
      "indicatorName": "绿色建筑二星级及以上比例",
      "extractedValue": 80,
      "scoreSuggestion": 8.6,
      "confidence": 0.9,
      "evidenceText": "调查报告记载绿色建筑比例为80%",
      "source": "项目调查报告",
      "reasoningSummary": "项目调查报告已明确项目事实，符合该指标较高评分区间。",
      "needsManualReview": false
    }
  ]
}
```

## Field Rules

- `schemaVersion`: use `indicator-ai-assessment.v2`.
- `indicatorCode`: must match the current indicator exactly.
- `indicatorName`: copy the current indicator name.
- `extractedValue`: numeric value if uploaded materials support extraction; otherwise `null`.
- `scoreSuggestion`: 0-10 score if uploaded materials support judgment; otherwise `null`.
- `confidence`: 0-1 confidence in evidence and scoring.
- `evidenceText`: concise facts from uploaded materials.
- `source`: `项目说明`, `项目调查报告`, or another explicit uploaded-material label.
- `reasoningSummary`: explain how material facts map to the scoring standard.
- `needsManualReview`: true when evidence is missing, contradictory, low-confidence, or score is null.

## Validation

When checking the AI result:

- reject indicators not present in the current assessment model;
- clamp valid scores to 0-10 and confidence to 0-1;
- mark manual review if score or evidence is missing;
- keep unresolved indicators visible instead of hiding them in aggregate scoring;
- preserve uploaded-material evidence alongside the score.

## Prompt Shape

```text
你是城市建筑一体化减碳评估专家。请只返回 JSON，不要输出 Markdown。

请只评估下面这一项指标。
本次评估的事实依据仅为用户上传的项目说明和项目调查报告。
项目材料中的明确陈述应作为项目事实采信，不要求外部佐证材料。
evaluationStandard 只用于确定评分尺度，不是待引用证据。

当前指标：
{indicator json}

项目资料：
项目说明：...
项目调查报告：...

请返回 indicator-ai-assessment.v2 JSON。
```
