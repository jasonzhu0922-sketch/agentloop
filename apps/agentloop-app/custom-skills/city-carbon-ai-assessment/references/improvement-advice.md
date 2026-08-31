# Improvement Advice

Use this reference when the user asks for AI evaluation suggestions, optimization suggestions, or a post-assessment improvement plan.

## Inputs

Build advice from:

- the same assessment model used for scoring;
- uploaded project materials;
- indicator results, including AI score, evidence, confidence, and manual review status;
- optional target score, benchmark, or preferred direction supplied by the user.

Do not generate generic low-carbon advice detached from the indicators. Every suggestion should name the affected indicator and point back to project-material evidence or a clear evidence gap.

## Output Shape

```json
{
  "expertSummary": "整体诊断和优化策略",
  "strategyFocus": ["重点方向1", "重点方向2"],
  "suggestedIndicators": [
    {
      "indicatorCode": "I302",
      "priorityLevel": "P1",
      "suggestionText": "优化建议",
      "expectedAction": "实施动作",
      "evidenceBasis": "来自项目说明或调查报告的证据",
      "optimizationPath": "该措施如何改善该指标",
      "expectedCarbonImpact": "减碳影响机制",
      "priorityReason": "优先级理由",
      "riskAndPrerequisite": "风险与前置条件",
      "costLevel": "低/中/高",
      "difficultyLevel": "低/中/高",
      "implementationCycle": "如 1-3个月",
      "estimatedScore": 8.5,
      "estimatedLift": 1.2,
      "confidence": 0.82
    }
  ]
}
```

## Review Rules

- Prioritize low-scoring indicators, large benchmark gaps, low confidence, and manual-review flags.
- Keep `estimatedScore` within the platform score scale.
- Explain the lift through model weights or clear qualitative reasoning.
- Label evidence gaps as review needs, not confirmed project deficiencies.
- Separate model-generated expert advice from fallback or rule-based advice.
