import type { StoredRunEvent } from "../storage/run-event-store.ts";

/** Local notifications are wake-up hints. The committed cursor is the delivery authority. */
export class DurableRunEventSubscriptions {
  private readonly active = new Set<() => void>();
  private readonly read: (runId: string, after: number) => Promise<StoredRunEvent[]>;
  constructor(read: (runId: string, after: number) => Promise<StoredRunEvent[]>) { this.read = read; }

  subscribe(runId: string, after: number, listener: (event: StoredRunEvent) => void,
    wake: (poll: () => void) => () => void, onError: (error: unknown) => void): () => void {
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Invalid event subscription cursor");
    let cursor = after, stopped = false, flight: Promise<void> | undefined, requested = false;
    const poll = () => {
      if (stopped) return;
      if (flight) { requested = true; return; }
      flight = (async () => {
        try {
          const rows = await this.read(runId, cursor);
          for (const event of rows) {
            if (stopped || event.seq <= cursor) continue;
            // Advance only after a successful synchronous transport handoff.
            listener(event); cursor = event.seq;
          }
        } catch (error) { if (!stopped) onError(error); }
      })().finally(() => { flight = undefined; if (requested) { requested = false; poll(); } });
    };
    const unwake = wake(poll);
    const timer = setInterval(poll, 250); timer.unref();
    const unsubscribe = () => { stopped = true; clearInterval(timer); unwake(); this.active.delete(unsubscribe); };
    this.active.add(unsubscribe); poll();
    return unsubscribe;
  }
  close(): void { for (const unsubscribe of this.active) unsubscribe(); }
}
