import { describe, expect, it } from 'vitest';
import { chunked, symmetricDiffSize } from './utils';

// NOTE: `shouldRefreshRealized` (realized-PnL refresh schedule) is exercised by the realized-PnL feature's own tests
// on its branch — kept out of here to avoid duplicating/diverging that parallel work. These two cover the pure
// engine UTILITIES (set diff for change detection + bounded-concurrency batching) which had no coverage.

describe('symmetricDiffSize — count of keys present in exactly one set', () => {
  it('counts additions AND removals (both directions)', () => {
    expect(symmetricDiffSize(new Set(['a', 'b']), new Set(['b', 'c']))).toBe(2); // a removed, c added
  });
  it('identical sets → 0 (no change → no re-trigger)', () => {
    expect(symmetricDiffSize(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(0);
  });
  it('one empty set → the size of the other (all added or all removed)', () => {
    expect(symmetricDiffSize(new Set<string>(), new Set(['a', 'b', 'c']))).toBe(3);
    expect(symmetricDiffSize(new Set(['x']), new Set<string>())).toBe(1);
  });
});

describe('chunked — bounded-concurrency batch processing (RPC politeness)', () => {
  it('processes EVERY item and preserves input order', async () => {
    const out = await chunked([1, 2, 3, 4, 5, 6, 7], async (n) => n * 2); // > one chunk (5) → spans batches
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]); // all 7, in order, across the chunk boundary
  });
  it('runs fn exactly once per item', async () => {
    const seen: number[] = [];
    await chunked([1, 2, 3], async (n) => {
      seen.push(n);
      return n;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
  it('an empty input never calls fn and returns []', async () => {
    let calls = 0;
    const out = await chunked([], async (n: number) => {
      calls++;
      return n;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
