import type { ArtifactAction, ArtifactKind, ResearchPolicy, SourceNeed } from "./dynamic-prompt.ts";
import type { UploadedSourceSummary } from "./contracts.ts";
import { canonicalArtifactFormatFamily } from "../shared/artifact-format.ts";

export type DeliverySurface = "conversation" | "workspace_artifact";

export interface TaskIntentClassification {
  readonly deliverySurface: DeliverySurface;
  readonly artifactAction: ArtifactAction;
  readonly artifactKind: ArtifactKind;
  readonly sourceNeed: SourceNeed;
  readonly researchPolicy?: ResearchPolicy;
  readonly wantsArtifact: boolean;
  readonly wantsConversationAnswer: boolean;
  readonly signals: {
    readonly action: readonly string[];
    readonly artifact: readonly string[];
    readonly answer: readonly string[];
    readonly source: readonly string[];
  };
}

export interface TaskIntentInput {
  readonly objective: string;
  /** Structured constraints retained by the conversation turn resolver. */
  readonly userConstraints?: readonly string[];
  readonly successCriteria?: readonly { readonly id: string; readonly description: string }[];
  readonly toolNames?: readonly string[];
  /**
   * Informative only. Skill availability or names must not change user-owned
   * delivery intent: a catalog can contain both artifact builders and
   * source-provider Skills for every Run.
   */
  readonly skillNames?: readonly string[];
  readonly responseOnly?: boolean;
  /**
   * Runtime-owned semantic evidence demand resolved from user-authored text and
   * the full conversation. When present, this is authoritative: downstream
   * consumers must not upgrade it by re-reading model-authored objectives.
   */
  readonly evidenceDemand?: SourceNeed;
}

export interface UploadedSourcePlanningContext {
  readonly schema: "agentloop.uploadedSourcePlanningContext/v1";
  readonly totalCount: number;
  readonly readyCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly formats: readonly {
    readonly family: string;
    readonly extensions: readonly string[];
    readonly mimeTypes: readonly string[];
    readonly count: number;
  }[];
  readonly names: readonly string[];
  readonly namesTruncated: boolean;
  readonly allReadyInputsSameFormat: boolean;
  readonly formatSemantics: "input_evidence_only";
}

export function uploadedSourcePlanningContext(
  sources: readonly UploadedSourceSummary[],
): UploadedSourcePlanningContext {
  const statusCounts = new Map<string, number>();
  const formats = new Map<string, { extensions: Set<string>; mimeTypes: Set<string>; count: number }>();
  const names = sources.slice(0, 12).map((source) => source.originalName);
  for (const source of sources) {
    statusCounts.set(source.status, (statusCounts.get(source.status) ?? 0) + 1);
    if (source.status !== "ready") continue;
    const extension = source.extension.trim().toLowerCase();
    const mimeType = source.mimeType.trim().toLowerCase();
    const family = sourceFormatFamily(extension, mimeType);
    const current = formats.get(family) ?? { extensions: new Set<string>(), mimeTypes: new Set<string>(), count: 0 };
    if (extension.length > 0) current.extensions.add(extension);
    if (mimeType.length > 0) current.mimeTypes.add(mimeType);
    current.count += 1;
    formats.set(family, current);
  }
  return {
    schema: "agentloop.uploadedSourcePlanningContext/v1",
    totalCount: sources.length,
    readyCount: sources.filter((source) => source.status === "ready").length,
    statusCounts: Object.fromEntries(statusCounts),
    formats: [...formats.entries()].map(([family, value]) => ({
      family,
      extensions: [...value.extensions].sort(),
      mimeTypes: [...value.mimeTypes].sort(),
      count: value.count,
    })),
    names,
    namesTruncated: sources.length > names.length,
    allReadyInputsSameFormat: formats.size === 1 && sources.some((source) => source.status === "ready"),
    formatSemantics: "input_evidence_only",
  };
}

function sourceFormatFamily(extension: string, mimeType: string): string {
  if (extension.length > 0) return canonicalArtifactFormatFamily(extension);
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("wordprocessingml") || mimeType.includes("msword")) return "word";
  if (mimeType.includes("presentationml") || mimeType.includes("powerpoint")) return "pptx";
  if (mimeType.includes("spreadsheetml") || mimeType.includes("excel")) return "xlsx";
  if (mimeType.includes("html")) return "html";
  return mimeType || "unknown";
}

/**
 * A neutral, runtime-owned view of the user turn for Skill recall.  Uploaded
 * filenames and formats are evidence about the operation's input boundary,
 * not a request to produce a file of that same format.  They are exposed only
 * for native modify/transform work, where the original bytes must be owned by
 * a compatible format Skill.
 */
export function planningSkillRecallInput(input: TaskIntentInput & {
  readonly uploadedSources?: readonly UploadedSourceSummary[];
}): string {
  const objective = [
    input.objective,
    ...(input.userConstraints ?? []),
    ...(input.successCriteria ?? []).flatMap((criterion) => [criterion.id, criterion.description]),
  ].map((value) => value.trim()).filter(Boolean).join("\n");
  const intent = classifyTaskIntent({ ...input, objective, userConstraints: undefined, successCriteria: undefined });
  if (intent.artifactAction !== "modify" && intent.artifactAction !== "transform") return objective;
  const sources = (input.uploadedSources ?? []).filter((source) => source.status === "ready");
  if (sources.length === 0) return objective;
  return [
    objective,
    "<uploaded_native_artifact_context>",
    JSON.stringify(uploadedSourcePlanningContext(input.uploadedSources ?? [])),
    "</uploaded_native_artifact_context>",
  ].join("\n");
}

export function classifyTaskIntent(input: TaskIntentInput): TaskIntentClassification {
  const text = normalize([
    input.objective,
    ...(input.userConstraints ?? []),
    ...(input.successCriteria ?? []).flatMap((criterion) => [criterion.id, criterion.description]),
  ].join("\n"));
  const signals = {
    action: matchedArtifactActions(text),
    artifact: matchedArtifactSurfaces(text),
    answer: matchedConversationAnswerSignals(text),
    source: matchedSourceSignals(text),
  };
  const artifactAction = inferArtifactAction(text, signals.action);
  const artifactKind = detectRequestedArtifactKind(text, artifactAction);
  const sourceNeed = input.evidenceDemand ?? inferSourceNeedFromIntent(text);
  const researchPolicy = researchPolicyForIntentText(text, sourceNeed, input.toolNames ?? []);
  const wantsArtifact = artifactAction !== "none" && artifactKind !== "none"
    // Tool availability authorizes a possible workspace write, but it never
    // turns a referenced input format into a requested output artifact.
    && signals.action.length > 0
    && input.responseOnly !== true;
  const explicitConversationOnly = signals.answer.length > 0 && signals.action.length === 0;
  return {
    deliverySurface: wantsArtifact && !explicitConversationOnly ? "workspace_artifact" : "conversation",
    artifactAction,
    artifactKind: wantsArtifact ? artifactKind : "none",
    sourceNeed,
    ...(researchPolicy === undefined ? {} : { researchPolicy }),
    wantsArtifact,
    wantsConversationAnswer: explicitConversationOnly || !wantsArtifact,
    signals,
  };
}

export function researchPolicyForIntent(input: TaskIntentInput): ResearchPolicy | undefined {
  const text = normalize([
    input.objective,
    ...(input.userConstraints ?? []),
    ...(input.successCriteria ?? []).flatMap((criterion) => [criterion.id, criterion.description]),
    ...(input.skillNames ?? []),
  ].join("\n"));
  const sourceNeed = input.evidenceDemand ?? inferSourceNeedFromIntent(text);
  return researchPolicyForIntentText(text, sourceNeed, input.toolNames ?? []);
}

export function requestedArtifactKindsFromIntent(input: string): Set<Exclude<ArtifactKind, "none">> {
  const kind = classifyTaskIntent({ objective: input }).artifactKind;
  return kind === "none" ? new Set() : new Set([kind]);
}

export function requestsArtifactBuildFromIntent(input: string): boolean {
  return classifyTaskIntent({ objective: input }).wantsArtifact;
}

export function requestsPriorArtifactChange(input: string): boolean {
  const text = normalize(input);
  return matchedArtifactActions(text).length > 0
    || matchSignals(text, [
      ["qualitative_revision", /\b(?:redo|regenerate|rebuild|revise|improve|enhance|polish|upgrade|iterate|adjust|change|better|more|less|not enough)\b|重新|重做|再来|再生成|重新生成|改|修改|调整|优化|增强|提升|升级|迭代|不够|不太够|不满意|不像|不对|要有|要更|更好|高级|高端|高大上|专业|清晰|美观|丰富|精简|科技感/iu],
    ]).length > 0;
}

function inferArtifactAction(text: string, actionSignals: readonly string[]): ArtifactAction {
  if (actionSignals.includes("transform")) return "transform";
  if (actionSignals.includes("repair") || explicitNativeArtifactMutationRequested(text)) return "modify";
  if (actionSignals.includes("make") || actionSignals.includes("make_zh")) return "create";
  return "none";
}

function detectRequestedArtifactKind(text: string, action: ArtifactAction): ArtifactKind {
  if (action === "none") return "none";
  if (action === "create") return detectArtifactKindSignal(artifactCreationClause(text));
  if (action === "transform") {
    const outputKind = detectArtifactKindSignal(artifactTransformationOutputClause(text));
    if (outputKind !== "none") return outputKind;
  }
  return detectArtifactKindSignal(text);
}

function artifactCreationClause(text: string): string {
  const matches = [...text.matchAll(/\b(?:make|create|build|generate|produce|deliver|write|export|design|implement|materialize|form)\b|做|制作|创建|生成|形成|产出|输出|交付|写|设计|实现|搭建|构建|导出/giu)];
  const last = matches.at(-1);
  return last?.index === undefined ? text : text.slice(last.index);
}

function artifactTransformationOutputClause(text: string): string {
  const matches = [...text.matchAll(/\b(?:to|into|as)\b|转成|转为|转换成|转换为|导出为|输出为/giu)];
  const last = matches.at(-1);
  return last?.index === undefined ? text : text.slice(last.index + last[0].length);
}

function detectArtifactKindSignal(text: string): ArtifactKind {
  if (/(?:\b(?:html|web\s?page|webpage|landing\s?page|site|website|frontend|ui)\b|网页|页面|首页|登录页|落地页|站点|网站|前端|界面)/iu.test(text)) return "html";
  if (/(?:pptx?|slides?|deck|presentation|幻灯片|演示文稿|课件)/iu.test(text)) return "presentation";
  if (/(?:pdf|docx?|word|document|markdown|md|txt|文档|报告书|(?:总结|报告|方案|说明|文稿|材料).{0,8}文件|文件.{0,8}(?:总结|报告|方案|说明|文稿|材料))/iu.test(text)) return "document";
  if (/(?:xlsx?|excel|spreadsheet|sheet|csv|表格|工作簿)/iu.test(text)) return "spreadsheet";
  if (/(?:png|jpe?g|webp|image|visual|canvas|poster|artwork|art\s?piece|visual\s?study|海报|图片|图像|视觉|画布)/iu.test(text)) return "image";
  if (/(?:code|script|program|app|json|代码|脚本|程序|应用)/iu.test(text)) return "code";
  if (/(?:\b(?:report|summary|brief|memo|proposal|assessment)\b|报告|总结|简报|备忘录|方案|评估|评价材料)/iu.test(text)) return "document";
  return "none";
}

function explicitNativeArtifactMutationRequested(value: string): boolean {
  return /(?:\b(?:edit|modify|update|revise|repair|fix|restyle|redesign|reformat|retouch|crop|resize|replace|remove|delete|insert|append|rename|reorder|sort|filter|apply)\b|修改|更改|改动|改为|改成|调整|优化|修复|更正|美化|重设计|重新排版|改版|替换|删除|移除|新增|添加|插入|重命名|排序|筛选|套用|应用|统一.{0,8}(?:视觉|主题|风格|样式|版式|布局|配色|颜色|字体|背景))/iu.test(value);
}

function inferSourceNeedFromIntent(text: string): SourceNeed {
  if (/(?:strict source|official source|authoritative|标准全文|官方|权威|严格来源|精确条款|逐条核验)/iu.test(text)) {
    return "strict_user_source";
  }
  if (/(?:source[- ]grounded|source[_ -]summary|source[_ -]urls?|source\s+evidence|research|lookup|cite|citation|standard|policy|regulation|rating|certification|public\s+sources?|web\s+sources?|internet|来源|调研|检索|引用|标准|政策|法规|评级|认证|出处|互联网|联网|网上|公开资料|公开材料|公开信息)/iu.test(text)) {
    return "source_grounded";
  }
  if (hasFreshExternalLookupNeed(text)) return "lookup_lite";
  // A specific named external fact does not become safe to answer from model
  // memory merely because the user omitted words such as "search" or
  // "source". Keep this category deliberately structural: a factual question
  // plus an external-entity signal, never a product-, provider-, or phrase-
  // specific allowlist.
  if (SPECIFIC_EXTERNAL_FACT_QUESTION_PATTERN.test(text) && EXTERNAL_ENTITY_SIGNAL_PATTERN.test(text)) {
    return "source_grounded";
  }
  return "none";
}

function researchPolicyForIntentText(
  text: string,
  sourceNeed: SourceNeed,
  _toolNames: readonly string[],
): ResearchPolicy | undefined {
  if (sourceNeed === "none") return undefined;
  const freshnessNeed = hasFreshExternalLookupNeed(text)
    ? "current"
    : "none";
  if (sourceNeed === "strict_user_source") {
    return researchPolicy("strict", 2, 5, "official_required", freshnessNeed);
  }
  if (sourceNeed === "lookup_lite") {
    return researchPolicy("opportunistic", 1, 2, "quality_weighted", "current");
  }
  if (
    /(?:if available|when available|otherwise use|可用则用|能找到.{0,12}就用|找不到.{0,12}(?:靠|用|基于).{0,12}(?:知识|经验)|允许使用|可以使用|可参考|互联网能找到)/iu
      .test(text)
  ) {
    return researchPolicy("opportunistic", 1, 3, "quality_weighted", freshnessNeed);
  }
  return researchPolicy("bounded", 2, 5, "quality_weighted", freshnessNeed);
}

function researchPolicy(
  depth: ResearchPolicy["depth"],
  maxSearches: number,
  maxFetches: number,
  authorityNeed: ResearchPolicy["authorityNeed"],
  freshnessNeed: ResearchPolicy["freshnessNeed"],
): ResearchPolicy {
  return {
    schema: "agentloop.researchPolicy/v1",
    depth,
    maxSearches,
    maxFetches,
    authorityNeed,
    freshnessNeed,
    sourcePreference: [
      "direct_or_primary_sources_when_relevant_and_accessible",
      "reputable_independent_or_industry_sources",
      "cross_checked_secondary_sources",
      "low_quality_or_unattributed_sources_only_as_discovery_leads",
    ],
    lowValueSourceSignals: [
      "empty_or_tiny_body",
      "browser_upgrade_or_login_page",
      "http_error_or_forbidden",
      "aggregated_qa_or_copied_snippet_without_primary_url",
    ],
    stopWhen: [
      "source_summary_and_source_urls_are_recorded",
      "verified_partial_unverified_claims_are_separated",
      "missing_or_unverified_facts_are_explicit_caveats",
      "bounded_search_and_fetch_budget_is_spent",
    ],
  };
}

function matchedArtifactActions(text: string): string[] {
  return matchSignals(text, [
    ["make", /\b(?:make|create|build|generate|produce|deliver|write|export|convert|design|implement|materialize|form)\b/iu],
    ["repair", /\b(?:fix|repair|edit|update|correct|regenerate|rebuild|open|inspect|check)\b|修复|修改|更改|改动|改为|改成|更正|重新生成|重做|打开|检查|查看|乱码|不可读|打不开/iu],
    ["transform", /\b(?:convert|merge|combine|concatenate|join|split|rotate|encrypt|decrypt|watermark|compress|resize|transcode)\b|合并|拼接|拆分|分割|旋转|加密|解密|加水印|压缩|缩放|转码|转换|转成|转为/iu],
    ["make_zh", /做|制作|创建|生成|形成|产出|输出|交付|写|设计|实现|搭建|构建|导出|转换|转成|转为|转/iu],
  ]);
}

function matchedArtifactSurfaces(text: string): string[] {
  return matchSignals(text, [
    ["format", /\.(?:png|pdf|md|markdown|html|svg|jpe?g|webp|gif|docx?|pptx|xlsx|csv|json|txt)\b|\b(?:png|pdf|markdown|html|svg|jpe?g|webp|gif|docx?|word|pptx|xlsx|excel|csv|json|txt)\b/iu],
    ["browser_ui", /\b(?:web\s?page|webpage|landing\s?page|site|website|frontend|ui)\b|网页|页面|首页|登录页|落地页|站点|网站|前端|界面/iu],
    ["artifact", /\b(?:artifact|file|dashboard|report|document|presentation|slides?|deck|canvas|poster|artwork|image|visual|app)\b|文件|档案|产物|报告|看板|材料|课件|演示|幻灯片|海报|图片|图像|视觉|画布|应用/iu],
  ]);
}

function matchedConversationAnswerSignals(text: string): string[] {
  return matchSignals(text, [
    ["explain", /\b(?:explain|describe|tell me|what is|how to|why|compare|review)\b|解释|说明|介绍|告诉我|怎么|如何|为什么|对比|评价/iu],
    ["snippet", /代码片段|示例代码|复制运行|可复制|方案|思路|建议/iu],
  ]);
}

function matchedSourceSignals(text: string): string[] {
  return [
    ...matchSignals(text, [
    ["strict", /strict source|official source|authoritative|标准全文|官方|权威|严格来源|精确条款|逐条核验/iu],
    ["source_grounded", /source[- ]grounded|source[_ -]summary|source[_ -]urls?|source\s+evidence|research|lookup|cite|citation|standard|policy|regulation|rating|certification|public\s+sources?|web\s+sources?|internet|来源|调研|检索|引用|标准|政策|法规|评级|认证|出处|互联网|联网|网上|公开资料|公开材料|公开信息/iu],
    ]),
    ...(hasFreshExternalLookupNeed(text) ? ["fresh"] : []),
  ];
}

// Keep the temporal vocabulary used for source need, research policy, and
// diagnostic signals in one place.  A bounded recent period still needs a
// live source even when the user does not explicitly say "search" or "web".
const FRESH_LOOKUP_PATTERN = /(?:latest|current|today|recent|最新|当前|今天|最近|近期|近\s*(?:一)?周|过去\s*(?:一)?周|近\s*七天|过去\s*七天|市场价格|价格|报价|行情|多少钱)/iu;
const LOCAL_EXECUTABLE_CONTRACT_REFERENCE_PATTERN = /(?:\b(?:load|inspect|read)\b|加载|读取|确认|查看).{0,48}(?:\b(?:skill|tool|renderer|render(?:er)?|schema|enum|parameter|capabilit(?:y|ies))\b|渲染(?:器|\s*schema|契约)?|合法参数|设计轴|工具|技能)/iu;

/**
 * Freshness can qualify either an external fact ("current price") or a
 * Runtime-owned contract ("load the current renderer schema"). The latter is
 * acquired through the already-authorized Skill/Tool interface, not web
 * research, and must not create a fictitious source-grounding requirement.
 */
function hasFreshExternalLookupNeed(text: string): boolean {
  return FRESH_LOOKUP_PATTERN.test(text) && !LOCAL_EXECUTABLE_CONTRACT_REFERENCE_PATTERN.test(text);
}
const SPECIFIC_EXTERNAL_FACT_QUESTION_PATTERN = /(?:\b(?:what|who|where|when|which)\s+(?:is|are|was|were|does|did)\b|是什么|指什么|什么意思|谁是|何时|什么时候|哪(?:个|些|家|项)|介绍一下|说明一下)/iu;
const EXTERNAL_ENTITY_SIGNAL_PATTERN = /(?:\d{2,}|["“”'][^"“”']{2,}["“”']|\b(?:company|corporation|group|organization|institution|agency|project|program|initiative|policy|standard|product|model)\b|集团|公司|机构|组织|部门|协会|学校|医院|项目|工程|计划|行动|政策|标准|产品|型号)/iu;

function matchSignals(text: string, patterns: readonly [string, RegExp][]): string[] {
  return patterns.flatMap(([id, pattern]) => pattern.test(text) ? [id] : []);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}
