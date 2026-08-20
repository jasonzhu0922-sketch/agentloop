import type { RunEvent } from "./types";

export const NL = String.fromCharCode(10);

export function escapeHtml(value: unknown): string {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export function truncate(text: string | null | undefined, n: number): string {
  const t = String(text == null ? "" : text).split(NL).join(" ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + "…";
}

export function timeAgo(ts: number | undefined): string {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
  if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
  if (d < 604800000) return Math.floor(d / 86400000) + " 天前";
  return fmtDate(ts);
}

export function fmtTime(ts: number | undefined): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("zh-CN");
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

export function phaseLabel(phase: unknown): string {
  return (
    {
      planning: "规划中",
      execution: "执行中",
      assessment: "评估中",
      compaction: "压缩上下文",
    }[String(phase)] || "处理中"
  );
}

export function statusLabel(status: unknown): string {
  return { running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消" }[String(status)] ?? String(status);
}

export function stepLabel(status: unknown): string {
  return { pending: "待执行", running: "执行中", completed: "已完成", failed: "失败" }[String(status)] ?? String(status);
}

export function stepClass(status: unknown): string {
  if (status === "completed") return "done";
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "pending";
}

export function clip(text: unknown, n: number): string {
  const s = String(text == null ? "" : text).split(String.fromCharCode(10)).join(" ").trim();
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export function previewText(text: unknown): string {
  const t = String(text == null ? "" : text).trim();
  if (t.length <= 500) return t;
  return "…" + t.slice(t.length - 500);
}

export function parseResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function asArg(event: RunEvent): Record<string, unknown> {
  const a = event.data?.arguments;
  return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

export function toolAction(event: RunEvent): string {
  const d = event.data ?? {};
  const name = String(d.toolName ?? d.name ?? "");
  const a = asArg(event);
  if (name === "computer_write_file") {
    return "写入文件 " + String(a.path ?? "?") + (a.overwrite ? "（覆盖）" : "");
  }
  if (name === "computer_run_command") {
    const args = Array.isArray(a.args) ? a.args.map((item) => String(item)) : [];
    const displayArgs = args.includes("-c")
      ? args.map((item, index) => (item === "-c" && index + 1 < args.length ? "-c [inline script]" : item))
        .filter((item, index, source) => item !== "[inline script]" && source[index - 1] !== "-c [inline script]")
      : args;
    const cmd = String(a.command ?? "?") + " " + displayArgs.join(" ");
    return "运行命令 " + clip(cmd, 72);
  }
  if (name === "computer_list_directory") return "查看目录 " + String(a.path ?? ".");
  if (name === "computer_read_file") return "读取文件 " + String(a.path ?? "?");
  if (name === "computer_search_text") return "搜索「" + clip(a.query ?? "", 32) + "」于 " + String(a.path ?? ".");
  if (name === "load_skill") return "加载能力 " + String(a.name ?? "");
  if (name === "computer_snapshot") return "截取当前屏幕";
  if (name === "computer_navigate") return "打开网页 " + String(a.url ?? "");
  return name;
}

export function toolOutcome(event: RunEvent): string {
  const d = event.data ?? {};
  const name = String(d.toolName ?? d.name ?? "");
  const r = parseResult(d.result);
  if (name === "computer_write_file") {
    if (r && typeof r === "object" && "path" in r) {
      return "已写入 " + String((r as { path: string }).path) + ("bytes" in r ? "（" + String((r as { bytes: number }).bytes) + " 字节）" : "");
    }
  }
  if (name === "computer_run_command") {
    if (r && typeof r === "object" && "exitCode" in r) {
      const code = (r as { exitCode: number }).exitCode;
      return code === 0 ? "执行成功" : "退出码 " + code;
    }
  }
  if (name === "computer_list_directory") {
    if (Array.isArray(r)) return "共 " + r.length + " 项";
  }
  if (name === "computer_search_text") {
    if (Array.isArray(r)) return r.length + " 处匹配";
  }
  if (name === "load_skill") return "已加载";
  if (typeof r === "string" && r) return clip(r, 60);
  return "";
}

export function eventTone(type: string): string {
  if (type === "run.completed" || type === "candidate.approved" || type === "skill.compliance.assessed") return "good";
  if (type.indexOf("failed") >= 0 || type.indexOf("rejected") >= 0 || type === "run.cancelled") return "bad";
  if (
    type.indexOf("started") >= 0 ||
    type.indexOf("planned") >= 0 ||
    type.indexOf("proposed") >= 0 ||
    type === "assistant.streaming" ||
    type === "model.retry"
  ) {
    return "warn";
  }
  return "";
}

export function eventLabel(event: RunEvent): string {
  const d = event.data ?? {};
  const t = event.type;
  if (t === "assistant.streaming") {
    const c = d.content ?? "";
    return "正在生成" + (c ? "：" + clip(c, 80) : "") + " · " + phaseLabel(d.phase);
  }
  if (t === "assistant.committed") {
    const txt = d.content ?? "";
    return "回合提交" + (txt ? "：" + clip(txt, 120) : "") + (d.finishReason ? " · " + String(d.finishReason) : "");
  }
  if (t === "assistant.tool_call.committed") return "调用工具 · " + toolAction(event);
  if (t === "tool.planned") return "准备工具 · " + toolAction(event);
  if (t === "tool.effect_pending") return "执行中 · " + String(d.toolName ?? "");
  if (t === "tool.completed") {
    const o = toolOutcome(event);
    return "完成 · " + (o || String(d.toolName ?? ""));
  }
  if (t === "tool.failed") return "工具失败 · " + String(d.toolName ?? "") + "：" + clip(d.error, 80);
  if (t === "tool.rejected") return "工具被拒绝 · " + String(d.toolName ?? "") + "：" + clip(d.reason, 80);
  if (t === "skill.activation.available") return "可加载能力：" + (Array.isArray(d.skills) ? d.skills.length + " 项" : "");
  if (t === "skill.activated") return "已加载能力 " + String(d.name ?? "");
  if (t === "skill.compliance.assessed") return "合规评估 " + (d.approved ? "通过" : "未通过");
  if (t === "skill.package.verified") return "能力包已校验";
  if (t === "skill.directory.resolved") return "能力目录已解析";
  if (t === "plan.proposed") {
    return "计划已生成" + (d.goal ? "：" + clip(d.goal, 60) : "") + (d.stepCount ? "（" + d.stepCount + " 步）" : "");
  }
  if (t === "plan.admitted") {
    return "计划已接纳" + (d.goal ? "：" + clip(d.goal, 60) : "") + (Array.isArray(d.steps) ? "（" + d.steps.length + " 步）" : "");
  }
  if (t === "plan.step.started") return "开始步骤 " + String(d.stepId ?? "");
  if (t === "plan.step.completed") return "完成步骤 " + String(d.stepId ?? "");
  if (t === "step.started") return "第 " + String(d.step ?? "?") + " 回合 · " + phaseLabel(d.phase);
  if (t === "step.completed") return "第 " + String(d.step ?? "?") + " 回合完成";
  if (t === "loop.convergence_requested") return "预算用尽，开始收敛（第 " + String(d.step ?? "?") + " 回合）";
  if (t === "loop.limit_exceeded") return "达到步数上限" + (d.stalled ? "（无进展）" : "");
  if (t === "loop.no_progress") return "检测到重复调用，提前停止";
  if (t === "context.assembled") return "上下文已整理（约 " + clip(d.estimatedInputTokens, 12) + " tokens）";
  if (t === "context.compacted") return "上下文已压缩";
  if (t === "context.tool_outputs_projected") return "大工具结果已折叠为预览（" + clip(Array.isArray(d.toolResults) ? d.toolResults.length : 0, 12) + " 项）";
  if (t === "context.tool_outputs_pruned") return "旧工具结果已从模型上下文裁剪";
  if (t === "candidate.approved") return "候选已通过";
  if (t === "candidate.rejected") return "候选被驳回：" + clip(d.feedback ?? d.output, 80);
  if (t === "assessment.turn.completed") return "评估完成";
  if (t === "run.started") return "任务已开始";
  if (t === "run.completed") return "任务已完成";
  if (t === "run.failed") return "任务失败：" + clip(d.message ?? d.error, 80);
  if (t === "run.cancelled") return "任务已取消";
  if (t === "model.retry") {
    const status = d.status != null ? " · HTTP " + d.status : "";
    const next = Number(d.attempt ?? 0) + 1;
    const max = d.maxAttempts ?? 3;
    return "模型请求失败" + String(status) + "，正在重试（" + next + "/" + max + "）…";
  }
  if (t === "model.stream.start" || t === "model.stream.delta" || t === "model.stream.end") return "模型流";
  return t;
}
