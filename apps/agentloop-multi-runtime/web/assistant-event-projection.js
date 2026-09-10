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
  applyPlanStepEvent(assistant, event);
  if (event.type === "run.completed") {
    if (typeof data.output === "string") assistant.text = data.output;
    assistant.status = "completed";
    assistant.reasoning = "";
  }
  if (event.type === "run.failed") {
    assistant.status = "failed";
    assistant.error = failureMessage(data);
    assistant.text = assistant.error;
    assistant.reasoning = "";
  }
  if (event.type === "run.cancelled") {
    assistant.status = "cancelled";
    assistant.reasoning = "";
  }
  return TERMINAL_EVENT_TYPES.has(event.type);
}

function failureMessage(data) {
  const message = typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : "";
  if (data.code === "RUN_LIMIT_EXCEEDED") {
    return message ? `执行轮次已耗尽：${message}` : "执行轮次已耗尽，任务未能在预算内完成。";
  }
  if (message) return message;
  return typeof data.code === "string" ? `Run 失败：${data.code}` : "Run 失败";
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
