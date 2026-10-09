export function projectAssistantEvent(assistant: Record<string, unknown>, event: Record<string, unknown>): boolean;
export function mergeRuntimeEvents<T extends Record<string, unknown>>(currentEvents: readonly T[], incomingEvents: readonly T[], limit?: number): readonly T[];
export function replayAssistantEvents(assistant: Record<string, unknown>, events: readonly Record<string, unknown>[]): boolean;
export function hasIncompleteCompletedPlan(assistant: Record<string, unknown>): boolean;
