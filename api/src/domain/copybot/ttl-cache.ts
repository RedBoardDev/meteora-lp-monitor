/**
 * Copy-bot · P2.7 — TTL cache with injected clock (PURE, testable). Used to briefly memoize the per-mint
 * filter data (age, mcap, score, volume…) so that re-checks are instant (spec 07 §6:
 * "cached short-TTL + pre-warmed"). `nowMs` is passed as an argument → no dependency on `Date.now`.
 */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  /** Value if present AND not expired at `nowMs`; otherwise `undefined` (and purges the expired entry). */
  get(key: string, nowMs: number): V | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (nowMs >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, nowMs: number): void {
    this.store.set(key, { value, expiresAt: nowMs + this.ttlMs });
  }
}
