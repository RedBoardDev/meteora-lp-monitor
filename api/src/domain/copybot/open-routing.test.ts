import { describe, expect, it } from 'vitest';
import { ATOMIC_BY_WEIGHT_BIN_LIMIT, isWideOpen } from './open-routing';

describe('isWideOpen — when an open must be sequenced (create → deposit) vs the atomic single-tx open', () => {
  // WHY: the atomic by-weight open chunks at 26 bins and the deposit is NOT the first chunk — publishing only the
  // first tx (the historical empty-position bug) creates a position with no liquidity. The boundary must be exact.
  it('narrow open (< 26 bins) → atomic single tx (not wide)', () => {
    expect(isWideOpen(1)).toBe(false);
    expect(isWideOpen(15)).toBe(false);
    expect(isWideOpen(25)).toBe(false);
  });

  it('boundary at the SDK chunk limit: 25 stays atomic, 26 must be sequenced (no off-by-one → no silent empty position)', () => {
    expect(isWideOpen(ATOMIC_BY_WEIGHT_BIN_LIMIT - 1)).toBe(false);
    expect(isWideOpen(ATOMIC_BY_WEIGHT_BIN_LIMIT)).toBe(true);
  });

  it('wide open (≥ 26 bins) → sequenced', () => {
    expect(isWideOpen(26)).toBe(true);
    expect(isWideOpen(50)).toBe(true);
    expect(isWideOpen(70)).toBe(true);
  });
});
