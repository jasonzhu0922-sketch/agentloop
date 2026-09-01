---
name: city-carbon-ai-assessment
description: 用于 City Carbon 城市碳评估、项目碳排放评估、低碳评分、0-10 分制指标打分、优化建议和评估报告；build evaluation workflows from assessment models and uploaded project materials with structured scoring, advice, and reports.
agentloop:
  roles:
    - primary_builder
    - source_provider
  artifactKinds:
    - document
    - none
  sourceKinds:
    - document
    - rubric
  qaKinds: []
---

# City Carbon AI Assessment

Use this skill when the task is to evaluate a City Carbon project, design the AI evaluation prompt/process, or produce AI evaluation advice from uploaded project materials.

This skill is distilled into a reusable City Carbon assessment method. Use [references/production-assessment-model.md](references/production-assessment-model.md) as the default rubric snapshot.

## Core Flow

The workflow is:

```text
assessment model + uploaded project materials -> AI indicator assessment -> structured score suggestions, evidence, confidence, review flags -> final evaluation, advice, and report
```

For the evaluation itself, always build the model input from:

- an assessment model: dimensions, indicators, weights, calculation methods, evaluation standards, contribution summaries, and evidence requirements;
- user-uploaded project materials, primarily `项目说明` and `项目调查报告`;
- optional project basics supplied by the user, such as project name, city, type, location, and stage.

## Assessment Model

Treat the assessment model as the rubric that guides the AI. Before scoring, represent each enabled indicator with:

- `dimensionCode` and `dimensionName`
- `indicatorCode` and `indicatorName`
- `weightValue`
- `calculationMethod`
- `evaluationStandard`
- `contributionSummary`
- `evidenceRequirements`

Use [references/production-assessment-model.md](references/production-assessment-model.md) as the default City Carbon assessment model unless the user supplies a different model for the current evaluation.

## Uploaded Materials

Use uploaded documents as the factual basis:

- `项目说明`: project plan, scope, measures, targets, and declared design facts.
- `项目调查报告`: investigation/survey facts, quantities, current conditions, and measured or reported indicators.
- Other uploaded materials only when the user explicitly includes them in the evaluation scope.

For this product workflow, clear statements in uploaded materials are accepted as project facts. Do not require external certificates, approvals, testing reports, or third-party validation unless the user asks for a separate audit-style review.

## AI Evaluation

Evaluate one enabled indicator at a time. For each indicator:

1. Provide the indicator definition, scoring scale, and evidence expectations.
2. Provide only relevant uploaded-material context.
3. Ask the AI to extract the project fact or value when present.
4. Ask for a 0-10 `scoreSuggestion` when the material supports judgment.
5. Return `scoreSuggestion: null` and `needsManualReview: true` only when evidence is absent, contradictory, or too weak.
6. Require JSON output and no Markdown.

Read [references/assessment-output.md](references/assessment-output.md) for the schema and validation rules.

## Score Resolution

AI output is a recommendation, not the final authority. The final score resolution is:

```text
manualScore -> aiScore -> unresolved
```

Manual review may override value and score, but should preserve the AI evidence and reasoning for traceability.

## Advice

After scoring, generate improvement advice from low scores, large gaps, low confidence, missing evidence, and manual-review flags. Advice must remain tied to the same model indicators and uploaded project facts. Read [references/improvement-advice.md](references/improvement-advice.md) when producing optimization or assessment recommendations.

## Evaluation Report

When the user asks for an assessment report, build it from the structured evaluation result rather than asking the model to freely write an untraceable report:

- support PDF, DOCX/Word, and Markdown outputs;
- include dimension summaries, indicator details, AI evidence, manual review, benchmark gaps, and AI optimization advice when requested;
- preserve report traceability through project basics, assessment batch, model/rubric, score source, evidence, confidence, and generated time.

Read [references/evaluation-report-output.md](references/evaluation-report-output.md) when generating or designing report output.
