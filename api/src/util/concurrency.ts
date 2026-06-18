/**
 * Exact concurrency cap. A released permit is handed DIRECTLY to the next waiter (the active count is
 * never decremented while a waiter exists), so the ceiling can't be overshot by a race between a
 * release and a fresh acquire. `run` is the convenience wrapper that always releases, even on throw.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next)
      next(); // transfer the permit (active unchanged)
    else this.active--;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Permits currently held — for tests/observability. */
  get activeCount(): number {
    return this.active;
  }
}

/**
 * Serializes async work per key (FIFO). Concurrent `run` calls for the SAME key execute one-at-a-time;
 * different keys run in parallel. A rejection isolates to its own caller and never wedges the key's
 * chain — the next call still runs. The in-process equivalent of a per-key lock (single process).
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.catch(() => undefined).then(() => fn());
    // store a swallowed tail so the next call chains (serializes) but a rejection can't wedge the chain
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  delete(key: string): void {
    this.tails.delete(key);
  }
}
