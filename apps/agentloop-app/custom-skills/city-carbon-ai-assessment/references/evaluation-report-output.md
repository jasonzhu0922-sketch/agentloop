# Evaluation Report Output

Use this reference when the task asks for a City Carbon AI assessment report, report schema, report prompt, or report content structure.

## Basis

The report is assembled from structured project and assessment results. Do not make the report a free-form AI essay unless the user explicitly asks for a separate narrative draft.

## Output Options

Supported output types:

- `pdf`: default report format when the user asks for a PDF.
- `docx` or `word`: generated as a real `.docx` package from Markdown content.
- `md`: Markdown report.

Keep the report body readable as Markdown first, then render PDF or DOCX if requested.

## Report Data Inputs

Build report data from:

- project basics: code, name, city, type if available;
- assessment batch: assessment number, status, total score, model/rubric identifier if available, benchmark source;
- dimension results: dimension code, name, score, weight, contribution;
- indicator results: code, name, final value, score, weight, weighted score, benchmark score, gap, warning flag;
- AI assessment trace: AI value, AI score, confidence, evidence, source, reasoning, manual-review flag;
- manual review: manual value, manual score, remark, reviewer/time if available;
- optimization: current score, target score, projected score, reach-target flag, expert summary, suggested indicators;
- generated timestamp.

Use the current structured evaluation object as the source of truth for report fields.

## Report Sections

Follow the current report content structure:

1. 报告封面: project code/name, city, assessment batch, model/rubric, benchmark source, generated time.
2. 整体评价情况: total score, level, status, low-score warnings, manual-review count, manual correction count, AI evidence coverage.
3. 评价图表数据: dimension and indicator chart data when available.
4. 维度评价: each dimension's score, warning count, and indicator count.
5. 指标评估明细: final value, score, weight, weighted score, benchmark score, gap, warning status, AI confidence.
6. AI 证据与人工复核: include when `includeAiEvidence=true`; preserve evidence and manual correction text.
7. 对标差距分析: list indicators below benchmark, ordered by largest negative gap.
8. AI 优化建议: include when `includeOptimization=true`; use latest or generated optimization plan.
9. 附录: generation method, chart explanation, and data source statement.

## Content Rules

- Report text should be traceable to uploaded project materials, the assessment model, structured AI outputs, manual review, and optimization results.
- Do not invent missing evidence to make a report look complete.
- Mark unresolved or low-confidence indicators visibly.
- Keep benchmark gaps separate from AI evidence: a benchmark gap is comparative analysis, not source evidence from uploaded materials.
- If optimization is missing and the user did not ask to generate it, say it is not available instead of creating informal advice.
- If the user asks to generate optimization, use the same structured advice rules in `improvement-advice.md`.

## Formatting Notes

- Markdown should remain readable by itself.
- PDF/DOCX outputs should preserve Chinese text, headings, tables, evidence, and page flow.
- For PDF/DOCX quality-sensitive delivery, verify actual rendered output when possible, especially Chinese text, tables, and page flow.
