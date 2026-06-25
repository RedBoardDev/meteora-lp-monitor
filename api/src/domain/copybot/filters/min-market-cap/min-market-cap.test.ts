import { describe, expect, it } from 'vitest';
import { type FilterContext, FILTERS_ALL_OFF } from '../filter';
import { minMarketCapUsd } from './min-market-cap';

const c = { nonSolMint: 'MINT', pool: 'POOL' };
const ctx = (marketCapUsd?: number): FilterContext => ({ openTokenMints: new Set(), marketCapUsd });
const on = (v: number) => ({ ...FILTERS_ALL_OFF, minMarketCapUsd: v });

describe('minMarketCapUsd — skip low-cap tokens (per-leader, cached, Jupiter v2 mcap)', () => {
  it('off when null, on when set', () => {
    expect(minMarketCapUsd.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(minMarketCapUsd.enabled(on(1_000_000))).toBe(true);
  });
  it('mcap below threshold → skip below_min_market_cap', () => {
    expect(minMarketCapUsd.evaluate(on(1_000_000), c, ctx(500_000))).toEqual({ action: 'skip', reason: 'below_min_market_cap' });
  });
  it('mcap ≥ threshold → pass', () => {
    expect(minMarketCapUsd.evaluate(on(1_000_000), c, ctx(5_000_000))).toEqual({ action: 'pass' });
  });
  it('unknown mcap → skip min_market_cap_unavailable', () => {
    expect(minMarketCapUsd.evaluate(on(1_000_000), c, ctx())).toEqual({ action: 'skip', reason: 'min_market_cap_unavailable' });
  });
  it('meta: jupiter-token / cached / preset $1M', () => {
    expect([minMarketCapUsd.source, minMarketCapUsd.speedClass, minMarketCapUsd.safePreset]).toEqual(['jupiter-token', 'cached', 1_000_000]);
  });
});
