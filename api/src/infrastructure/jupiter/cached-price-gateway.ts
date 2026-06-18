import type { PriceGateway } from '@/domain/ports';
import { TokenBucket, TtlCache } from '@/util/cache';

export interface PriceCacheOptions {
  /** How long a per-mint SOL price stays fresh (volatile → keep short). */
  priceTtlMs?: number;
  /** How long the SOL/USD figure stays fresh. */
  solUsdTtlMs?: number;
  bucketCapacity?: number;
  bucketRatePerSec?: number;
}

/**
 * Decorates a PriceGateway with a per-mint TTL cache, request coalescing (single-flight) and a
 * per-upstream token bucket. Keyed by RESOURCE (mint), so N wallets/snapshots needing the same mint
 * within one window collapse to ONE upstream call — the genuine cross-user dedup lever for prices.
 */
export class CachedPriceGateway implements PriceGateway {
  private readonly priceCache: TtlCache<number>;
  private readonly flights = new Map<string, Promise<Map<string, number>>>();
  private readonly bucket: TokenBucket;
  private readonly solUsdTtlMs: number;
  private solUsd: { v: number | null; exp: number } | null = null;
  private solUsdFlight: Promise<number | null> | null = null;

  constructor(
    private readonly inner: PriceGateway,
    opts: PriceCacheOptions = {},
  ) {
    this.priceCache = new TtlCache<number>(opts.priceTtlMs ?? 5_000);
    this.solUsdTtlMs = opts.solUsdTtlMs ?? 30_000;
    this.bucket = new TokenBucket(opts.bucketCapacity ?? 10, opts.bucketRatePerSec ?? 5);
  }

  async getPricesSol(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const uniq = [...new Set(mints.filter(Boolean))];
    const need: string[] = [];
    for (const m of uniq) {
      const cached = this.priceCache.get(m);
      if (cached !== undefined) out.set(m, cached);
      else if (!this.flights.has(m)) need.push(m);
    }
    if (need.length > 0) {
      const p = this.fetch(need);
      for (const m of need) this.flights.set(m, p);
    }
    const pending = new Set<Promise<Map<string, number>>>();
    for (const m of uniq) {
      const f = this.flights.get(m);
      if (f) pending.add(f);
    }
    await Promise.allSettled([...pending]);
    for (const m of uniq) {
      if (out.has(m)) continue;
      const cached = this.priceCache.get(m);
      if (cached !== undefined) out.set(m, cached);
    }
    return out;
  }

  private async fetch(mints: string[]): Promise<Map<string, number>> {
    try {
      await this.bucket.acquire();
      const res = await this.inner.getPricesSol(mints);
      for (const [m, v] of res) this.priceCache.set(m, v);
      return res;
    } finally {
      for (const m of mints) this.flights.delete(m);
    }
  }

  async getSolUsd(): Promise<number | null> {
    if (this.solUsd && this.solUsd.exp > Date.now()) return this.solUsd.v;
    if (this.solUsdFlight) return this.solUsdFlight;
    this.solUsdFlight = (async () => {
      try {
        await this.bucket.acquire();
        const v = await this.inner.getSolUsd();
        this.solUsd = { v, exp: Date.now() + this.solUsdTtlMs };
        return v;
      } finally {
        this.solUsdFlight = null;
      }
    })();
    return this.solUsdFlight;
  }
}
