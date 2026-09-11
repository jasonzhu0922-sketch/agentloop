export interface CancellableAssistant {
  readonly role: "assistant";
  readonly status: "running";
  readonly assignmentId: string;
}

export function persistedCancellableAssistant(messages: readonly unknown[]): CancellableAssistant | undefined;

export function cancellationTarget(
  activeRun: unknown,
  messages: readonly unknown[],
): {
  readonly activeRun: unknown;
  readonly assistant: CancellableAssistant | undefined;
  readonly assignmentId: string | undefined;
  readonly canCancel: boolean;
};
