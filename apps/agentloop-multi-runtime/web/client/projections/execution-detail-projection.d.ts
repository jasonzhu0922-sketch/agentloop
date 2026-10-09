export interface ExecutionActivities {
  readonly skills: readonly Record<string, unknown>[];
  readonly tools: readonly Record<string, unknown>[];
  readonly commands: readonly Record<string, unknown>[];
}

export function executionActivities(events: readonly unknown[], commandEvidence?: Record<string, unknown>): ExecutionActivities;
export function commandToolCallIds(events: readonly unknown[]): string[];
