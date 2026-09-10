export function createCoalescedUpdater(input: {
  render(): void;
  persist(): void;
  requestFrame?(callback: () => void): unknown;
  cancelFrame?(id: unknown): void;
  setTimer?(callback: () => void, delay: number): unknown;
  clearTimer?(id: unknown): void;
  persistDelayMs?: number;
}): { request(): void; flush(): void };
