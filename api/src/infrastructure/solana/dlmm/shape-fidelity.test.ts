import { describe, expect, it } from 'vitest';
import { type PositionShape, compareFidelity } from './shape-fidelity';

// SOL = Y. Two bins at/below active holding SOL (y), token (x) = 0 → econ == sol-leg.
const leaderSolOnly: PositionShape = {
  activeBinId: 100,
  perBin: [
    { binId: 99, x: 0n, y: 100n },
    { binId: 100, x: 0n, y: 100n },
  ],
};

describe('compareFidelity — SOL-only positions', () => {
  it('a perfect half-size copy → 0% per-bin diff, ratio 0.5', () => {
    const copy: PositionShape = {
      activeBinId: 100,
      perBin: [
        { binId: 99, x: 0n, y: 50n },
        { binId: 100, x: 0n, y: 50n },
      ],
    };
    const r = compareFidelity(leaderSolOnly, copy, 'Y', 10);
    expect(r.maxEconDiffPct).toBeCloseTo(0, 6);
    expect(r.maxSolLegDiffPct).toBeCloseTo(0, 6);
    expect(r.totalRatio).toBeCloseTo(0.5, 6);
    expect(r.sameBinCount).toBe(true);
  });

  it('a copy missing one bin → distribution diff > 0 and bin counts differ', () => {
    const copy: PositionShape = { activeBinId: 100, perBin: [{ binId: 100, x: 0n, y: 100n }] };
    const r = compareFidelity(leaderSolOnly, copy, 'Y', 10);
    expect(r.sameBinCount).toBe(false);
    expect(r.maxSolLegDiffPct).toBeGreaterThan(40); // leader 50/50 vs copy 0/100 → 50pt on a bin
  });
});

describe('compareFidelity — two-sided (econ counts the token leg, sol-leg does not)', () => {
  // active bin holds token (x>0); a SOL-only copy that omits the token leg matches on sol-leg but NOT on econ.
  const leaderTwoSided: PositionShape = {
    activeBinId: 100,
    perBin: [
      { binId: 99, x: 0n, y: 100n }, // SOL bin
      { binId: 100, x: 1_000_000n, y: 0n }, // token bin (above/at active)
    ],
  };

  it('a copy that replicates BOTH legs proportionally → 0% econ AND sol-leg diff', () => {
    const copy: PositionShape = {
      activeBinId: 100,
      perBin: [
        { binId: 99, x: 0n, y: 50n },
        { binId: 100, x: 500_000n, y: 0n },
      ],
    };
    const r = compareFidelity(leaderTwoSided, copy, 'Y', 10);
    expect(r.maxEconDiffPct).toBeCloseTo(0, 4);
    expect(r.maxSolLegDiffPct).toBeCloseTo(0, 4);
    expect(r.totalRatio).toBeCloseTo(0.5, 4);
    expect(r.tokenLegRatio).toBeCloseTo(0.5, 6); // copy token leg (500k) / leader token leg (1M) — proves the token leg is replicated
  });

  it('a SOL-only copy (omits the token bin) → sol-leg faithful, but the omission shows in the ratios + bin count', () => {
    const copy: PositionShape = { activeBinId: 100, perBin: [{ binId: 99, x: 0n, y: 50n }] };
    const r = compareFidelity(leaderTwoSided, copy, 'Y', 10);
    expect(r.maxSolLegDiffPct).toBeCloseTo(0, 4); // the only SOL bin matches in proportion
    expect(r.solLegRatio).toBeCloseTo(0.5, 6); // copy SOL leg (50) / leader SOL leg (100) — unaffected by the uncopied token bin
    // The omission is caught by the SHIFT-INVARIANT signals (the per-bin diff is shift-aligned, and on a degenerate
    // 1-bin copy a rigid shift can spuriously align it onto the leader's token bin — which is exactly why the
    // two-sided discriminator is the token-leg ratio, not the econ per-bin diff):
    expect(r.tokenLegRatio).toBe(0); // a one-sided copy holds NO token → exactly 0
    expect(r.totalRatio).toBeLessThan(0.5); // econ ratio is dragged DOWN by the uncopied token value
    expect(r.sameBinCount).toBe(false); // 1 bin vs 2 → structural mismatch
  });
});

describe('compareFidelity — SOL = X side', () => {
  it('values the token (y) leg via 1/price and still scores a half copy at ratio 0.5', () => {
    const leader: PositionShape = { activeBinId: 0, perBin: [{ binId: 0, x: 100n, y: 0n }] };
    const copy: PositionShape = { activeBinId: 0, perBin: [{ binId: 0, x: 50n, y: 0n }] };
    const r = compareFidelity(leader, copy, 'X', 10);
    expect(r.totalRatio).toBeCloseTo(0.5, 6);
    expect(r.maxEconDiffPct).toBeCloseTo(0, 6);
  });
});
