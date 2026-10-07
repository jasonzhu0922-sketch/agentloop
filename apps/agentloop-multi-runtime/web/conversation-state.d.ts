export interface ConversationState<T = any> {
  recovered: T[];
  sessions: T[];
  activeId: string | undefined;
  visibleLimit: number;
  nextOffset: number;
  hasMore: boolean;
  loadingMore: boolean;
  resetPaging(): void;
  clear(): void;
}
export function createConversationState<T = any>(pageSize?: number): ConversationState<T>;
