export function createConcurrencyLimiter(limit: number): {
  acquire: () => Promise<void>;
  release: () => void;
} {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  };
  return { acquire, release };
}

/** FIFO admission: an exclusive operation fences both earlier and later work. */
export class OrderedExecutionScheduler {
  private readonly queue: Array<{ mode: "parallel" | "exclusive"; start: () => void }> = [];
  private active = 0;
  private exclusive = false;
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Concurrency must be a positive integer");
    this.limit = limit;
  }

  schedule<T>(mode: "parallel" | "exclusive", operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ mode, start: () => {
        this.active += 1;
        this.exclusive = mode === "exclusive";
        const finish = (): void => {
          this.active -= 1;
          this.exclusive = false;
          this.drain();
        };
        void Promise.resolve().then(operation).then(
          (value) => { finish(); resolve(value); },
          (error: unknown) => { finish(); reject(error); },
        );
      } });
      this.drain();
    });
  }

  private drain(): void {
    while (!this.exclusive && this.active < this.limit && this.queue.length > 0) {
      const next = this.queue[0]!;
      if (next.mode === "exclusive" && this.active > 0) return;
      this.queue.shift();
      next.start();
    }
  }
}

// Preallocated result slots preserve source order without serializing
// independent work.
export async function mapWithConcurrencyLimit<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  operation: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
