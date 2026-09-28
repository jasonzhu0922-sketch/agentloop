export interface RunState {
  activeByConversation: Map<string, unknown>;
  uploadingByConversation: Map<string, number>;
  cancellingAssignmentIds: Set<string>;
  deletingConversationIds: Set<string>;
  hydratedDetailAssignmentIds: Set<string>;
  pendingLiveAssistantIds: Set<string>;
}

export function createRunState(): RunState;
