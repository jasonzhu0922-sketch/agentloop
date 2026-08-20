import type { SuccessCriterion } from "../planning/contracts.ts";

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
  readonly requiredToolNames: readonly string[];
  readonly skillNames?: readonly string[];
}

const OPERATION_PROFILES: readonly OperationProfile[] = [
  {
    id: "data_analysis",
    name: "Data analysis",
    description: "Inspect, transform, summarize, or reason over tabular, spreadsheet, log, metric, or other bulk data inputs.",
    planningRules: [
      "Plan a bounded extraction-and-analysis workflow; do not make full raw-data dumping the success criterion.",
      "Require a durable structured extraction artifact when the input is large, wide, or likely to be reused by later writing/reporting.",
      "For data-to-report requests over files or bulk data, split source profiling, extraction-program authoring when needed, extraction execution, report writing, and verification into separate dependency-linked steps.",
      "The source-profiling step identifies files, sheets/tables, fields, ranges, counts, and filters; it should not also write the final structured evidence or report.",
      "The extraction execution step must stop at structured evidence and analysis facts; the writing step must depend on that artifact instead of re-reading or re-dumping the source data.",
      "Success criteria should cite source scope, schema/fields, row or record counts, and the analysis artifact or hash.",
    ],
    executionRules: [
      "First identify source files, sheets/tables, schema, row/record counts, and the exact ranges or filters needed for the user goal.",
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
      "Success criteria must name the required artifact type and an observable verification.",
      "Do not plan artifact delivery unless a file-producing tool is available.",
    ],
    executionRules: [
      "Establish the output path and expected format before producing the artifact.",
      "After generation, verify existence, size, and a format-appropriate structural or render check.",
      "Use the artifact path as evidence; command stdout that only mentions a filename is not delivery evidence by itself.",
    ],
    successEvidence: [
      "artifact path",
      "existence/size check",
      "format-specific verification",
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
  const text = normalize([
    input.objective,
    ...input.successCriteria.flatMap((criterion) => [criterion.id, criterion.description]),
    ...(input.skillNames ?? []),
  ].join("\n"));
  const tools = new Set(input.requiredToolNames);
  if (tools.has("websearch") || tools.has("webfetch") || matchesWebResearch(text)) {
    return profile("web_research");
  }
  if (matchesCodeChange(text)) {
    return profile("code_change");
  }
  if (matchesDataAnalysis(text)) {
    return profile("data_analysis");
  }
  if (matchesArtifactBuild(text) || hasFileProducerTool(tools)) {
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

function matchesWebResearch(value: string): boolean {
  return /(?:\b(?:web|search|fetch|source|url|internet|browser|news|latest|cite|citation)\b|联网|网页|搜索|检索|来源|网址|新闻|最新|引用)/iu
    .test(value);
}

function matchesArtifactBuild(value: string): boolean {
  return /(?:\.(?:png|pdf|md|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|csv|json|txt)\b|\b(?:file|artifact|render|export|save|generate|create|produce|build|output)\b|文件|产物|渲染|导出|保存|生成|创建|制作|输出)/iu
    .test(value);
}

function hasFileProducerTool(tools: ReadonlySet<string>): boolean {
  for (const name of tools) {
    if (name === "computer_write_file") return true;
    if (/(^|_)(write|create|generate|render|export|save)(_|$)/.test(name)) return true;
  }
  return false;
}
