import type { ClosedPosition } from '@meteora/shared';
import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';

const closed = (over: Partial<ClosedPosition> = {}): ClosedPosition => ({
  positionAddress: 'p',
  wallet: 'w',
  poolAddress: 'pool',
  tokenX: 'X',
  tokenY: 'SOL',
  tokenXMint: 'm',
  pnlSol: 1,
  pnlPctSol: 5,
  feesSol: 0.1,
  depositSol: 10,
  withdrawSol: 11,
  openedAt: 1,
  closedAt: 2,
  durationSeconds: 1,
  ...over,
});

describe('computeStats', () => {
  it('computes win rate and totals', () => {
    const s = computeStats('all', [closed({ pnlSol: 2 }), closed({ pnlSol: -1 })]);
    expect(s.closedCount).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(50);
    expect(s.totalPnlSol).toBe(1);
  });

  it('todayPnlSol counts only positions closed since local midnight', () => {
    const now = Date.now();
    const threeDaysAgo = now - 3 * 24 * 3600 * 1000;
    const s = computeStats('all', [
      closed({ pnlSol: 5, closedAt: now }),
      closed({ pnlSol: 9, closedAt: threeDaysAgo }),
    ]);
    expect(s.todayPnlSol).toBe(5);
    expect(s.totalPnlSol).toBe(14);
  });

  it('handles an empty history', () => {
    const s = computeStats('all', []);
    expect(s.closedCount).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.todayPnlSol).toBe(0);
  });
});
