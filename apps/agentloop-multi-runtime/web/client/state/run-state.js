/** Browser-owned coordination state for active Runs, uploads, cancellation and live repaint. */
export function createRunState() {
  return {
    activeByConversation: new Map(),
    uploadingByConversation: new Map(),
    cancellingAssignmentIds: new Set(),
    deletingConversationIds: new Set(),
    hydratedDetailAssignmentIds: new Set(),
    pendingLiveAssistantIds: new Set(),
    persistedReconciliation: undefined,
  };
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Release only the browser-side composer lock for a Run whose terminal state
 * has already been confirmed by the Runtime. Artifact/detail hydration may
 * continue afterwards, but it must not hold the next conversation turn.
 */
export function releaseTerminalRun(state, conversationId, assistant) {
  if (!TERMINAL_RUN_STATUSES.has(assistant?.status)) return false;
  const activeRun = state?.activeByConversation?.get(conversationId);
  if (!activeRun) return false;
  const sameAssistant = activeRun.assistant === assistant;
  const sameAssignment = typeof activeRun.assignmentId === "string"
    && activeRun.assignmentId === assistant?.assignmentId;
  const sameLocalRun = typeof activeRun.localRunId === "string"
    && activeRun.localRunId === assistant?.localRunId;
  if (!sameAssistant && !sameAssignment && !sameLocalRun) return false;
  state.activeByConversation.delete(conversationId);
  return true;
}
