import { clip, eventTone, phaseLabel, toolAction, toolOutcome } from "./format";
import type { RunEvent } from "./types";

export interface EventTranslation {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly rawType: string;
  readonly tone: "" | "good" | "warn" | "bad";
  readonly seq?: number;
}

export function translateRunEvent(
  event: RunEvent,
  planned: ReadonlyMap<string, RunEvent> = new Map(),
): EventTranslation {
  const d = event.data ?? {};
  const key = String(event.seq ?? event.type);
  const base = {
    key,
    rawType: event.type,
    tone: eventTone(event.type) as EventTranslation["tone"],
    seq: event.seq,
  };

  if (event.type === "planning.started") {
    return {
      ...base,
      title: "开始规划任务",
      detail: "读取可用能力和工具，先拆分步骤、依赖和验收标准。"
        + countSuffix(d.availableSkillCount, "能力")
        + countSuffix(d.availableToolCount, "工具"),
    };
  }
  if (event.type === "planning.skills.selected") {
    return {
      ...base,
      title: "选择可用能力",
      detail: Array.isArray(d.skillIds) && d.skillIds.length > 0
        ? "本轮将优先使用 " + d.skillIds.slice(0, 4).join("、")
        : "根据任务目标筛选可用 Skill。",
    };
  }
  if (event.type === "planning.turn.started") {
    return {
      ...base,
      title: "生成规划草案",
      detail: "第 " + String(d.turn ?? "?") + " 轮规划"
        + (d.hasRuntimeDirective ? "，正在按准入反馈修正。" : "，正在形成首版结构化计划。"),
    };
  }
  if (event.type === "planning.turn.completed") {
    return {
      ...base,
      title: "收到规划回复",
      detail: "模型返回 " + String(d.submitPlanCallCount ?? 0) + " 个规划提交"
        + (d.finishReason ? " · " + String(d.finishReason) : ""),
    };
  }
  if (event.type === "plan.proposed") {
    return {
      ...base,
      title: "形成执行计划",
      detail: (d.goal ? clip(d.goal, 90) : "已生成可检查的计划草案。")
        + (d.stepCount ? " · " + String(d.stepCount) + " 个步骤" : ""),
    };
  }
  if (event.type === "plan.admitted") {
    return {
      ...base,
      tone: "good",
      title: "计划已通过准入",
      detail: (d.goal ? clip(d.goal, 90) : "计划结构、工具权限和步骤依赖已通过检查。")
        + (Array.isArray(d.steps) ? " · " + d.steps.length + " 个步骤" : ""),
    };
  }
  if (event.type === "plan.step.started") {
    return {
      ...base,
      title: "开始执行计划步骤",
      detail: stepName(d.stepObjective ?? d.objective ?? d.stepId) + toolNamesSuffix(d.recommendedToolNames ?? d.toolNames),
    };
  }
  if (event.type === "plan.step.completed") {
    return { ...base, tone: "good", title: "完成计划步骤", detail: stepName(d.output ?? d.stepObjective ?? d.objective ?? d.stepId) };
  }
  if (event.type === "plan.step.failed") {
    return { ...base, tone: "bad", title: "计划步骤未完成", detail: stepName(d.message ?? d.error ?? d.stepId) };
  }
  if (event.type === "context.assembled") {
    return {
      ...base,
      title: "整理上下文",
      detail: "把当前步骤、已有证据和运行约束交给模型"
        + (d.estimatedInputTokens ? " · 约 " + clip(d.estimatedInputTokens, 12) + " tokens" : ""),
    };
  }
  if (event.type === "context.compaction.started") {
    return { ...base, title: "压缩上下文", detail: "运行记录较长，正在整理为更短的模型输入。" };
  }
  if (event.type === "context.compacted") {
    return { ...base, title: "上下文已压缩", detail: "保留关键事实、证据引用和下一步状态。" };
  }
  if (event.type === "context.tool_outputs_projected") {
    const count = Array.isArray(d.toolResults) ? d.toolResults.length : 0;
    return { ...base, title: "折叠大工具结果", detail: "保留预览和证据引用，避免大段输出挤占上下文" + (count ? " · " + count + " 项" : "") };
  }
  if (event.type === "context.tool_outputs_pruned") {
    return { ...base, title: "裁剪旧工具输出", detail: "旧输出已从模型输入中移除，持久证据仍保留在运行记录中。" };
  }
  if (event.type === "assistant.streaming") {
    return { ...base, title: "收到实时草稿", detail: (d.content ? clip(d.content, 120) + " · " : "") + phaseLabel(d.phase) };
  }
  if (event.type === "assistant.committed") {
    const finish = String(d.finishReason ?? "");
    return {
      ...base,
      title: finish === "tool_calls" ? "模型决定调用工具" : "模型提交候选结果",
      detail: finish === "tool_calls" ? "工具调用已进入执行队列。" : clip(d.content, 140) || "等待评估当前结果。",
    };
  }
  if (event.type === "assistant.tool_call.committed") {
    return { ...base, title: "提交工具调用", detail: toolAction(event) };
  }
  if (event.type === "tool.planned") {
    return { ...base, title: "准备工具", detail: toolAction(event) + " · " + toolPurpose(String(d.toolName ?? d.name ?? "")) };
  }
  if (event.type === "tool.effect_pending") {
    return {
      ...base,
      title: "工具开始执行",
      detail: String(d.toolName ?? "工具") + (d.replaySafe === false ? " · 可能产生外部副作用" : " · 可安全重放"),
    };
  }
  if (event.type === "tool.completed") {
    const plannedEvent = d.toolCallId ? planned.get(String(d.toolCallId)) : undefined;
    return {
      ...base,
      tone: "good",
      title: "工具完成",
      detail: plannedEvent ? toolAction(plannedEvent) + outcomeSuffix(event) : (toolOutcome(event) || String(d.toolName ?? "工具")),
    };
  }
  if (event.type === "tool.failed") {
    return { ...base, tone: "bad", title: "工具失败", detail: String(d.toolName ?? "工具") + "：" + clip(d.error, 100) };
  }
  if (event.type === "tool.rejected") {
    return { ...base, tone: "bad", title: "工具被拒绝", detail: String(d.toolName ?? "工具") + "：" + clip(d.reason, 100) };
  }
  if (event.type === "skill.activation.available") {
    return { ...base, title: "发现可加载能力", detail: Array.isArray(d.skills) ? d.skills.length + " 项 Skill 可供本轮选择。" : "已读取 Skill 可用性。" };
  }
  if (event.type === "skill.activated") {
    return { ...base, title: "能力已加载", detail: String(d.name ?? d.skillId ?? "Skill") };
  }
  if (event.type === "skill.compliance.assessed") {
    return {
      ...base,
      tone: d.approved ? "good" : "bad",
      title: d.approved ? "步骤评估通过" : "步骤评估未通过",
      detail: d.approved ? "当前结果满足成功标准。" : clip(d.feedback, 120),
    };
  }
  if (event.type === "candidate.approved") {
    return { ...base, tone: "good", title: "候选结果通过", detail: "可以提交为本步骤结果。" };
  }
  if (event.type === "candidate.rejected") {
    return { ...base, tone: "bad", title: "候选结果被驳回", detail: clip(d.feedback ?? d.output, 140) };
  }
  if (event.type === "assessment.turn.completed") {
    return { ...base, title: "完成质量评估", detail: "检查步骤成功标准和 Skill 合规性" + (d.finishReason ? " · " + String(d.finishReason) : "") };
  }
  if (event.type === "model.retry") {
    const status = d.status != null ? " · HTTP " + d.status : "";
    const next = Number(d.attempt ?? 0) + 1;
    const max = d.maxAttempts ?? 3;
    return { ...base, tone: "warn", title: "模型请求重试", detail: "模型请求失败" + String(status) + "，正在重试（" + next + "/" + max + "）。" };
  }
  if (event.type === "action.failed") {
    return { ...base, tone: "bad", title: "运行边界失败", detail: "Action " + clip(d.actionId, 16) + " · " + String(d.code ?? "") };
  }
  if (event.type === "run.started") {
    return { ...base, title: "任务已开始", detail: "后端已创建运行记录并开始处理。" };
  }
  if (event.type === "run.completed") {
    return { ...base, tone: "good", title: "任务完成", detail: "最终结果已通过终态提交。" };
  }
  if (event.type === "run.failed") {
    return { ...base, tone: "bad", title: "任务失败", detail: clip(d.message ?? d.error, 140) || "本轮没有提交最终结果。" };
  }
  if (event.type === "run.cancelled") {
    return { ...base, tone: "bad", title: "任务已取消", detail: clip(d.message, 140) || "用户或系统取消了任务。" };
  }

  return { ...base, title: fallbackTitle(event.type), detail: "" };
}

export function translatedTimeline(
  events: readonly RunEvent[],
  limit = 6,
): readonly EventTranslation[] {
  const planned = plannedEventMap(events);
  return events
    .filter((event) => VISIBLE_EVENT_TYPES[event.type])
    .map((event) => translateRunEvent(event, planned))
    .slice(-limit);
}

export function plannedEventMap(events: readonly RunEvent[]): Map<string, RunEvent> {
  const planned = new Map<string, RunEvent>();
  for (const event of events) {
    if (event.type === "tool.planned" && event.data?.toolCallId) planned.set(String(event.data.toolCallId), event);
  }
  return planned;
}

const VISIBLE_EVENT_TYPES: Record<string, boolean> = {
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

function countSuffix(value: unknown, label: string): string {
  return typeof value === "number" ? " · " + value + " 个" + label : "";
}

function toolNamesSuffix(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? " · 推荐工具 " + value.slice(0, 4).join("、") : "";
}

function stepName(value: unknown): string {
  return clip(value, 140) || "当前步骤";
}

function outcomeSuffix(event: RunEvent): string {
  const outcome = toolOutcome(event);
  return outcome ? " · " + outcome : "";
}

function fallbackTitle(type: string): string {
  return type
    .split(".")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function toolPurpose(name: string): string {
  if (name === "load_skill") return "读取本步骤需要遵循的 Skill 规则";
  if (name === "computer_list_directory") return "确认输入文件或工作区结构";
  if (name === "computer_find_files") return "按文件名或模式定位候选文件";
  if (name === "computer_read_file") return "读取源文件或上一步产物";
  if (name === "computer_write_file") return "持久化中间证据或最终产物";
  if (name === "computer_run_command") return "执行可复验的数据处理、生成或检查命令";
  if (name === "computer_search_text") return "在工作区内定位相关文本";
  if (name === "computer_snapshot") return "获取当前界面证据";
  if (name === "computer_navigate") return "打开目标页面继续操作";
  return name || "执行本步骤所需工具";
}
