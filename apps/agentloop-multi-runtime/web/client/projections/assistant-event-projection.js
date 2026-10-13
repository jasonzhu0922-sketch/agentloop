const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const PLAN_STEP_STATUS_BY_EVENT_TYPE = {
  "plan.step.started": "running",
  "plan.step.completed": "completed",
  "plan.step.failed": "failed",
};
const MAX_PERSISTED_EVENTS = 160;
const MAX_PERSISTED_EVENT_TEXT = 8_000;

/**
 * Apply a Host event to the browser's persisted assistant-message projection.
 * The Router is deliberately the source of replayed events: terminal status
 * alone does not describe the state of each durable Plan step.
 */
export function projectAssistantEvent(assistant, event) {
  if (!assistant || !event || typeof event.type !== "string") return false;
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const progress = liveProgressForEvent(event);
  if (progress !== undefined) assistant.progress = progress;
  if (event.type === "assistant.streaming" || event.type === "assistant.committed") {
    if (typeof data.content === "string") assistant.text = data.content;
  }
  const reasoning = typeof data.reasoningContent === "string" ? data.reasoningContent : typeof data.reasoning === "string" ? data.reasoning : "";
  if (reasoning.trim()) assistant.reasoning = reasoning;
  if (event.type === "plan.proposed" || event.type === "plan.admitted") {
    if (Array.isArray(data.steps)) assistant.plan = data.steps;
  }
  // `run.waiting_user` carries the durable request snapshot.  Do not depend on
  // a second asynchronous read before exposing a user action: that read is a
  // reconciliation path after reconnect, not the only display path.
  if (event.type === "run.waiting_user" && data.request?.status === "open") {
    assistant.humanLoop = data.request;
  }
  if (event.type === "human_loop.answered") {
    const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
    if (requestId === undefined || assistant.humanLoop?.id === requestId) assistant.humanLoop = undefined;
  }
  if ((event.type === "plan.step.started" || event.type === "plan.step.completed") && assistant.humanLoop !== undefined) {
    const stepId = typeof data.stepId === "string" ? data.stepId : undefined;
    if (stepId === undefined || assistant.humanLoop.stepId === stepId) assistant.humanLoop = undefined;
  }
  if (event.type === "run.recovery_required") {
    assistant.recovery = {
      status: "required",
      ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
      ...(typeof data.actionId === "string" ? { actionId: data.actionId } : {}),
      ...(data.failedBoundary && typeof data.failedBoundary === "object" ? { failedBoundary: data.failedBoundary } : {}),
    };
  }
  if (event.type === "run.checkpoint_created" && typeof data.checkpointId === "string") {
    assistant.checkpoint = {
      id: data.checkpointId,
      reason: typeof data.reason === "string" ? data.reason : "execution_authority_lost",
      status: "available",
    };
  }
  applyPlanStepEvent(assistant, event);
  if (event.type === "run.completed") {
    if (typeof data.output === "string") assistant.text = data.output;
    assistant.status = "completed";
    assistant.error = undefined;
  }
  if (event.type === "run.failed") {
    assistant.status = "failed";
    assistant.error = failureMessage(data);
    // A terminal failure report is authored by the Runtime's final reporting
    // turn and persisted by TerminalCommitter. Keep it separate from a
    // successful answer, but project it instead of replacing it with only a
    // generic failure card.
    assistant.partialText = terminalFailureReport(data);
    assistant.text = "";
  }
  if (event.type === "run.cancelled") {
    assistant.status = "cancelled";
  }
  if (TERMINAL_EVENT_TYPES.has(event.type)) {
    assistant.reasoning = "";
    assistant.progress = undefined;
    assistant.recovery = undefined;
    assistant.humanLoop = undefined;
  }
  return TERMINAL_EVENT_TYPES.has(event.type);
}

/**
 * A concise browser projection of a durable Runtime event.  This is display
 * state only: no timer, transport heartbeat, or inferred completion is turned
 * into a Run fact.  It keeps a long provider request intelligible even before
 * the model has produced visible text or a tool call.
 */
export function liveProgressForEvent(event) {
  if (!event || typeof event.type !== "string") return undefined;
  const data = event.data && typeof event.data === "object" ? event.data : {};
  if (event.type === "model.request.started") {
    if (data.purpose === "conversation_turn_resolver") return "正在理解本轮需求";
    if (data.phase === "planning") return "正在制定执行计划";
    if (data.phase === "assessment") return "正在核验当前结果";
    return "正在执行当前步骤";
  }
  if (event.type === "planning.started") return "正在生成执行计划";
  if (event.type === "plan.admitted") return "执行计划已确认，准备开始处理";
  if (event.type === "plan.step.started") return "正在执行当前步骤";
  if (event.type === "tool.dispatched") {
    const toolName = typeof data.toolName === "string" && data.toolName.trim() ? data.toolName.trim() : "工具";
    return `正在调用 ${toolName}`;
  }
  if (event.type === "tool.completed") return "工具已返回结果，正在继续处理";
  if (event.type === "assistant.streaming" || event.type === "assistant.committed") return "正在整理当前步骤的结果";
  if (event.type === "loop.convergence_requested") {
    return data.reason === "current_step_evidence_complete"
      ? "当前证据已齐备，正在生成最终结果"
      : "正在收敛当前步骤并生成可提交结果";
  }
  if (event.type === "loop.convergence_reopened") return "检测到仍需工具处理，已继续执行";
  if (event.type === "candidate.rejected") return "当前结果尚未通过核验，正在修正";
  if (event.type === "candidate.approved") return "当前结果已通过核验，正在提交";
  if (event.type === "run.waiting_user") return "等待你的确认或补充信息";
  return undefined;
}

function failureMessage(data) {
  switch (data.code) {
    case "RUN_LIMIT_EXCEEDED":
      return terminalFailureReport(data)
        ? "本轮达到可用轮次上限；以下为已持久化的执行总结，尚非成功交付。"
        : "本轮达到可用轮次上限，尚未形成最终结果。";
    case "STEP_NOT_COMPLETED":
      return "本次结果未通过最终验收。";
    case "ASSESSMENT_ERROR":
      return "本次结果仍未通过验收确认。";
    case "MODEL_ERROR":
      return "本次处理暂时未能完成。";
    case "TOOL_EXECUTION_ERROR":
      return "处理未能继续完成。";
    case "TOOL_POLICY_DENIED":
    case "FORBIDDEN":
      return "当前内容需要更多权限才能继续处理。";
    case "CANCELLED":
      return "这次处理已停止，系统没有提交最终结果。";
    default:
      return "本次未能形成可提交的最终结果。";
  }
}

function terminalFailureReport(data) {
  if (typeof data?.output === "string" && data.output.trim()) return data.output;
  if (typeof data?.partialOutput === "string" && data.partialOutput.trim()) return data.partialOutput;
  return undefined;
}

export function mergeRuntimeEvents(currentEvents, incomingEvents, limit = MAX_PERSISTED_EVENTS) {
  const eventsBySequence = new Map();
  // `currentEvents` is this module's already-compacted browser cache.  On the
  // SSE hot path, recompacting it once for every new event turns a bounded
  // history into repeated deep copies.  Only newly received durable events
  // need compaction; a cold cache always enters as `incomingEvents`.
  for (const event of Array.isArray(currentEvents) ? currentEvents : []) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) continue;
    eventsBySequence.set(event.seq, event);
  }
  for (const event of Array.isArray(incomingEvents) ? incomingEvents : []) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) continue;
    eventsBySequence.set(event.seq, compactRuntimeEvent(event));
  }
  return [...eventsBySequence.values()].sort((left, right) => left.seq - right.seq).slice(-limit);
}

/** The Host retains full evidence; localStorage only needs bounded UI detail. */
function compactRuntimeEvent(event) {
  return { ...event, data: compactEventData(event.data) };
}

function compactEventData(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return compactValue(data);
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, key === "result" && typeof value === "string" ? compactResult(value) : compactValue(value)]));
}

function compactResult(value) {
  try {
    return JSON.stringify(compactValue(JSON.parse(value)));
  } catch {
    return compactText(value);
  }
}

function compactValue(value) {
  if (typeof value === "string") return compactText(value);
  if (Array.isArray(value)) return value.map(compactValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item)]));
  return value;
}

function compactText(value) {
  if (value.length <= MAX_PERSISTED_EVENT_TEXT) return value;
  return `${value.slice(0, MAX_PERSISTED_EVENT_TEXT)}\n…[浏览器事件缓存已截断；完整证据保留在 Host]`;
}

export function replayAssistantEvents(assistant, events) {
  let terminal = false;
  for (const event of Array.isArray(events) ? events : []) {
    terminal = projectAssistantEvent(assistant, event) || terminal;
  }
  assistant.events = mergeRuntimeEvents(assistant.events, events);
  return terminal;
}

export function hasIncompleteCompletedPlan(assistant) {
  return assistant?.status === "completed"
    && Array.isArray(assistant.plan)
    && assistant.plan.some((step) => step?.status !== "completed");
}

function applyPlanStepEvent(assistant, event) {
  const stepId = typeof event.data?.stepId === "string" ? event.data.stepId : undefined;
  const status = PLAN_STEP_STATUS_BY_EVENT_TYPE[event.type];
  if (!stepId || !status || !Array.isArray(assistant.plan)) return;
  assistant.plan = assistant.plan.map((step) => step?.id === stepId ? { ...step, status } : step);
}
