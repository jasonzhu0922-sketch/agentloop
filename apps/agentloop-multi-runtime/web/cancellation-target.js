/**
 * Resolve the Run that owns the stop control for a conversation.
 *
 * A live page has an in-memory controller, but a page reload deliberately
 * drops that controller. The persisted assistant message still carries the
 * Router assignment id, which remains the authority for cancelling a
 * non-terminal Run.
 */
export function persistedCancellableAssistant(messages) {
  return [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === "assistant"
      && message.status === "running"
      && typeof message.assignmentId === "string"
      && message.assignmentId.length > 0);
}

export function cancellationTarget(activeRun, messages) {
  const assistant = activeRun?.assistant ?? persistedCancellableAssistant(messages);
  const assignmentId = typeof (activeRun?.assignmentId ?? assistant?.assignmentId) === "string"
    ? activeRun?.assignmentId ?? assistant?.assignmentId
    : undefined;
  return {
    activeRun,
    assistant,
    assignmentId,
    canCancel: activeRun !== undefined || assistant !== undefined,
  };
}
