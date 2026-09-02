import type { SuccessCriterion } from "../planning/contracts.ts";
import { classifyTaskIntent } from "./task-intent.ts";

export type OperationProfileId =
  | "data_analysis"
  | "content_generation"
  | "code_change"
  | "web_research"
  | "artifact_build"
  | "direct_answer";

export interface OperationProfile {
  readonly id: OperationProfileId;
  readonly name: string;
  readonly description: string;
  readonly planningRules: readonly string[];
  readonly executionRules: readonly string[];
  readonly successEvidence: readonly string[];
}

export interface OperationProfileInput {
  readonly objective: string;
  readonly successCriteria: readonly Pick<SuccessCriterion, "id" | "description">[];
  readonly recommendedToolNames: readonly string[];
  readonly skillNames?: readonly string[];
}

const OPERATION_PROFILES: readonly OperationProfile[] = [
  {
    id: "data_analysis",
    name: "Data analysis",
    description: "Inspect, transform, summarize, or reason over tabular, spreadsheet, log, metric, or other bulk data inputs.",
    planningRules: [
      "Plan a bounded extraction-and-analysis workflow; do not make full raw-data dumping the success criterion.",
      "Require a durable structured extraction artifact when the input is a visible spreadsheet directory, large, wide, or likely to be reused by later writing/reporting.",
      "Choose the smallest dependency shape that preserves semantic boundaries: one fact_acquisition leaf may both profile and extract when a generic extraction tool exists; split authoring/execution only when a custom parser, expensive transformation, or multiple data stages are actually needed.",
      "The fact_acquisition boundary identifies files, sheets/tables, fields, ranges, counts, filters, and structured extraction artifacts; it must not also write the final user-facing report or conversational conclusion.",
      "The extraction execution step must stop at structured evidence and analysis facts; the writing step must depend on that artifact instead of re-reading or re-dumping the source data.",
      "For conversation-only data analysis, the final produce/deliver leaf should require delivery_receipt and explicit_caveats, not artifact_path or artifact_acceptance.",
      "Success criteria should cite source scope, schema/fields, row or record counts, and the analysis artifact or hash.",
    ],
    executionRules: [
      "First identify source files, sheets/tables, schema, row/record counts, and the exact ranges or filters needed for the user goal.",
      "For user-authorized visible spreadsheet directories, use visible_index_directory spreadsheetProfile first, then visible_extract_tables for bounded structured table evidence when available.",
      "For large spreadsheets, tables, logs, or metric dumps, create one durable structured extraction artifact in the workspace, such as JSON or Markdown, with counts, fields, source ranges, and hashes.",
      "Use that artifact for reasoning and reporting. Do not repeatedly print overlapping raw rows to stdout with only formatting, truncation length, or row-window changes.",
      "If a command returns stdoutRef or stderrRef, inspect the referenced workspace file and sha256 instead of rerunning an overlapping command solely to recover prior output.",
      "Complete only the current Plan step's objective and success criteria. Do not create a downstream report, rewrite, or delivery artifact unless this step explicitly requires it.",
    ],
    successEvidence: [
      "source identity and scope",
      "schema or field summary",
      "record/range counts",
      "structured extraction artifact path or content-addressed reference",
      "analysis conclusions tied to the extracted evidence",
    ],
  },
  {
    id: "content_generation",
    name: "Content generation",
    description: "Draft, rewrite, summarize, translate, or compose narrative text, reports, briefs, messages, or documentation.",
    planningRules: [
      "Separate source gathering from final writing when the content depends on files, data, or prior artifacts.",
      "Success criteria should cover audience, format, source grounding, and final deliverable location when a file is requested.",
      "Do not make optional examples, exercises, visual polish, exhaustive source metadata, or unavailable source depth blocking success criteria unless the user explicitly requested them.",
    ],
    executionRules: [
      "Clarify the requested format from the user input and current Plan step; do not add unrequested sections or optional polish as separate work.",
      "Ground factual claims in supplied material, prior tool evidence, or named source artifacts.",
      "For long outputs, draft into a workspace file and verify that the final file exists and matches the requested format.",
    ],
    successEvidence: [
      "final text or file path",
      "source artifact references when factual grounding is required",
      "format and audience fit",
    ],
  },
  {
    id: "code_change",
    name: "Code change",
    description: "Inspect, modify, test, or explain source code, configuration, or repository behavior.",
    planningRules: [
      "Plan from the smallest relevant implementation and test surface; avoid unrelated refactors.",
      "Success criteria should include the behavioral contract and focused verification command or reason it cannot run.",
    ],
    executionRules: [
      "Read the relevant implementation and tests before editing.",
      "Locate the first semantic boundary where the behavior becomes wrong, then patch that boundary narrowly.",
      "Run focused tests or static checks tied to the changed behavior and report any verification gap.",
    ],
    successEvidence: [
      "changed files",
      "behavioral contract restored",
      "focused test or check output",
    ],
  },
  {
    id: "web_research",
    name: "Web research",
    description: "Search, fetch, compare, or cite current external web sources.",
    planningRules: [
      "Use complete intent-level queries instead of repeated word-fragment searches.",
      "Success criteria should require source URLs, publication dates when relevant, and a relevance judgment.",
    ],
    executionRules: [
      "Search once with a complete query phrase reflecting the user's intent; broaden by increasing result count before issuing many near-duplicate searches.",
      "Fetch a small number of high-relevance primary or authoritative sources, then synthesize from those sources.",
      "Preserve source URLs and date context for claims that may change.",
    ],
    successEvidence: [
      "search query or source selection rationale",
      "fetched source URLs",
      "dated, attributed conclusions",
    ],
  },
  {
    id: "artifact_build",
    name: "Artifact build",
    description: "Create, render, export, or save a concrete file or media artifact.",
    planningRules: [
      "Success criteria must name the required artifact type and observable delivery evidence.",
      "When the user requests an artifact format, treat its minimum usable shape as core evidence: openable/readable output, requested type, workspace path, and non-empty receipt.",
      "For browser-presentable, presentation-style, or document-like artifacts, basic openability and requested format/type are core delivery evidence; navigation, interaction, visual polish, and browser checks are Skill-owned QA or tool signals unless the user or loaded Skill explicitly requires them.",
      "Do not force a structured page-spec producer for generic HTML artifacts. Plan only the requested artifact boundary; the loaded Skill or execution Tool choice decides whether the artifact is custom code, a standalone file, or an explicitly paginated materialization.",
      "Prefer one aggregate artifact_acceptance evidence object over separate QA leaves when the available Tool catalog exposes verify_artifact_acceptance.",
      "Do not plan artifact delivery unless a file-producing tool is available.",
      "Advanced navigation, responsive polish, charts, visual refinements, and render/browser checks are best-effort execution preferences unless the user or loaded Skill explicitly requires them.",
    ],
    executionRules: [
      "Establish the output path and expected format before producing the artifact.",
      "Use materialize_paginated_html only when the current step explicitly asks for paginated HTML, HTML-PPT, slide/training material, or another page-by-page artifact that fits its structured page spec. For ordinary standalone HTML, distinctive visual pages, apps, dashboards, or custom interactions, use the appropriate code/file production path.",
      "After generation, record existence, size, and any format evidence required by the current leaf or loaded Skill contract.",
      "When verify_artifact_acceptance is available, call it once for the final artifact and preserve its checks, verdict, satisfied evidence kinds, failed evidence kinds, and explicit skipped_unavailable caveats.",
      "After artifact acceptance satisfies the required evidence, do not reread generated files merely to restate paths, hashes, size, or format facts already present in receipts.",
      "Use the artifact path as evidence; command stdout that only mentions a filename is not delivery evidence by itself.",
    ],
    successEvidence: [
      "artifact path",
      "existence/size evidence",
      "aggregate artifact acceptance evidence when available",
      "format evidence required by the leaf or loaded Skill contract",
    ],
  },
  {
    id: "direct_answer",
    name: "Direct answer",
    description: "Answer directly from the conversation without external tools or artifact creation.",
    planningRules: [
      "Use exactly one no-tool response step for conversational replies.",
      "Do not resume, repeat, or modify prior work unless the user explicitly asks for execution.",
    ],
    executionRules: [
      "Answer the latest user request concisely from available context.",
      "State uncertainty or missing context instead of inventing external facts.",
    ],
    successEvidence: [
      "non-empty answer to the latest user request",
    ],
  },
];

export function operationProfileCatalogForPlanning(): readonly Pick<
  OperationProfile,
  "id" | "name" | "description" | "planningRules" | "successEvidence"
>[] {
  return OPERATION_PROFILES.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    planningRules: profile.planningRules,
    successEvidence: profile.successEvidence,
  }));
}

export function inferOperationProfile(input: OperationProfileInput): OperationProfile {
  const intent = classifyTaskIntent(input);
  const text = normalize([
    input.objective,
    ...input.successCriteria.flatMap((criterion) => [criterion.id, criterion.description]),
    ...(input.skillNames ?? []),
  ].join("\n"));
  const tools = new Set(input.recommendedToolNames);
  if (tools.has("websearch") || tools.has("webfetch") || intent.sourceNeed !== "none") {
    return profile("web_research");
  }
  if (matchesCodeChange(text)) {
    return profile("code_change");
  }
  if (matchesDataAnalysis(text)) {
    return profile("data_analysis");
  }
  if (intent.deliverySurface === "workspace_artifact" || hasFileProducerTool(tools)) {
    return profile("artifact_build");
  }
  if (matchesContentGeneration(text)) {
    return profile("content_generation");
  }
  return profile("direct_answer");
}

export function executionOperationProfile(input: OperationProfileInput): Readonly<{
  id: OperationProfileId;
  name: string;
  description: string;
  executionRules: readonly string[];
  successEvidence: readonly string[];
}> {
  const selected = inferOperationProfile(input);
  return {
    id: selected.id,
    name: selected.name,
    description: selected.description,
    executionRules: selected.executionRules,
    successEvidence: selected.successEvidence,
  };
}

function profile(id: OperationProfileId): OperationProfile {
  const found = OPERATION_PROFILES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`Unknown operation profile ${id}`);
  return found;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ");
}

function matchesDataAnalysis(value: string): boolean {
  return /(?:\b(?:xlsx|xlsm|xls|csv|tsv|spreadsheet|sheet|workbook|table|dataset|data|metric|analytics?|statistics?|schema|row|column|pivot|aggregate|analysis)\b|excel|表格|工作簿|工作表|数据|指标|统计|字段|行列|分析|聚合|清单|台账)/iu
    .test(value);
}

function matchesContentGeneration(value: string): boolean {
  return /(?:\b(?:draft|rewrite|summari[sz]e|translate|compose|copy|brief|report|document|markdown|memo|email|proposal|story|article)\b|撰写|改写|总结|翻译|文案|简报|报告|文档|邮件|方案|材料)/iu
    .test(value);
}

function matchesCodeChange(value: string): boolean {
  return /(?:\b(?:code|repo|repository|test|bug|fix|implement|refactor|compile|typescript|javascript|python|api|config|runtime|module)\b|代码|仓库|测试|修复|实现|重构|编译|接口|配置|模块)/iu
    .test(value);
}

function hasFileProducerTool(tools: ReadonlySet<string>): boolean {
  for (const name of tools) {
    if (name === "convert_artifact") return true;
    if (name === "materialize_paginated_html") return true;
    if (name === "computer_patch_file") return true;
    if (name === "computer_write_file") return true;
    if (/(^|_)(write|create|generate|render|export|convert|save)(_|$)/.test(name)) return true;
  }
  return false;
}
