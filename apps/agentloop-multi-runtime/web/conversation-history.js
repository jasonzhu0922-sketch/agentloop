/**
 * Build the browser projection for a persisted conversation turn index.
 * Host Run status and events are replayed separately through each Assignment.
 */
export function conversationMessagesFromTurns(turns) {
  return (Array.isArray(turns) ? turns : []).flatMap((turn) => {
    if (!turn || typeof turn.clientMessageId !== "string" || typeof turn.input !== "string") return [];
    const createdAt = finiteNumber(turn.createdAt, Date.now());
    const user = {
      id: turn.clientMessageId,
      role: "user",
      text: turn.input,
      createdAt,
      attachments: Array.isArray(turn.attachments) ? turn.attachments : [],
    };
    const assignment = turn.assignment;
    if (!assignment || typeof assignment.id !== "string") {
      return [user, failedAssistant(`history-${turn.clientMessageId}`, createdAt, "未找到该轮对应的执行记录")];
    }
    if (assignment.hasRun !== true) {
      return [user, failedAssistant(
        `history-${assignment.id}`,
        createdAt,
        typeof assignment.errorMessage === "string" ? assignment.errorMessage : "该轮未成功创建 Runtime Run",
        assignment,
      )];
    }
    const finalTurn = turn.finalTurn;
    if (finalTurn && ["completed", "failed", "cancelled"].includes(finalTurn.status)) {
      const output = typeof finalTurn.assistantOutput === "string" ? finalTurn.assistantOutput : "";
      return [user, {
        id: `history-${assignment.id}`,
        role: "assistant",
        text: output,
        ...(finalTurn.status === "failed" ? { error: output || finalTurn.errorCode || "执行失败" } : {}),
        reasoning: "",
        status: finalTurn.status,
        assignmentId: assignment.id,
        runtimeId: assignment.runtimeId,
        ...(typeof assignment.runtimeDisplayName === "string" ? { runtimeDisplayName: assignment.runtimeDisplayName } : {}),
        ...(typeof assignment.executionLocation === "string" ? { executionLocation: assignment.executionLocation } : {}),
        ...(typeof finalTurn.modelKey === "string" ? { modelKey: finalTurn.modelKey } : {}),
        ...(typeof assignment.remoteRunId === "string" ? { remoteRunId: assignment.remoteRunId } : {}),
        createdAt,
        completedAt: finiteNumber(finalTurn.completedAt, createdAt),
        events: [],
        plan: [],
      }];
    }
    return [user, {
      id: `history-${assignment.id}`,
      role: "assistant",
      text: "",
      reasoning: "",
      status: "running",
      assignmentId: assignment.id,
      runtimeId: assignment.runtimeId,
      ...(typeof assignment.runtimeDisplayName === "string" ? { runtimeDisplayName: assignment.runtimeDisplayName } : {}),
      ...(typeof assignment.executionLocation === "string" ? { executionLocation: assignment.executionLocation } : {}),
      ...(typeof assignment.remoteRunId === "string" ? { remoteRunId: assignment.remoteRunId } : {}),
      createdAt,
      events: [],
      plan: [],
    }];
  });
}

function failedAssistant(id, createdAt, message, assignment) {
  return {
    id,
    role: "assistant",
    text: message,
    error: message,
    reasoning: "",
    status: "failed",
    ...(typeof assignment?.id === "string" ? { assignmentId: assignment.id } : {}),
    ...(typeof assignment?.runtimeId === "string" ? { runtimeId: assignment.runtimeId } : {}),
    ...(typeof assignment?.runtimeDisplayName === "string" ? { runtimeDisplayName: assignment.runtimeDisplayName } : {}),
    ...(typeof assignment?.executionLocation === "string" ? { executionLocation: assignment.executionLocation } : {}),
    createdAt,
    completedAt: createdAt,
    events: [],
    plan: [],
  };
}

function finiteNumber(value, fallback) { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
