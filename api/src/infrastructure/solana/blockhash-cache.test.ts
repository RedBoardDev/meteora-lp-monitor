import { describe, expect, it, vi } from 'vitest';
import { BlockhashCache } from './blockhash-cache';

describe('BlockhashCache', () => {
  it('throws if read before being primed (fail loud, no bogus hash)', () => {
    const c = new BlockhashCache(async () => 'bh');
    expect(() => c.get()).toThrow();
  });

  it('refresh then get returns the fetched blockhash', async () => {
    let n = 0;
    const c = new BlockhashCache(async () => `bh${++n}`);
    await c.refresh();
    expect(c.get()).toBe('bh1');
    await c.refresh();
    expect(c.get()).toBe('bh2');
  });

  it('keeps the last good value if a refresh fails (transient RPC blip must not blank the cache)', async () => {
    let fail = false;
    const c = new BlockhashCache(async () => {
      if (fail) throw new Error('rpc down');
      return 'good';
    });
    await c.refresh();
    expect(c.get()).toBe('good');
    fail = true;
    await c.refresh(); // fails → keeps 'good'
    expect(c.get()).toBe('good');
  });

  it('start() primes (get ready) then refreshes on the timer; stop() halts it', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchFn = vi.fn(async () => `bh${++n}`);
      const c = new BlockhashCache(fetchFn, 2_000);
      await c.start(); // primes immediately → get() ready
      expect(c.get()).toBe('bh1');
      await vi.advanceTimersByTimeAsync(2_000); // one background refresh
      expect(c.get()).toBe('bh2');
      c.stop();
      await vi.advanceTimersByTimeAsync(6_000); // no more refreshes after stop
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
