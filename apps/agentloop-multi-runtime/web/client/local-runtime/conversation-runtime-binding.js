/** Runtime ownership is established only by a turn that reached a Runtime Run. */
export function conversationRuntimeBinding(conversation) {
  if (!conversation || typeof conversation !== "object") return undefined;
  if (executionLocation(conversation.executionLocation)) {
    if (conversation.executionLocation === "cloud") return { executionLocation: "cloud" };
    if (nonEmpty(conversation.boundRuntimeId)) {
      return { runtimeId: conversation.boundRuntimeId, executionLocation: conversation.executionLocation };
    }
  }
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const hasRun = nonEmpty(message.remoteRunId) || nonEmpty(message.localRunId);
    const runtimeId = nonEmpty(message.localRuntimeId) ? message.localRuntimeId : message.runtimeId;
    if (!hasRun) continue;
    const location = executionLocation(message.executionLocation)
      ? message.executionLocation
      : nonEmpty(message.localRuntimeId) || nonEmpty(message.localRunId) ? "local" : "cloud";
    if (location === "cloud") return { executionLocation: "cloud" };
    if (nonEmpty(runtimeId)) return { runtimeId, executionLocation: location };
  }
  return undefined;
}

function executionLocation(value) { return value === "cloud" || value === "local" || value === "strict_local"; }
function nonEmpty(value) { return typeof value === "string" && value.length > 0; }
