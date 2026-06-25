import { describe, expect, it } from 'vitest';
import { snapshotToContext } from './snapshot';
import type { TokenSnapshot } from './source';

const EMPTY: TokenSnapshot = {
  organicScore: null,
  holders: null,
  marketCapUsd: null,
  volume24hUsd: null,
  priceChange24hPercent: null,
  firstPoolCreatedAtMs: null,
  mintAuthorityDisabled: null,
  freezeAuthorityDisabled: null,
  topHoldersPercent: null,
};

describe('snapshotToContext — pure projection snapshot → FilterContext fields', () => {
  it('maps present fields and derives token age in hours from firstPool', () => {
    const ctx = snapshotToContext(
      { ...EMPTY, organicScore: 70, holders: 500, marketCapUsd: 2_000_000, volume24hUsd: 10_000, priceChange24hPercent: 5, firstPoolCreatedAtMs: 1_000 },
      2 * 3_600_000 + 1_000,
    );
    expect(ctx).toEqual({ organicScore: 70, holders: 500, marketCapUsd: 2_000_000, volume24hUsd: 10_000, priceChangePercent: 5, tokenAgeHours: 2 });
  });

  it('null fields are omitted (undefined ⇒ the enabled filter skips as *_unavailable)', () => {
    expect(snapshotToContext(EMPTY, 1_000)).toEqual({});
  });

  it('does NOT set priceRangePercent (that comes from the leader shape, not the token snapshot)', () => {
    expect('priceRangePercent' in snapshotToContext({ ...EMPTY, organicScore: 1 }, 0)).toBe(false);
  });
});
