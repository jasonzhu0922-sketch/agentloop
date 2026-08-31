/**
 * In-process pub/sub for live run events. The HTTP SSE endpoint subscribes here
 * and receives each event the moment it is durably appended, so the UI streams
 * progress instead of polling the REST events endpoint.
 */
export interface LiveRunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

type Listener = (event: LiveRunEvent) => void;

export class RunEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(runId: string, listener: Listener): () => void {
    let set = this.listeners.get(runId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(runId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, event: LiveRunEvent): void {
    const set = this.listeners.get(runId);
    if (set === undefined) return;
    for (const listener of [...set]) listener(event);
  }
}
