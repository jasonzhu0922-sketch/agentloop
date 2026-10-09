import type { RuntimeRunEvent, RuntimeRunStatus } from "../../../src/shared/contracts.ts";
export function observeAssignment(options: {
  baseUrl: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  afterSeq?: number;
  onEvent(event: RuntimeRunEvent): boolean;
  /** An optional non-terminal Runtime snapshot for live provenance. */
  onStatus?(run: RuntimeRunStatus): void;
  onRun(run: RuntimeRunStatus): void;
  onConnection(state: "connected" | "reconnecting", error?: string): void;
  fetchImpl?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  idleTimeoutMs?: number;
}): Promise<void>;
