import { describe, expect, it } from 'vitest';
import { singleFlight, TokenBucket, TtlCache, VersionedCache } from './cache';

describe('TtlCache', () => {
  it('returns values until they expire', () => {
    let t = 0;
    const cache = new TtlCache<number>(100, 100, () => t);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    t = 100;
    expect(cache.get('a')).toBeUndefined(); // exp is inclusive
  });

  it('evicts the oldest entry past maxEntries', () => {
    const cache = new TtlCache<number>(10_000, 2, () => 0);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });
});

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refills at the rate', () => {
    let t = 0;
    const tb = new TokenBucket(2, 1, () => t);
    expect(tb.tryAcquire()).toBe(true);
    expect(tb.tryAcquire()).toBe(true);
    expect(tb.tryAcquire()).toBe(false); // burst exhausted
    t = 1000; // 1s → +1 token
    expect(tb.tryAcquire()).toBe(true);
    expect(tb.tryAcquire()).toBe(false);
  });
});

describe('VersionedCache', () => {
  it('caches a computed value until the resource is bumped (write invalidation)', async () => {
    const c = new VersionedCache(10_000);
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };
    expect(await c.wrap('stats', ['W'], fn)).toBe(1);
    expect(await c.wrap('stats', ['W'], fn)).toBe(1); // served from cache — fn not re-run
    expect(calls).toBe(1);
    c.bump('W'); // a write to W invalidates everything keyed on it
    expect(await c.wrap('stats', ['W'], fn)).toBe(2);
    expect(calls).toBe(2);
  });

  it('invalidates a multi-resource key when ANY of its resources is bumped', async () => {
    const c = new VersionedCache(10_000);
    let calls = 0;
    const fn = async () => ++calls;
    await c.wrap('stats', ['A', 'B'], fn); // calls=1
    c.bump('B');
    await c.wrap('stats', ['A', 'B'], fn); // B changed → recompute, calls=2
    expect(calls).toBe(2);
  });

  it('coalesces a concurrent herd on the same key into ONE backing call', async () => {
    const c = new VersionedCache(10_000);
    let calls = 0;
    const fn = () => {
      calls++;
      return new Promise<number>((r) => setTimeout(() => r(7), 10));
    };
    // 50 concurrent identical reads (the thundering herd) must trigger a single computation, not 50.
    const results = await Promise.all(Array.from({ length: 50 }, () => c.wrap('stats', ['W'], fn)));
    expect(calls).toBe(1);
    expect(results.every((v) => v === 7)).toBe(true);
    // After it settles the value is cached — still one call.
    expect(await c.wrap('stats', ['W'], fn)).toBe(7);
    expect(calls).toBe(1);
  });
});

describe('singleFlight', () => {
  it('coalesces concurrent calls with the same key', async () => {
    const sf = singleFlight<number>();
    let calls = 0;
    const fn = () => {
      calls++;
      return new Promise<number>((r) => setTimeout(() => r(42), 10));
    };
    const [a, b] = await Promise.all([sf('k', fn), sf('k', fn)]);
    expect(calls).toBe(1);
    expect(a).toBe(42);
    expect(b).toBe(42);
    // a new call after the first settled runs again
    expect(await sf('k', fn)).toBe(42);
    expect(calls).toBe(2);
  });
});
