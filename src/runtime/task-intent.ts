import type { ArtifactKind, SourceNeed } from "./dynamic-prompt.ts";

export type DeliverySurface = "conversation" | "workspace_artifact";

export interface TaskIntentClassification {
  readonly deliverySurface: DeliverySurface;
  readonly artifactKind: ArtifactKind;
  readonly sourceNeed: SourceNeed;
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
  readonly successCriteria?: readonly { readonly id: string; readonly description: string }[];
  readonly recommendedToolNames?: readonly string[];
  readonly skillNames?: readonly string[];
  readonly responseOnly?: boolean;
}

export function classifyTaskIntent(input: TaskIntentInput): TaskIntentClassification {
  const text = normalize([
    input.objective,
    ...(input.successCriteria ?? []).flatMap((criterion) => [criterion.id, criterion.description]),
    ...(input.skillNames ?? []),
  ].join("\n"));
  const signals = {
    action: matchedArtifactActions(text),
    artifact: matchedArtifactSurfaces(text),
    answer: matchedConversationAnswerSignals(text),
    source: matchedSourceSignals(text),
  };
  const artifactKind = detectArtifactKindSignal(text);
  const sourceNeed = inferSourceNeedFromIntent(text);
  const hasFileProducer = (input.recommendedToolNames ?? []).some(isFileProducerToolName);
  const wantsArtifact = artifactKind !== "none"
    && (signals.action.length > 0 || hasFileProducer)
    && input.responseOnly !== true;
  const explicitConversationOnly = signals.answer.length > 0 && signals.action.length === 0 && !hasFileProducer;
  return {
    deliverySurface: wantsArtifact && !explicitConversationOnly ? "workspace_artifact" : "conversation",
    artifactKind: wantsArtifact ? artifactKind : "none",
    sourceNeed,
    wantsArtifact,
    wantsConversationAnswer: explicitConversationOnly || !wantsArtifact,
    signals,
  };
}

export function requestedArtifactKindsFromIntent(input: string): Set<Exclude<ArtifactKind, "none">> {
  const kind = detectArtifactKindSignal(normalize(input));
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

function detectArtifactKindSignal(text: string): ArtifactKind {
  if (/(?:\b(?:html|web\s?page|webpage|landing\s?page|site|website|frontend|ui)\b|网页|页面|首页|登录页|落地页|站点|网站|前端|界面)/iu.test(text)) return "html";
  if (/(?:pptx?|slides?|deck|presentation|幻灯片|演示文稿|课件)/iu.test(text)) return "presentation";
  if (/(?:pdf|docx?|word|document|markdown|md|txt|文档|报告书)/iu.test(text)) return "document";
  if (/(?:xlsx?|excel|spreadsheet|sheet|csv|表格|工作簿)/iu.test(text)) return "spreadsheet";
  if (/(?:png|jpe?g|webp|image|visual|canvas|poster|artwork|art\s?piece|visual\s?study|海报|图片|图像|视觉|画布)/iu.test(text)) return "image";
  if (/(?:code|script|program|app|json|代码|脚本|程序|应用)/iu.test(text)) return "code";
  return "none";
}

function inferSourceNeedFromIntent(text: string): SourceNeed {
  if (/(?:strict source|official source|authoritative|标准全文|官方|权威|严格来源|精确条款|逐条核验)/iu.test(text)) {
    return "strict_user_source";
  }
  if (/(?:source[- ]grounded|research|lookup|cite|citation|standard|policy|regulation|rating|certification|来源|调研|检索|引用|标准|政策|法规|评级|认证|出处)/iu.test(text)) {
    return "source_grounded";
  }
  if (/(?:latest|current|today|recent|最新|当前|今天|近期)/iu.test(text)) return "lookup_lite";
  return "none";
}

function matchedArtifactActions(text: string): string[] {
  return matchSignals(text, [
    ["make", /\b(?:make|create|build|generate|produce|deliver|write|export|convert|design|implement|materialize)\b/iu],
    ["repair", /\b(?:fix|repair|edit|update|correct|regenerate|rebuild|open|inspect|check)\b|修复|修改|更正|重新生成|重做|打开|检查|查看|乱码|不可读|打不开/iu],
    ["make_zh", /做|制作|创建|生成|产出|输出|交付|写|设计|实现|搭建|构建|导出|转换|转成|转为|转/iu],
  ]);
}

function matchedArtifactSurfaces(text: string): string[] {
  return matchSignals(text, [
    ["format", /\.(?:png|pdf|md|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|csv|json|txt)\b|\b(?:png|pdf|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|excel|csv|json|txt)\b/iu],
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
  return matchSignals(text, [
    ["strict", /strict source|official source|authoritative|标准全文|官方|权威|严格来源|精确条款|逐条核验/iu],
    ["source_grounded", /source[- ]grounded|research|lookup|cite|citation|standard|policy|regulation|rating|certification|来源|调研|检索|引用|标准|政策|法规|评级|认证|出处/iu],
    ["fresh", /latest|current|today|recent|最新|当前|今天|近期/iu],
  ]);
}

function matchSignals(text: string, patterns: readonly [string, RegExp][]): string[] {
  return patterns.flatMap(([id, pattern]) => pattern.test(text) ? [id] : []);
}

function isFileProducerToolName(name: string): boolean {
  if (name === "materialize_paginated_html" || name === "computer_write_file" || name === "computer_run_command") return true;
  return /(^|_)(write|create|generate|render|export|save)(_|$)/.test(name);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}
