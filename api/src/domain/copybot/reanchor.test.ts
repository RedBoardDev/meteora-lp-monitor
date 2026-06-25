import { describe, expect, it } from 'vitest';
import { type LeaderBinAmount, reanchorShape } from './reanchor';

const sumBps = (w: { bps: number }[]) => w.reduce((s, x) => s + x.bps, 0);

describe('reanchorShape — exact re-anchoring of the bin shape', () => {
  it('a single bin → 100% (10000 bps), bin unchanged if delta 0', () => {
    const r = reanchorShape(100, 100, [{ binId: 100, amount: 500n }]);
    expect(r.weights).toEqual([{ binId: 100, bps: 10_000 }]);
    expect(r).toMatchObject({ lowerBinId: 100, upperBinId: 100 });
  });

  it('two equal bins → 5000/5000', () => {
    const r = reanchorShape(0, 0, [
      { binId: 0, amount: 1_000n },
      { binId: 1, amount: 1_000n },
    ]);
    expect(r.weights).toEqual([
      { binId: 0, bps: 5_000 },
      { binId: 1, bps: 5_000 },
    ]);
  });

  it('proportions preserved (3:1 → 7500/2500)', () => {
    const r = reanchorShape(0, 0, [
      { binId: -1, amount: 3_000n },
      { binId: 0, amount: 1_000n },
    ]);
    expect(r.weights).toEqual([
      { binId: -1, bps: 7_500 },
      { binId: 0, bps: 2_500 },
    ]);
  });

  it('re-anchoring: delta = ourActive − leaderActive shifts all bins, shape unchanged', () => {
    // leader active 100, we are at 110 → +10 on each bin; identical proportions.
    const perBin: LeaderBinAmount[] = [
      { binId: 98, amount: 1n },
      { binId: 99, amount: 1n },
      { binId: 100, amount: 2n },
    ];
    const r = reanchorShape(100, 110, perBin);
    expect(r.weights.map((w) => w.binId)).toEqual([108, 109, 110]); // all +10
    expect(r).toMatchObject({ lowerBinId: 108, upperBinId: 110 });
    expect(sumBps(r.weights)).toBe(10_000);
  });

  it('rounding: 3 equal bins → exact sum 10000 (largest remainder)', () => {
    const r = reanchorShape(0, 0, [
      { binId: 0, amount: 1n },
      { binId: 1, amount: 1n },
      { binId: 2, amount: 1n },
    ]);
    expect(sumBps(r.weights)).toBe(10_000); // 3334 + 3333 + 3333
    expect(r.weights.map((w) => w.bps).sort((a, b) => b - a)).toEqual([3_334, 3_333, 3_333]);
  });

  it('distinct remainders: the missing BPS goes to the largest remainder, exact sum 10000', () => {
    // amounts 1,2,3 (total 6) → floors 1666/3333/5000 (=9999); remainders 4/2/0 → +1 to the bin with remainder 4 (the 1st).
    const r = reanchorShape(0, 0, [
      { binId: 0, amount: 1n },
      { binId: 1, amount: 2n },
      { binId: 2, amount: 3n },
    ]);
    expect(r.weights).toEqual([
      { binId: 0, bps: 1_667 },
      { binId: 1, bps: 3_333 },
      { binId: 2, bps: 5_000 },
    ]);
    expect(sumBps(r.weights)).toBe(10_000);
  });

  it('bins with 0 liquidity are ignored', () => {
    const r = reanchorShape(0, 0, [
      { binId: 0, amount: 0n },
      { binId: 1, amount: 1_000n },
    ]);
    expect(r.weights).toEqual([{ binId: 1, bps: 10_000 }]);
  });

  it('no SOL-side liquidity → throw (fail loud)', () => {
    expect(() => reanchorShape(0, 0, [{ binId: 0, amount: 0n }])).toThrow();
    expect(() => reanchorShape(0, 0, [])).toThrow();
  });
});
