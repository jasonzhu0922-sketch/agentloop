export interface RunState {
  activeByConversation: Map<string, unknown>;
  uploadingByConversation: Map<string, number>;
  cancellingAssignmentIds: Set<string>;
  deletingConversationIds: Set<string>;
  hydratedDetailAssignmentIds: Set<string>;
  pendingLiveAssistantIds: Set<string>;
  persistedReconciliation?: Promise<void>;
}

export function createRunState(): RunState;

export function releaseTerminalRun(
  state: RunState,
  conversationId: string | undefined,
  assistant: { readonly status?: string; readonly assignmentId?: string; readonly localRunId?: string } | undefined,
): boolean;
