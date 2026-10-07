/** Browser-owned coordination state for active Runs, uploads, cancellation and live repaint. */
export function createRunState() {
  return {
    activeByConversation: new Map(),
    uploadingByConversation: new Map(),
    cancellingAssignmentIds: new Set(),
    deletingConversationIds: new Set(),
    hydratedDetailAssignmentIds: new Set(),
    pendingLiveAssistantIds: new Set(),
  };
}
