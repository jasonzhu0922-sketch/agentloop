export interface PersistedConversationTurn {
  readonly clientMessageId: string;
  readonly input: string;
  readonly createdAt: number;
  readonly attachments?: readonly unknown[];
  readonly assignment?: {
    readonly id: string;
    readonly runtimeId?: string;
    readonly hasRun: boolean;
    readonly errorMessage?: string;
  };
}

export interface PersistedConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number;
  readonly assignmentId?: string;
  readonly runtimeId?: string;
  readonly status?: string;
  readonly error?: string;
  readonly attachments?: readonly unknown[];
  readonly events?: readonly unknown[];
  readonly plan?: readonly unknown[];
}

export function conversationMessagesFromTurns(turns: readonly PersistedConversationTurn[]): PersistedConversationMessage[];
