export type ConversationRuntimeBinding = {
  readonly runtimeId: string;
  readonly executionLocation: "cloud" | "local" | "strict_local";
};

export function conversationRuntimeBinding(conversation: unknown): ConversationRuntimeBinding | undefined;
