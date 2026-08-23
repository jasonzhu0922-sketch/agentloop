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

export interface FailureSummary {
  readonly title: string;
  readonly reason: string;
  readonly progress: string;
  readonly nextAction: string;
  readonly rawMessage: string;
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
  const calls = stream?.data && Array.isArray(stream.data.toolCalls) ? (stream.data.toolCalls as Array<{ name?: string; arguments?: string }>) : [];
  if (!calls.length) return "";
  const call = calls[calls.length - 1] ?? {};
  const name = call.name ?? "工具";
  const chars = typeof call.arguments === "string" ? call.arguments.length : 0;
  return "正在生成工具调用：" + name + (chars ? " · 参数 " + chars + " 字符" : "");
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
  if ((step.requiredToolNames ?? []).length > 0) return "为了产出本步骤可评估的工具证据。";
  return "为了推进当前计划步骤的完成判断。";
}

export function stepToolPurposes(step: PlanStep | null): readonly string[] {
  if (!step) return [];
  return (step.requiredToolNames ?? []).slice(0, 6).map((name) => toolPurpose(name));
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
  const limitText = limit
    ? "已执行到系统设置的步数上限"
      + (typeof limit.data?.hardLimit === "number" ? "（" + limit.data.hardLimit + " 步）" : "")
      + "，为避免继续无效消耗，任务被停止。"
    : "";
  const title = cancelled
    ? "任务已取消"
    : errorCode === "RUN_LIMIT_EXCEEDED"
      ? "任务已停止，当前结果未完成"
      : "任务未完成，但已有过程信息可查看";
  const reason = cancelled
    ? "任务在完成前被取消，系统没有提交最终结果。"
    : errorCode === "RUN_LIMIT_EXCEEDED"
      ? stalled
        ? "系统检测到连续步骤没有形成新的有效进展，因此停止本轮执行。"
        : limitText || "执行超过系统允许的步数上限，因此没有进入最终提交。"
      : friendlyErrorReason(errorCode, rawMessage);
  const progress = total > 0
    ? "已完成 " + completed + "/" + total + " 个规划步骤"
      + (stoppedAt ? "，停在：" + clip(stoppedAt.objective || stoppedAt.id, 90) : "。")
    : input.events.length > 0
      ? "已记录 " + input.events.length + " 条执行事件，可在时间线中查看过程。"
      : "尚未加载本轮详细执行记录。";
  const nextAction = artifactCount > 0
    ? "可以先预览下方已生成的过程产物；如需继续，建议基于这些产物发起一次更小范围的后续任务。"
    : errorCode === "RUN_LIMIT_EXCEEDED"
      ? "建议缩小任务范围，或让系统先只完成读取、提取、生成报告中的一个阶段。"
      : "建议查看技术细节后重试；如果问题重复出现，需要检查模型、工具权限或输入文件。";
  return { title, reason, progress, nextAction, rawMessage };
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
