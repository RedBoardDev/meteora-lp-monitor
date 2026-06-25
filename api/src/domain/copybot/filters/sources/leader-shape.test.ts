import { describe, expect, it } from 'vitest';
import { rangeCoveragePercent } from './leader-shape';

describe('rangeCoveragePercent — leader-shape projection (bins × binStep / 100)', () => {
  it('derives coverage in percent from bin count and binStep (bps)', () => {
    expect(rangeCoveragePercent(69, 20)).toBeCloseTo(13.8, 6);
  });
  it('a single tight bin → tiny coverage (what minPriceRangePercent rejects)', () => {
    expect(rangeCoveragePercent(1, 20)).toBeCloseTo(0.2, 6);
  });
  it('zero bins → 0', () => {
    expect(rangeCoveragePercent(0, 20)).toBe(0);
  });
});
