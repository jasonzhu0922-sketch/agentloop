export interface AssistantMessagePresentation {
  isLive: boolean;
  label: string;
  icon: string;
  cardClass: string;
  emptyText: string;
}

export function assistantMessagePresentation(status: unknown): AssistantMessagePresentation;
export function terminalAwarePlanStepStatus(stepStatus: unknown, runStatus: unknown): unknown;
