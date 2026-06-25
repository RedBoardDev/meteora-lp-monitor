import { describe, expect, it } from 'vitest';
import { type FilterContext, FILTERS_ALL_OFF } from '../filter';
import { maxPriceChangePercent } from './max-price-change';

const c = { nonSolMint: 'MINT', pool: 'POOL' };
const ctx = (priceChangePercent?: number): FilterContext => ({ openTokenMints: new Set(), priceChangePercent });
const on = (v: number) => ({ ...FILTERS_ALL_OFF, maxPriceChangePercent: v });

describe('maxPriceChangePercent — anti-chase / stale-entry guard (per-leader, cached, Jupiter v2)', () => {
  it('off when null, on when set', () => {
    expect(maxPriceChangePercent.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(maxPriceChangePercent.enabled(on(40))).toBe(true);
  });
  it('move above threshold → skip above_max_price_change', () => {
    expect(maxPriceChangePercent.evaluate(on(40), c, ctx(60))).toEqual({ action: 'skip', reason: 'above_max_price_change' });
  });
  it('move ≤ threshold → pass', () => {
    expect(maxPriceChangePercent.evaluate(on(40), c, ctx(5))).toEqual({ action: 'pass' });
  });
  it('unknown change → skip max_price_change_unavailable', () => {
    expect(maxPriceChangePercent.evaluate(on(40), c, ctx())).toEqual({ action: 'skip', reason: 'max_price_change_unavailable' });
  });
  it('meta: jupiter-token / cached / no numeric preset', () => {
    expect([maxPriceChangePercent.source, maxPriceChangePercent.speedClass, maxPriceChangePercent.safePreset]).toEqual(['jupiter-token', 'cached', null]);
  });
});
