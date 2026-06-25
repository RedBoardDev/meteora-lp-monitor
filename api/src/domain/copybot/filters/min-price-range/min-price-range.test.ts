import { describe, expect, it } from 'vitest';
import { type FilterContext, FILTERS_ALL_OFF } from '../filter';
import { minPriceRangePercent } from './min-price-range';

const c = { nonSolMint: 'MINT', pool: 'POOL' };
const ctx = (priceRangePercent?: number): FilterContext => ({ openTokenMints: new Set(), priceRangePercent });
const on = (v: number) => ({ ...FILTERS_ALL_OFF, minPriceRangePercent: v });

describe('minPriceRangePercent — reject ultra-tight ranges (per-leader, instant, leader-shape)', () => {
  it('off when null, on when set', () => {
    expect(minPriceRangePercent.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(minPriceRangePercent.enabled(on(3))).toBe(true);
  });
  it('range below threshold → skip below_min_price_range', () => {
    expect(minPriceRangePercent.evaluate(on(3), c, ctx(1))).toEqual({ action: 'skip', reason: 'below_min_price_range' });
  });
  it('range ≥ threshold → pass', () => {
    expect(minPriceRangePercent.evaluate(on(3), c, ctx(6))).toEqual({ action: 'pass' });
  });
  it('unknown range → skip min_price_range_unavailable', () => {
    expect(minPriceRangePercent.evaluate(on(3), c, ctx())).toEqual({ action: 'skip', reason: 'min_price_range_unavailable' });
  });
  it('meta: leader-shape / instant / preset 3', () => {
    expect([minPriceRangePercent.source, minPriceRangePercent.speedClass, minPriceRangePercent.safePreset]).toEqual(['leader-shape', 'instant', 3]);
  });
});
