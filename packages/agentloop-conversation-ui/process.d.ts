export interface ProcessTurn {
  status: string;
  events: readonly Record<string, any>[];
  text?: string;
  inputMessages?: readonly Record<string, any>[];
  toolEvidence?: Record<string, Record<string, any>>;
}
export function visibleToolCalls(events: readonly Record<string, any>[], runStatus?: string): Record<string, any>[];
export function renderProcess(turn: ProcessTurn, openTools?: Record<string, boolean>, openProtocol?: Record<string, boolean>, processOpen?: boolean, openToolDetails?: Record<string, boolean>, liveProgressForEvent?: (event: Record<string, any>) => string | undefined): string;
