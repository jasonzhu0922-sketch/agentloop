# Evaluation Report Output

Use this reference when the task asks for a City Carbon AI assessment report, report schema, export behavior, report prompt, or report content structure.

## Implementation Basis

The current system's canonical report path is `ReportService.exportReport(...)`.

Relevant implementation files:

- `backend/src/main/java/com/citycarbon/platform/report/service/ReportService.java`
- `backend/src/main/java/com/citycarbon/platform/report/controller/ReportController.java`
- `frontend/src/api/report.ts`
- `frontend/src/views/ProjectAssessmentPage.vue`

The regular report is assembled from structured project and assessment results. Do not make the report a free-form AI essay unless the user explicitly asks for a separate narrative draft. The existing `generateAiReport(...)` method creates AI-written Markdown text, but it is not the main controller export path.

## Export Options

The report export options are:

```json
{
  "reportType": "pdf",
  "includeOptimization": true,
  "generateOptimizationIfMissing": false,
  "includeAiEvidence": true,
  "includeCharts": true
}
```

Supported report types:

- `pdf`: default; rendered from HTML with OpenHTMLToPDF and CJK font support.
- `docx` or `word`: generated as a real `.docx` package from Markdown content.
- `md`: Markdown report.

The system always writes a Markdown body first, then optionally renders PDF or DOCX.

## Current API Shape

Report export:

```text
POST /api/assessments/{assessmentId}/reports/export
```

Report center:

```text
GET /api/reports
GET /api/reports/{reportId}
GET /api/reports/{reportId}/download
```

The export response returns report metadata plus `contentText` and `downloadUrl`. The report record stores `reportNo`, `projectId`, `assessmentId`, `reportType`, `reportTitle`, `fileName`, `filePath`, `contentText`, `generatedBy`, and `generatedAt`.

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

For standalone use outside the app, collect the same fields from the current evaluation object rather than querying a database as the source of truth.

## Report Sections

Follow the current report content structure:

1. 报告封面: project code/name, city, assessment batch, model/rubric, benchmark source, generated time.
2. 整体评价情况: total score, level, status, low-score warnings, manual-review count, manual correction count, AI evidence coverage.
3. 评价图表数据: dimension and indicator chart data; PDF can include static rose charts when available.
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
- If optimization is missing and `generateOptimizationIfMissing=false`, say it is not available instead of creating informal advice.
- If `generateOptimizationIfMissing=true`, generate optimization through the same structured advice rules in `improvement-advice.md`.

## Formatting Notes

- Markdown is the canonical content body and should remain readable by itself.
- PDF uses HTML rendering, embedded CJK font support, summary blocks, tables, and optional static rose charts.
- DOCX is generated from Markdown headings, paragraphs, and tables; avoid relying on complex layout that the current simple DOCX writer cannot preserve.
- For PDF/DOCX quality-sensitive delivery, verify actual rendered output when possible, especially Chinese text, tables, and page flow.
