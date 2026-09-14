const TOOL_EVENT_TYPES = new Set([
  "tool.planned",
  "assistant.tool_call.committed",
  "tool.dispatched",
  "tool.completed",
  "tool.failed",
  "tool.rejected",
]);

export function executionActivities(events, commandEvidence = {}) {
  const tools = new Map();
  const commands = new Map();
  const skills = new Map();
  const skillNameByToolCallId = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const data = recordValue(event?.data) || {};
    if (event.type === "planning.skills.selected" && Array.isArray(data.skills)) {
      for (const item of data.skills) {
        const skill = recordValue(item);
        const name = stringValue(skill?.id) || stringValue(skill?.name);
        if (name) upsertSkill(skills, name, "selected", event.seq || 0);
      }
    }
    if (event.type === "plan.step.started") {
      for (const skillId of Array.isArray(data.skillIds) ? data.skillIds : []) {
        const name = stringValue(skillId);
        if (name) upsertSkill(skills, name, "bound", event.seq || 0);
      }
    }
    const toolCallId = stringValue(data.toolCallId);
    const toolName = stringValue(data.toolName) || stringValue(data.name);
    if (!toolCallId || !toolName) continue;
    if (TOOL_EVENT_TYPES.has(event.type)) {
      const current = tools.get(toolCallId) || { id: toolCallId, name: toolName, status: "queued", seq: event.seq || 0 };
      current.name = toolName;
      current.seq = Math.max(current.seq, event.seq || 0);
      current.status = toolStatus(event.type, current.status);
      tools.set(toolCallId, current);
    }
    const args = recordValue(data.arguments);
    if (toolName === "load_skill") {
      const argumentName = stringValue(args?.name);
      if (argumentName) skillNameByToolCallId.set(toolCallId, argumentName);
      const skillName = argumentName || skillNameByToolCallId.get(toolCallId);
      const previous = skillName ? skills.get(skillName) : undefined;
      if (skillName) {
        upsertSkill(skills, skillName, toolStatus(event.type, previous?.status || "queued"), event.seq || 0, toolCallId);
      }
    }
    if (toolName !== "computer_run_command") continue;
    const current = commands.get(toolCallId) || { id: toolCallId, arguments: {}, status: "queued", seq: event.seq || 0 };
    current.seq = Math.max(current.seq, event.seq || 0);
    if (event.type === "tool.planned" || event.type === "assistant.tool_call.committed") current.submittedAt = current.submittedAt ?? event.createdAt;
    if (event.type === "tool.dispatched") current.dispatchedAt = event.createdAt;
    if (["tool.completed", "tool.failed", "tool.rejected"].includes(event.type)) {
      current.completedAt = event.createdAt;
      const startedAt = current.dispatchedAt ?? current.submittedAt;
      current.durationMs = typeof startedAt === "number" && typeof current.completedAt === "number" ? Math.max(0, current.completedAt - startedAt) : undefined;
    }
    current.step = numberValue(data.step) ?? current.step;
    if (args) current.arguments = args;
    current.status = toolStatus(event.type, current.status);
    if (event.type === "tool.completed") {
      current.result = parseResult(data.result);
      current.exitCode = numberValue(current.result?.exitCode);
      current.stdout = stringValue(current.result?.stdout) || "";
      current.stderr = stringValue(current.result?.stderr) || "";
    }
    if (event.type === "tool.failed") current.error = stringValue(data.error);
    if (event.type === "tool.rejected") current.error = stringValue(data.reason);
    commands.set(toolCallId, current);
  }

  const toolTotals = new Map();
  for (const tool of tools.values()) {
    const current = toolTotals.get(tool.name) || { name: tool.name, calls: 0, status: tool.status, seq: tool.seq, completedCalls: 0, rejectedCalls: 0, failedCalls: 0, runningCalls: 0 };
    current.calls += 1;
    if (tool.status === "completed") current.completedCalls += 1;
    else if (tool.status === "rejected") current.rejectedCalls += 1;
    else if (tool.status === "failed") current.failedCalls += 1;
    else if (tool.status === "running") current.runningCalls += 1;
    current.status = aggregateToolStatus(current);
    current.seq = Math.max(current.seq, tool.seq);
    toolTotals.set(tool.name, current);
  }

  return {
    skills: [...skills.values()].sort((left, right) => left.seq - right.seq),
    tools: [...toolTotals.values()].sort((left, right) => left.seq - right.seq),
    commands: [...commands.values()].sort((left, right) => left.seq - right.seq).map((command) => {
      const evidence = recordValue(commandEvidence[command.id]) || {};
      return {
        ...command,
        ...(recordValue(evidence.arguments) ? { arguments: evidence.arguments } : {}),
        ...(typeof evidence.stdout === "string" ? { stdout: evidence.stdout } : {}),
        ...(typeof evidence.stderr === "string" ? { stderr: evidence.stderr } : {}),
      };
    }),
  };
}

function upsertSkill(skills, name, status, seq, toolCallId) {
  const current = skills.get(name) || { id: toolCallId || name, name, status, seq };
  current.id = toolCallId || current.id;
  current.seq = Math.min(current.seq, seq);
  if (skillStatusPriority(status) >= skillStatusPriority(current.status)) current.status = status;
  skills.set(name, current);
}

function skillStatusPriority(status) {
  if (status === "completed" || status === "failed" || status === "rejected") return 3;
  if (status === "running") return 2;
  if (status === "bound") return 1;
  return 0;
}

export function commandToolCallIds(events) {
  return [...new Set((Array.isArray(events) ? events : []).flatMap((event) => {
    const data = recordValue(event?.data);
    const toolCallId = stringValue(data?.toolCallId);
    const toolName = stringValue(data?.toolName) || stringValue(data?.name);
    return toolCallId && toolName === "computer_run_command" ? [toolCallId] : [];
  }))];
}

function toolStatus(type, previous) {
  if (type === "tool.dispatched") return "running";
  if (type === "tool.completed") return "completed";
  if (type === "tool.failed") return "failed";
  if (type === "tool.rejected") return "rejected";
  return previous;
}

function aggregateToolStatus(tool) {
  if (tool.failedCalls > 0) return tool.failedCalls === tool.calls ? "failed" : "partial";
  if (tool.rejectedCalls > 0) return tool.rejectedCalls === tool.calls ? "rejected" : "partial";
  if (tool.runningCalls > 0) return "running";
  if (tool.completedCalls > 0) return "completed";
  return "queued";
}

function parseResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function recordValue(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; }
function stringValue(value) { return typeof value === "string" && value.trim() ? value : undefined; }
function numberValue(value) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
