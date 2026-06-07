/**
 * Global queue that releases at most `rpm` tasks per minute by spacing them evenly
 * (60_000 / rpm ms apart). Higher `priority` drains first; ties are FIFO. Every LPAgent call
 * goes through one shared instance so live close-enrichment and the slow history backfill never
 * exceed the provider's rate limit between them.
 */
type QueueItem = { priority: number; seq: number; run: () => void };

export class RateLimitedQueue {
  private readonly items: QueueItem[] = [];
  private seq = 0;
  private lastRunAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly spacingMs: number;

  constructor(rpm: number) {
    this.spacingMs = Math.ceil(60_000 / Math.max(1, rpm));
  }

  enqueue<T>(task: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.items.push({ priority, seq: this.seq++, run: () => task().then(resolve, reject) });
      // Higher priority first; FIFO within a priority.
      this.items.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      this.drain();
    });
  }

  private drain(): void {
    if (this.timer || this.items.length === 0) return;
    const wait = Math.max(0, this.lastRunAt + this.spacingMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const item = this.items.shift();
      if (item) {
        this.lastRunAt = Date.now();
        item.run();
      }
      this.drain();
    }, wait);
  }
}
