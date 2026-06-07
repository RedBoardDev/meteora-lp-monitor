import type { OpenPosition } from '@meteora/shared';
import { describe, expect, it } from 'vitest';
import { buildTotals } from './wallet-state';

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  positionAddress: 'p',
  wallet: 'w',
  poolAddress: 'pool',
  tokenX: 'X',
  tokenY: 'SOL',
  tokenXMint: 'm',
  sizeSol: 10,
  pnlSol: 1,
  pnlPctSol: 10,
  claimedFeesSol: 0.1,
  unclaimedFeesSol: 0.2,
  rangeStatus: 'in',
  minPrice: 1,
  maxPrice: 2,
  poolPrice: 1.5,
  outOfRangeSince: null,
  openedAt: null,
  updatedAt: 0,
  ...over,
});

describe('buildTotals', () => {
  it('sums TVL/PnL/fees and counts in vs out of range', () => {
    const t = buildTotals([pos(), pos({ rangeStatus: 'out_up', pnlSol: -2 })], 5);
    expect(t.tvlSol).toBe(20);
    expect(t.uPnlSol).toBe(-1);
    expect(t.inRangeCount).toBe(1);
    expect(t.outOfRangeCount).toBe(1);
    expect(t.openCount).toBe(2);
  });

  it('walletTotalSol = TVL + idle', () => {
    const t = buildTotals([pos({ sizeSol: 10 })], 7.5);
    expect(t.idleSol).toBe(7.5);
    expect(t.walletTotalSol).toBe(17.5);
  });

  it('empty portfolio yields zeros, no divide-by-zero', () => {
    const t = buildTotals([], 0);
    expect(t.openCount).toBe(0);
    expect(t.uPnlPct).toBe(0);
    expect(t.walletTotalSol).toBe(0);
  });
});
