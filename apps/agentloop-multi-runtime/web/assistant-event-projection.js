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
    // Runtime output is an internal failure report, not a user-facing answer.
    // Keep any explicitly projected partial result separate so the terminal
    // status cannot overwrite useful progress with backend diagnostics.
    if (typeof data.partialOutput === "string" && data.partialOutput.trim()) {
      assistant.partialText = data.partialOutput;
    }
    assistant.text = "";
  }
  if (event.type === "run.cancelled") {
    assistant.status = "cancelled";
  }
  if (TERMINAL_EVENT_TYPES.has(event.type)) {
    assistant.reasoning = "";
    assistant.recovery = undefined;
    assistant.humanLoop = undefined;
  }
  return TERMINAL_EVENT_TYPES.has(event.type);
}

function failureMessage(data) {
  switch (data.code) {
    case "RUN_LIMIT_EXCEEDED":
      return "本次处理时间较长，暂未形成最终结果；以下说明可供参考。";
    case "STEP_NOT_COMPLETED":
      return "本次结果尚未完成最终确认，以下说明可供参考。";
    case "ASSESSMENT_ERROR":
      return "系统正在核对结果，暂未形成最终结论；以下说明可供参考。";
    case "MODEL_ERROR":
      return "本次处理暂时未能完成，以下说明可供参考。";
    case "TOOL_EXECUTION_ERROR":
      return "部分处理未能继续完成，以下说明可供参考。";
    case "TOOL_POLICY_DENIED":
    case "FORBIDDEN":
      return "当前内容需要更多权限才能继续处理，以下说明可供参考。";
    case "CANCELLED":
      return "这次处理已停止，系统没有提交最终结果。";
    default:
      return "本次未能形成可提交的最终结果，以下说明可供参考。";
  }
}

export function mergeRuntimeEvents(currentEvents, incomingEvents, limit = MAX_PERSISTED_EVENTS) {
  const eventsBySequence = new Map();
  for (const event of [...(Array.isArray(currentEvents) ? currentEvents : []), ...(Array.isArray(incomingEvents) ? incomingEvents : [])]) {
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
