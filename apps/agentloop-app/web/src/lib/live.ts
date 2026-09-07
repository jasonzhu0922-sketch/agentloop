import type { PlanStep, RunEvent } from "./types";
import { clip, eventLabel, eventTone, phaseLabel, stepLabel, toolAction, toolOutcome } from "./format";
import { translateRunEvent } from "./event-translator";

export interface LivePlan {
  readonly goal: string;
  readonly steps: readonly PlanStep[];
}

export interface ExecutionInsight {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly tone: "good" | "warn" | "bad" | "";
  readonly seq?: number;
}

export interface StreamingStatus {
  readonly content: string;
  readonly reasoningContent: string;
  readonly toolName?: string;
  readonly toolArgumentCharacters?: number;
  readonly toolArguments?: unknown;
}

export interface LiveFeedItem {
  readonly key: string;
  readonly kind: "thinking" | "reply" | "tool";
  readonly title: string;
  readonly detail: string;
  readonly rawType: string;
  readonly seq?: number;
}

export interface FailureSummary {
  readonly title: string;
  readonly reason: string;
  readonly progress: string;
  readonly nextAction: string;
  readonly rawMessage?: string;
}

export function admittedPlan(events: readonly RunEvent[]): { goal: string; steps: readonly PlanStep[] } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "plan.admitted") {
      return {
        goal: e.data && typeof e.data.goal === "string" ? e.data.goal : "",
        steps: Array.isArray(e.data?.steps) ? (e.data.steps as PlanStep[]) : [],
      };
    }
  }
  return null;
}

export function livePlan(events: readonly RunEvent[]): LivePlan | null {
  const a = admittedPlan(events);
  if (!a) return null;
  const status: Record<string, string> = {};
  for (const e of events) {
    if (e.type === "plan.step.started" && e.data?.stepId) status[String(e.data.stepId)] = "running";
    else if (e.type === "plan.step.completed" && e.data?.stepId) status[String(e.data.stepId)] = "completed";
    else if (e.type === "plan.step.failed" && e.data?.stepId) status[String(e.data.stepId)] = "failed";
  }
  return {
    goal: a.goal,
    steps: a.steps.map((s) => ({ ...s, status: (status[s.id] as PlanStep["status"]) ?? s.status })),
  };
}

export function latestStreaming(events: readonly RunEvent[]): RunEvent | null {
  let boundary = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i].type;
    if (type === "context.assembled" || type === "assistant.committed" || type === "step.completed") {
      boundary = events[i].seq ?? 0;
      break;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "assistant.streaming" && (events[i].seq ?? 0) > boundary) return events[i];
  }
  return null;
}

export function streamingToolProgress(stream: RunEvent | null): string {
  const status = streamingStatus(stream);
  if (status?.toolName === undefined) return "";
  return toolProgressView(status.toolName, status.toolArguments).detail;
}

export function streamingStatus(stream: RunEvent | null): StreamingStatus | null {
  if (!stream?.data) return null;
  const content = typeof stream.data.content === "string" ? stream.data.content : "";
  const reasoningContent = typeof stream.data.reasoningContent === "string" ? stream.data.reasoningContent : "";
  const calls = Array.isArray(stream.data.toolCalls) ? (stream.data.toolCalls as Array<{ name?: string; arguments?: unknown; argumentsRef?: { characters?: number } }>) : [];
  if (!calls.length) return { content, reasoningContent };
  const call = calls[calls.length - 1] ?? {};
  const name = typeof call.name === "string" && call.name.length > 0 ? call.name : undefined;
  const chars = toolArgumentCharacters(call.arguments, call.argumentsRef);
  return {
    content,
    reasoningContent,
    ...(name === undefined ? {} : { toolName: name }),
    ...(chars > 0 ? { toolArgumentCharacters: chars } : {}),
    ...("arguments" in call ? { toolArguments: call.arguments } : {}),
  };
}

/**
 * The live activity feed is intentionally short. Keep the latest real
 * provider reasoning separate from that window so completion/tool events do
 * not make an already-received reasoning delta disappear from the UI.
 */
export function latestProviderReasoning(events: readonly RunEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "assistant.streaming" && event.type !== "assistant.committed") continue;
    const reasoningContent = typeof event.data?.reasoningContent === "string" ? event.data.reasoningContent.trim() : "";
    if (reasoningContent) return reasoningContent;
  }
  return "";
}

function toolArgumentCharacters(argumentsValue: unknown, ref: { readonly characters?: number } | undefined): number {
  if (typeof argumentsValue === "string") return argumentsValue.length;
  if (ref?.characters !== undefined) return ref.characters;
  if (argumentsValue !== null && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
    const record = argumentsValue as Record<string, unknown>;
    if (typeof record.originalCharacters === "number") return record.originalCharacters;
  }
  return 0;
}

const FEED_THINKING_TYPES: Record<string, boolean> = {
  "run.started": true,
  "planning.started": true,
  "planning.skills.selected": true,
  "planning.turn.started": true,
  "planning.turn.completed": true,
  "plan.proposed": true,
  "plan.admitted": true,
  "plan.step.started": true,
  "plan.step.completed": true,
  "plan.step.failed": true,
  "context.assembled": true,
  "context.compaction.started": true,
  "context.compacted": true,
  "context.tool_outputs_pruned": true,
  "context.tool_outputs_projected": true,
  "candidate.approved": true,
  "candidate.rejected": true,
  "assessment.turn.completed": true,
  "skill.activation.available": true,
  "skill.activated": true,
  "skill.compliance.assessed": true,
  "model.retry": true,
  "action.failed": true,
  "run.completed": true,
  "run.failed": true,
  "run.cancelled": true,
};

const FEED_TOOL_TYPES: Record<string, boolean> = {
  "assistant.tool_call.committed": true,
  "tool.planned": true,
  "tool.effect_pending": true,
  "tool.completed": true,
  "tool.failed": true,
  "tool.rejected": true,
};

export function liveEventFeed(events: readonly RunEvent[], limit = 8): readonly LiveFeedItem[] {
  const planned = plannedMap(events);
  const items: LiveFeedItem[] = [];
  for (const event of events) {
    items.push(...liveFeedItemsForEvent(event, planned));
  }
  return coalesceStreamingFeedItems(items).slice(-limit);
}

function coalesceStreamingFeedItems(items: readonly LiveFeedItem[]): readonly LiveFeedItem[] {
  const output: LiveFeedItem[] = [];
  const streaming = new Map<LiveFeedItem["kind"], LiveFeedItem>();
  const flushStreaming = (): void => {
    for (const kind of ["thinking", "reply", "tool"] as const) {
      const item = streaming.get(kind);
      if (item !== undefined) output.push(item);
    }
    streaming.clear();
  };
  for (const item of items) {
    if (item.rawType === "assistant.streaming") {
      streaming.set(item.kind, item);
      continue;
    }
    flushStreaming();
    output.push(item);
  }
  flushStreaming();
  return output;
}

function liveFeedItemsForEvent(event: RunEvent, planned: ReadonlyMap<string, RunEvent>): readonly LiveFeedItem[] {
  const seq = event.seq;
  const base = { rawType: event.type, ...(seq === undefined ? {} : { seq }) };
  if (event.type === "assistant.streaming") {
    const status = streamingStatus(event);
    const items: LiveFeedItem[] = [];
    const streamPhase = phaseLabel(event.data?.phase);
    if (status?.reasoningContent.trim()) {
      items.push({
        ...base,
        key: feedKey(event, "thinking"),
        kind: "thinking",
        title: "模型思考",
        detail: status.reasoningContent,
      });
    }
    if (status?.content.trim()) {
      items.push({
        ...base,
        key: feedKey(event, "reply"),
        kind: "reply",
        title: "回复草稿",
        detail: clip(status.content, 720),
      });
    }
    if (status?.toolName) {
      const progress = toolProgressView(status.toolName, status.toolArguments);
      items.push({
        ...base,
        key: feedKey(event, "tool"),
        kind: "tool",
        title: progress.title,
        detail: progress.detail + (streamPhase ? " · " + runningSuffix(streamPhase) : ""),
      });
    }
    if (items.length > 0) return items;
    return [{
      ...base,
      key: feedKey(event, "thinking"),
      kind: "thinking",
      title: "等待模型流",
      detail: streamPhase ? "模型流已连接，正在" + streamPhase + "。" : "模型流已连接，等待增量内容。",
    }];
  }
  if (event.type === "assistant.committed") {
    const calls = Array.isArray(event.data?.toolCalls) ? event.data.toolCalls : [];
    const finish = String(event.data?.finishReason ?? "");
    const translated = translateRunEvent(event, planned);
    const items = reasoningFeedItem(event);
    if (finish === "tool_calls" || calls.length > 0) {
      return [...items, {
        ...base,
        key: feedKey(event, "tool"),
        kind: "tool",
        title: "确认工具调用",
        detail: calls.length > 0 ? calls.length + " 个工具调用已提交，准备执行。" : streamSentence(translated.detail),
      }];
    }
    return [...items, {
      ...base,
      key: feedKey(event, "reply"),
      kind: "reply",
      title: "回复已提交",
      detail: streamSentence(translated.detail),
    }];
  }
  if (FEED_TOOL_TYPES[event.type]) {
    const translated = translateRunEvent(event, planned);
    return [{
      ...base,
      key: feedKey(event, "tool"),
      kind: "tool",
      title: translated.title,
      detail: streamSentence(translated.detail || translated.title),
    }];
  }
  if (FEED_THINKING_TYPES[event.type]) {
    const translated = translateRunEvent(event, planned);
    return [{
      ...base,
      key: feedKey(event, "thinking"),
      kind: "thinking",
      title: translated.title,
      detail: streamSentence(translated.detail || translated.title),
    }];
  }
  return [];
}

function runningSuffix(phase: string): string {
  return phase.endsWith("中") ? phase : phase + "中";
}

function toolProgressView(toolName: string, argumentsValue: unknown): { readonly title: string; readonly detail: string } {
  const args = recordValue(argumentsValue);
  if (toolName === "visible_index_directory") {
    return {
      title: "正在梳理可见目录",
      detail: "先确认文件范围、类型分布和可引用证据，避免直接猜内容。",
    };
  }
  if (toolName === "visible_find_files") {
    return {
      title: "正在定位相关文件",
      detail: "按文件名或模式筛选候选文件，为后续读取缩小范围。",
    };
  }
  if (toolName === "visible_read_file" || toolName === "visible_read_files" || toolName === "computer_read_file") {
    return {
      title: "正在读取已确认的文件",
      detail: "读取源文件内容，用来支撑后续分析和结论。",
    };
  }
  if (toolName === "visible_search_text" || toolName === "computer_search_text") {
    return {
      title: "正在检索相关内容",
      detail: "在已授权范围内查找匹配内容，减少无依据的推断。",
    };
  }
  if (toolName === "computer_write_file") {
    return fileWriteProgressView(stringValue(args?.path) ?? projectedPreviewPath(args));
  }
  if (toolName === "computer_patch_file") {
    return {
      title: "正在更新文件",
      detail: "把当前步骤需要的修改写入已有文件。",
    };
  }
  if (toolName === "computer_run_command") {
    return commandProgressView(args);
  }
  if (toolName === "materialize_paginated_html") {
    return {
      title: "正在生成分页文档",
      detail: "按结构化页面规格生成可检查的 HTML 文件。",
    };
  }
  if (toolName === "convert_artifact") {
    return {
      title: "正在转换文件格式",
      detail: "把已生成的文件转换为目标格式，并保留转换证据。",
    };
  }
  if (toolName === "websearch") {
    return {
      title: "正在搜索资料",
      detail: "查询外部来源，准备可引用的信息。",
    };
  }
  if (toolName === "webfetch") {
    return {
      title: "正在读取网页资料",
      detail: "获取已选网页内容，用来支撑回答。",
    };
  }
  if (toolName === "load_skill") {
    return {
      title: "正在加载处理规则",
      detail: "读取本步骤需要遵循的专业处理流程。",
    };
  }
  return {
    title: "正在准备下一步操作",
    detail: "系统正在把当前步骤转换为可执行操作。",
  };
}

function fileWriteProgressView(path: string | undefined): { readonly title: string; readonly detail: string } {
  const extension = pathExtension(path);
  if (extension === "py" || extension === "js" || extension === "mjs" || extension === "ts") {
    return {
      title: "正在准备处理脚本",
      detail: "把可复验的处理逻辑写入工作区，下一步会运行它获取结果。",
    };
  }
  if (extension === "json" || extension === "csv" || extension === "tsv") {
    return {
      title: "正在保存结构化数据",
      detail: "把已整理的数据保存为中间证据，便于后续分析和检查。",
    };
  }
  if (extension === "md" || extension === "txt") {
    return {
      title: "正在保存分析材料",
      detail: "把阶段性结论或说明写成文件，供后续步骤引用。",
    };
  }
  if (extension === "html" || extension === "pdf" || extension === "pptx" || extension === "docx" || extension === "xlsx") {
    return {
      title: "正在生成交付文件",
      detail: "把当前内容写成可打开检查的文件。",
    };
  }
  return {
    title: "正在准备文件",
    detail: "把当前步骤需要的数据或结果写入工作区。",
  };
}

function commandProgressView(args: Record<string, unknown> | undefined): { readonly title: string; readonly detail: string } {
  const command = (stringValue(args?.command) ?? "").toLowerCase();
  const argList = Array.isArray(args?.args) ? args.args.map((item) => String(item).toLowerCase()) : [];
  const joined = [command, ...argList].join(" ");
  if (/\bpython\d?\b/u.test(command) || /\.py\b/u.test(joined)) {
    return {
      title: "正在运行数据处理脚本",
      detail: "用脚本读取源文件并生成可复验的统计或检查结果。",
    };
  }
  if (/\b(?:npm|pnpm|yarn|vitest|pytest|cargo|go)\b/u.test(joined)) {
    return {
      title: "正在运行验证命令",
      detail: "执行项目检查，确认当前结果是否可用。",
    };
  }
  return {
    title: "正在运行处理命令",
    detail: "执行当前步骤需要的本地命令，并记录输出证据。",
  };
}

function pathExtension(path: string | undefined): string {
  if (!path) return "";
  const base = path.split(/[\\/]/u).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function projectedPreviewPath(args: Record<string, unknown> | undefined): string | undefined {
  const preview = stringValue(args?.preview);
  if (preview === undefined) return undefined;
  const match = preview.match(/"path"\s*:\s*"([^"]+)"/u);
  return match?.[1];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function streamSentence(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (/[。！？.!?]$/u.test(text)) return text;
  return text + "。";
}

function feedKey(event: RunEvent, suffix: string): string {
  return String(event.seq ?? event.type) + ":" + suffix;
}

function reasoningFeedItem(event: RunEvent): readonly LiveFeedItem[] {
  const reasoningContent = typeof event.data?.reasoningContent === "string" ? event.data.reasoningContent.trim() : "";
  if (!reasoningContent) return [];
  return [{
    key: feedKey(event, "thinking"),
    kind: "thinking",
    title: "模型思考",
    detail: reasoningContent,
    rawType: event.type,
    ...(event.seq === undefined ? {} : { seq: event.seq }),
  }];
}

export function currentStep(plan: LivePlan | null): PlanStep | null {
  if (!plan) return null;
  const executableSteps = plan.steps.filter((s) => s.kind !== "milestone");
  return executableSteps.find((s) => s.status === "running")
    ?? executableSteps.find((s) => s.status === "pending")
    ?? null;
}

export function currentStepWhy(step: PlanStep | null): string {
  if (!step) return "还没有进入具体执行步骤。";
  const criteria = step.successCriteria ?? [];
  const firstCriterion = criteria[0]?.description;
  if (firstCriterion) return "为了满足：" + clip(firstCriterion, 96);
  if ((step.recommendedToolNames ?? []).length > 0) return "为了产出本步骤可评估的工具证据。";
  return "为了推进当前计划步骤的完成判断。";
}

export function stepToolPurposes(step: PlanStep | null): readonly string[] {
  if (!step) return [];
  return (step.recommendedToolNames ?? []).slice(0, 6).map((name) => toolPurpose(name));
}

export function executionInsights(events: readonly RunEvent[], limit = 7): readonly ExecutionInsight[] {
  const planned = plannedMap(events);
  const items: ExecutionInsight[] = [];
  for (const event of events) {
    const insight = insightForEvent(event, planned);
    if (insight) items.push(insight);
  }
  return items.slice(-limit);
}

export function latestTool(events: readonly RunEvent[]): RunEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === "tool.planned" ||
      e.type === "tool.completed" ||
      e.type === "tool.failed" ||
      e.type === "tool.rejected" ||
      e.type === "skill.activated"
    ) {
      return e;
    }
  }
  return null;
}

export function latestRetry(events: readonly RunEvent[]): RunEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "model.retry") return events[i];
  }
  return null;
}

export function retryText(events: readonly RunEvent[]): string {
  const r = latestRetry(events);
  if (!r) return "";
  const d = r.data ?? {};
  const status = d.status != null ? " · HTTP " + d.status : "";
  const next = (Number(d.attempt ?? 0)) + 1;
  const max = d.maxAttempts ?? 3;
  return "⚠ 模型请求失败" + String(status) + "，正在重试（" + next + "/" + max + "）…";
}

const IGNORED_PROGRESS_TYPES: Record<string, boolean> = {
  "assistant.streaming": true,
  "run.started": true,
  "skill.directory.resolved": true,
  "skill.package.verified": true,
  "action.created": true,
  "action.leased": true,
  "action.dispatched": true,
  "action.result_committed": true,
};

export function latestProgressEvent(events: readonly RunEvent[]): RunEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!IGNORED_PROGRESS_TYPES[events[i].type]) return events[i];
  }
  return null;
}

export function progressText(events: readonly RunEvent[], plan: LivePlan | null): string {
  const retry = latestRetry(events);
  if (retry) return eventLabel(retry);
  const event = latestProgressEvent(events);
  if (event) return eventLabel(event);
  if (plan && plan.steps.length) return "已生成执行计划，等待下一步。";
  return "已连接任务流，等待模型返回进度。";
}

const BOUNDARY_TYPES: Record<string, boolean> = {
  "assistant.streaming": true,
  "assistant.committed": true,
  "assistant.tool_call.committed": true,
  "tool.planned": true,
  "tool.effect_pending": true,
  "tool.completed": true,
  "tool.failed": true,
  "tool.rejected": true,
  "step.completed": true,
  "run.completed": true,
  "run.failed": true,
  "run.cancelled": true,
};

export function modelWaitText(events: readonly RunEvent[]): string {
  let assembled: RunEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "context.assembled") {
      assembled = events[i];
      break;
    }
  }
  if (!assembled || !assembled.createdAt) return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ((event.seq ?? 0) <= (assembled.seq ?? 0)) break;
    if (BOUNDARY_TYPES[event.type]) return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - assembled.createdAt) / 1000));
  return "等待模型返回 · 已等待 " + seconds + " 秒";
}

export function failureDetails(events: readonly RunEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "run.failed" && e.type !== "run.cancelled") continue;
    const d = e.data ?? {};
    const details = (d.details ?? {}) as Record<string, unknown>;
    const req = (details.request ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    if (req.phase) parts.push("阶段 " + phaseLabel(req.phase));
    if (req.protocol) parts.push("协议 " + String(req.protocol));
    if (details.status || d.status) parts.push("HTTP " + String(details.status || d.status));
    if (req.toolChoice) parts.push("工具选择 " + String(req.toolChoice));
    return parts.length ? parts.join(" · ") : "";
  }
  return "";
}

export function failureSummary(input: {
  readonly errorCode?: string;
  readonly status?: string;
  readonly events: readonly RunEvent[];
  readonly steps?: readonly PlanStep[];
  readonly artifactCount?: number;
}): FailureSummary {
  const errorCode = input.errorCode ?? latestFailureCode(input.events);
  const rawMessage = latestFailureMessage(input.events);
  const limit = latestEvent(input.events, "loop.limit_exceeded");
  const steps = (input.steps ?? livePlan(input.events)?.steps ?? []).filter((step) => step.kind !== "milestone");
  const total = steps.length;
  const completed = steps.filter((step) => step.status === "completed").length;
  const failed = steps.find((step) => step.status === "failed");
  const running = steps.find((step) => step.status === "running");
  const stoppedAt = failed ?? running ?? steps.find((step) => step.status === "pending") ?? null;
  const artifactCount = input.artifactCount ?? 0;

  const cancelled = input.status === "cancelled" || errorCode === "CANCELLED";
  const stalled = limit?.data?.stalled === true;
  const title = cancelled
    ? "任务已取消"
    : errorCode === "RUN_LIMIT_EXCEEDED"
      ? "这次没有生成最终结果"
      : "这次没有完成";
  const reason = cancelled
    ? "任务在完成前被取消，系统没有提交最终结果。"
    : errorCode === "RUN_LIMIT_EXCEEDED"
      ? stalled
        ? "处理过程中连续几次没有形成新的有效进展，所以本轮先停下了。"
        : "这次处理的内容比较长，任务在完成最终提交前先停下了。"
      : friendlyErrorReason(errorCode, rawMessage);
  const progress = total > 0
    ? progressSentence(completed, total, stoppedAt)
    : input.events.length > 0
      ? "本轮已经开始执行，但没有留下可提交的最终结果。"
      : "尚未加载本轮详细执行记录。";
  const nextAction = artifactCount > 0
    ? "下方已有本轮产生的文件，可以先查看；继续时可以直接让系统接着完成剩余内容。"
    : errorCode === "RUN_LIMIT_EXCEEDED"
      ? "可以直接继续处理，或把任务拆成先提取信息、再生成文件两步。"
      : "可以调整输入后重试；如果连续失败，请让维护者查看右侧运行记录。";
  return { title, reason, progress, nextAction, rawMessage };
}

function progressSentence(completed: number, total: number, stoppedAt: PlanStep | null): string {
  const current = stoppedAt === null ? "" : userFacingStepText(stoppedAt.objective || stoppedAt.id);
  if (completed <= 0 && current) return "已经开始处理，但还没有完成第一个阶段：" + current + "。";
  if (completed <= 0) return "已经开始处理，但还没有完成第一个阶段。";
  if (completed >= total) return "主要处理阶段已经走完，但最终结果还没有被提交。";
  if (current) return "已完成 " + completed + " 个阶段，还停留在：" + current + "。";
  return "已完成 " + completed + " 个阶段，还有后续内容没有处理完。";
}

function userFacingStepText(value: string): string {
  return clip(value, 90)
    .replace(/\bvisible\s*目录\b/giu, "已选择的目录")
    .replace(/\bvisible\s+director(?:y|ies)\b/giu, "已选择的目录")
    .replace(/\bPDF\s*Skill\b/giu, "PDF 处理流程")
    .replace(/\bSkill\b/gu, "处理流程")
    .replace(/通过脚本/g, "")
    .replace(/利用\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function latestFailureMessage(events: readonly RunEvent[]): string {
  const event = latestEvent(events, "run.failed") ?? latestEvent(events, "run.cancelled");
  return typeof event?.data?.message === "string" ? event.data.message : "";
}

function latestFailureCode(events: readonly RunEvent[]): string | undefined {
  const event = latestEvent(events, "run.failed") ?? latestEvent(events, "run.cancelled");
  return typeof event?.data?.code === "string" ? event.data.code : undefined;
}

function latestEvent(events: readonly RunEvent[], type: string): RunEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i];
  }
  return null;
}

function friendlyErrorReason(errorCode: string | undefined, rawMessage: string): string {
  if (errorCode === "PLANNING_ERROR" || errorCode === "PLAN_NOT_ADMITTED") return "系统没有得到可执行的规划，因此没有开始或继续执行。";
  if (errorCode === "ASSESSMENT_ERROR") return "结果评估阶段没有通过，系统没有把当前候选结果提交为最终完成。";
  if (errorCode === "MODEL_ERROR") return "模型请求或模型返回异常，导致本轮执行中断。";
  if (errorCode === "TOOL_EXECUTION_ERROR") return "工具执行过程中发生异常，导致本轮执行中断。";
  if (errorCode === "TOOL_POLICY_DENIED" || errorCode === "FORBIDDEN") return "当前权限不允许执行所需操作，任务已停止。";
  if (rawMessage) return rawMessage;
  return "任务在完成前中断，系统没有提交最终结果。";
}

const ACTIVITY_TYPES: Record<string, boolean> = {
  "planning.started": true,
  "planning.skills.selected": true,
  "planning.turn.started": true,
  "planning.turn.completed": true,
  "plan.proposed": true,
  "plan.admitted": true,
  "plan.step.started": true,
  "plan.step.completed": true,
  "plan.step.failed": true,
  "context.assembled": true,
  "context.compaction.started": true,
  "context.compacted": true,
  "context.tool_outputs_pruned": true,
  "context.tool_outputs_projected": true,
  "assistant.committed": true,
  "assistant.tool_call.committed": true,
  "tool.planned": true,
  "tool.effect_pending": true,
  "tool.completed": true,
  "tool.failed": true,
  "tool.rejected": true,
  "candidate.approved": true,
  "candidate.rejected": true,
  "assessment.turn.completed": true,
  "skill.activation.available": true,
  "skill.activated": true,
  "skill.compliance.assessed": true,
  "model.retry": true,
  "action.failed": true,
  "run.completed": true,
  "run.failed": true,
  "run.cancelled": true,
};

export function toolActivityItems(events: readonly RunEvent[]): readonly RunEvent[] {
  return events
    .filter((e) => ACTIVITY_TYPES[e.type])
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export function toolRowLabel(event: RunEvent, planned: Map<string, RunEvent>): string {
  const translated = translateRunEvent(event, planned);
  return translated.detail ? translated.title + " · " + translated.detail : translated.title;
}

export function stepText(step: PlanStep): string {
  return stepLabel(step.status);
}

export function plannedMap(events: readonly RunEvent[]): Map<string, RunEvent> {
  const planned = new Map<string, RunEvent>();
  for (const ev of events) {
    if (ev.type === "tool.planned" && ev.data?.toolCallId) planned.set(String(ev.data.toolCallId), ev);
  }
  return planned;
}

function insightForEvent(event: RunEvent, planned: Map<string, RunEvent>): ExecutionInsight | null {
  const d = event.data ?? {};
  const key = String(event.seq ?? event.type);
  const tone = eventTone(event.type) as ExecutionInsight["tone"];
  if (event.type === "planning.started") {
    return {
      key,
      title: "开始规划",
      detail: "读取可用能力和工具，先决定步骤、依赖和验收标准。"
        + countSuffix(d.availableSkillCount, "能力")
        + countSuffix(d.availableToolCount, "工具"),
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "planning.turn.started") {
    return {
      key,
      title: "规划回合 " + String(d.turn ?? "?"),
      detail: d.hasRuntimeDirective ? "根据上一次准入反馈重新拆分或修正规划。" : "生成首版结构化计划。",
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "planning.turn.completed") {
    return {
      key,
      title: "规划返回",
      detail: "返回 " + String(d.submitOutcomePlanCalls ?? d.submitOutcomePlanCallCount ?? 0) + " 个 submit_outcome_plan 调用"
        + (d.finishReason ? " · " + String(d.finishReason) : ""),
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "plan.admitted") {
    return {
      key,
      title: "计划已接纳",
      detail: clip(d.goal, 90) + (Array.isArray(d.steps) ? " · " + d.steps.length + " 个步骤" : ""),
      tone: "good",
      seq: event.seq,
    };
  }
  if (event.type === "plan.step.started") {
    return {
      key,
      title: "开始计划步骤",
      detail: "步骤 " + String(d.stepId ?? "?") + toolNamesSuffix(d.recommendedToolNames ?? d.toolNames),
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "context.assembled") {
    return {
      key,
      title: "整理模型上下文",
      detail: "把当前步骤、已完成工具结果和运行约束打包给模型"
        + (d.estimatedInputTokens ? " · 约 " + clip(d.estimatedInputTokens, 12) + " tokens" : ""),
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "context.tool_outputs_projected") {
    const count = Array.isArray(d.toolResults) ? d.toolResults.length : 0;
    return {
      key,
      title: "折叠大工具结果",
      detail: "保留预览、哈希和持久证据引用，避免把大结果完整塞回模型上下文"
        + (count ? " · " + count + " 项" : ""),
      tone: "warn",
      seq: event.seq,
    };
  }
  if (event.type === "assistant.tool_call.committed") {
    return { key, title: "模型决定调用工具", detail: toolAction(event), tone, seq: event.seq };
  }
  if (event.type === "tool.planned") {
    return {
      key,
      title: "工具已准备",
      detail: toolAction(event) + " · " + toolPurpose(String(d.toolName ?? d.name ?? "")),
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "tool.effect_pending") {
    return {
      key,
      title: "工具开始执行",
      detail: String(d.toolName ?? "工具") + (d.replaySafe === false ? " · 可能产生外部副作用" : " · 可安全重放"),
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "tool.completed") {
    const plannedEvent = event.data?.toolCallId ? planned.get(String(event.data.toolCallId)) : undefined;
    return {
      key,
      title: "工具完成",
      detail: plannedEvent ? toolAction(plannedEvent) + " · " + toolOutcome(event) : eventLabel(event),
      tone: "good",
      seq: event.seq,
    };
  }
  if (event.type === "tool.failed" || event.type === "tool.rejected") {
    return { key, title: event.type === "tool.failed" ? "工具失败" : "工具被拒绝", detail: eventLabel(event), tone: "bad", seq: event.seq };
  }
  if (event.type === "assistant.committed") {
    const finish = String(d.finishReason ?? "");
    return {
      key,
      title: finish === "tool_calls" ? "模型回合已提交" : "模型给出候选结果",
      detail: finish === "tool_calls"
        ? "工具调用已进入执行队列。"
        : clip(d.content, 110) || "等待评估当前步骤是否完成。",
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "candidate.approved") return { key, title: "候选结果通过", detail: "进入步骤完成提交。", tone: "good", seq: event.seq };
  if (event.type === "candidate.rejected") return { key, title: "候选结果被驳回", detail: clip(d.feedback ?? d.output, 120), tone: "bad", seq: event.seq };
  if (event.type === "assessment.turn.completed") {
    return {
      key,
      title: "完成质量评估",
      detail: "评估器检查步骤成功标准和 Skill 合规性。"
        + (d.finishReason ? " · " + String(d.finishReason) : ""),
      tone,
      seq: event.seq,
    };
  }
  if (event.type === "skill.compliance.assessed") {
    return {
      key,
      title: "步骤评估结果",
      detail: d.approved ? "本步骤满足成功标准。" : "本步骤未满足成功标准：" + clip(d.feedback, 90),
      tone: d.approved ? "good" : "bad",
      seq: event.seq,
    };
  }
  if (event.type === "model.retry") return { key, title: "模型请求重试", detail: retryText([event]), tone: "warn", seq: event.seq };
  if (event.type === "action.failed") return { key, title: "运行边界失败", detail: "Action " + clip(d.actionId, 12) + " · " + String(d.code ?? ""), tone: "bad", seq: event.seq };
  if (event.type === "run.completed") return { key, title: "任务完成", detail: "最终结果已通过 Runtime 终态提交。", tone: "good", seq: event.seq };
  if (event.type === "run.failed") return { key, title: "任务失败", detail: clip(d.message ?? d.error, 120), tone: "bad", seq: event.seq };
  if (event.type === "run.cancelled") return { key, title: "任务取消", detail: clip(d.message ?? "", 120) || "用户或系统取消了任务。", tone: "bad", seq: event.seq };
  if (ACTIVITY_TYPES[event.type]) return { key, title: eventLabel(event), detail: "", tone, seq: event.seq };
  return null;
}

function countSuffix(value: unknown, label: string): string {
  return typeof value === "number" ? " · " + value + " 个" + label : "";
}

function toolNamesSuffix(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? " · 推荐工具 " + value.slice(0, 4).join(", ") : "";
}

function toolPurpose(name: string): string {
  if (name === "load_skill") return "读取本步骤需要遵循的 Skill 规则";
  if (name === "computer_list_directory") return "确认输入文件或工作区结构";
  if (name === "computer_find_files") return "按文件名或模式低噪音定位候选文件";
  if (name === "computer_read_file") return "读取源文件或上一步产物";
  if (name === "computer_write_file") return "持久化中间证据或最终产物";
  if (name === "computer_run_command") return "执行可复验的数据处理、生成或检查命令";
  if (name === "computer_search_text") return "在工作区内定位相关文本";
  if (name === "computer_snapshot") return "获取当前界面证据";
  if (name === "computer_navigate") return "打开目标页面继续操作";
  return name || "执行本步骤所需工具";
}
