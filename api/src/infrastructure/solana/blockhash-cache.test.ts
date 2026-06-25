import { describe, expect, it } from 'vitest';
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
});
