/** Bounded TTL cache. Entries expire after `ttlMs`; the oldest is evicted past `maxEntries`. */
export class TtlCache<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }

  set(key: string, v: V): void {
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { v, exp: this.now() + this.ttlMs });
  }

  /** Drop a key now (explicit invalidation, e.g. after a write that changes the cached value). */
  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Token bucket: `capacity` burst tokens, refilled at `ratePerSec`. `acquire()` waits for a token,
 * `tryAcquire()` returns false instead of waiting. Smooths bursts (e.g. a WS-reconnect poll storm)
 * without serialising everything the way a fixed even-spacer would.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly ratePerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(5, ((1 - this.tokens) / this.ratePerSec) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/**
 * Per-key response cache with a short TTL AND per-resource version invalidation: `bump(resource)` on a
 * write so the next read recomputes, while repeated identical reads BETWEEN writes are served from memory.
 * Used to make the read API light (e.g. /stats) without ever serving data staler than the last write.
 */
export class VersionedCache {
  private readonly cache: TtlCache<unknown>;
  private readonly versions = new Map<string, number>();
  /** In-flight computations keyed by the resolved cache key — coalesces a concurrent herd (e.g. 50
   *  viewers missing the same /stats window at once) into a SINGLE backing call instead of N scans. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(ttlMs: number, maxEntries = 2000) {
    this.cache = new TtlCache<unknown>(ttlMs, maxEntries);
  }

  /** Invalidate everything keyed on `resource` (its version advances → old cache keys never match). */
  bump(resource: string): void {
    this.versions.set(resource, (this.versions.get(resource) ?? 0) + 1);
  }

  private versionKey(resources: string[]): string {
    return resources.map((r) => `${r}@${this.versions.get(r) ?? 0}`).join(',');
  }

  /**
   * Serve `key` from cache if fresh AND none of `resources` changed since; otherwise compute + store.
   * Contract: `fn` must resolve a DEFINED value — an `undefined` result is indistinguishable from a
   * cache miss here, so it would be recomputed on every call. All current callers return objects.
   */
  async wrap<T>(key: string, resources: string[], fn: () => Promise<T>): Promise<T> {
    const k = `${key}#${this.versionKey(resources)}`;
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit as T;
    // Coalesce: if the same key is already being computed, await that one call rather than launching
    // a duplicate (the thundering-herd guard — concurrent identical reads share one DB round-trip).
    const pending = this.inflight.get(k);
    if (pending) return pending as Promise<T>;
    const p = fn()
      .then((value) => {
        this.cache.set(k, value);
        return value;
      })
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p as Promise<T>;
  }
}

/** Coalesce concurrent calls sharing a key into a single in-flight promise. */
export function singleFlight<T>(): (key: string, fn: () => Promise<T>) => Promise<T> {
  const inflight = new Map<string, Promise<T>>();
  return (key, fn) => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
