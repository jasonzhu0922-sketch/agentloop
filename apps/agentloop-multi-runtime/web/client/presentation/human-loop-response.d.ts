export interface HumanLoopRequestView {
  readonly responseSchema?: {
    readonly type?: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly fields?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly acceptLabel?: string;
    readonly rejectLabel?: string;
  };
}

export function humanLoopResponseText(request: HumanLoopRequestView | undefined | null, value: unknown): string;
