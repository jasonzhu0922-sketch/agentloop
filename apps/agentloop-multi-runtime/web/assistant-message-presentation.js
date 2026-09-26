const PRESENTATIONS = {
  running: { isLive: true, label: "执行中", icon: "", cardClass: "", emptyText: "" },
  completed: { isLive: false, label: "已完成", icon: "✓", cardClass: "completed", emptyText: "任务已完成，未返回文本内容。" },
  failed: { isLive: false, label: "结果说明", icon: "i", cardClass: "failed", emptyText: "本次未能形成可提交的最终结果。" },
  cancelled: { isLive: false, label: "已取消", icon: "×", cardClass: "cancelled", emptyText: "任务已取消" },
};

/** Keep terminal Run states from falling back to live progress affordances. */
export function assistantMessagePresentation(status) {
  if (typeof status === "string" && PRESENTATIONS[status]) return PRESENTATIONS[status];
  return { isLive: false, label: typeof status === "string" ? status : "", icon: "", cardClass: "", emptyText: "暂无返回内容。" };
}

/** A completed artifact delivery is a user-visible result even without prose. */
export function completedArtifactSummary(artifacts) {
  const names = [...new Set((Array.isArray(artifacts) ? artifacts : [])
    .filter((artifact) => artifact?.role === "final")
    .map((artifact) => typeof artifact.name === "string" && artifact.name.length > 0 ? artifact.name : artifact.path)
    .filter((name) => typeof name === "string" && name.length > 0))];
  if (names.length === 0) return "";
  return `任务已完成，最终产物：${names.join("、")}。`;
}

/** A cancelled Run cannot leave an unfinished Plan step looking active. */
export function terminalAwarePlanStepStatus(stepStatus, runStatus) {
  if (runStatus === "cancelled" && stepStatus !== "completed" && stepStatus !== "failed") return "cancelled";
  return stepStatus;
}
