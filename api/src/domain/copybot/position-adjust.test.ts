import { describe, expect, it } from 'vitest';
import { type BinSol, type ReshapeOp, type WeightBinShape, fillContiguousWeights, lamportsToSol, planReshape, reshapeToCalls } from './position-adjust';

describe('lamportsToSol', () => {
  it('converts lamports → SOL exactly', () => {
    expect(lamportsToSol(60_000_000n)).toBeCloseTo(0.06, 9);
  });
});

describe('fillContiguousWeights — the SDK by-weight range must be contiguous (no "Discontinuous Bin ID")', () => {
  const w = (binId: number, xBps: number, yBps = 0): WeightBinShape => ({ binId, xBps, yBps });

  it('fills an interior gap with a 0/0 bin (the SOL-only reshape-add bug: bins 0 and 2, gap at 1)', () => {
    expect(fillContiguousWeights([w(0, 5000), w(2, 5000)])).toEqual([w(0, 5000), w(1, 0), w(2, 5000)]);
  });

  it('fills MULTIPLE interior gaps and preserves the real weights', () => {
    expect(fillContiguousWeights([w(-2, 3000), w(1, 7000)])).toEqual([w(-2, 3000), w(-1, 0), w(0, 0), w(1, 7000)]);
  });

  it('keeps the y-leg orientation when filling (token-side weights)', () => {
    expect(fillContiguousWeights([w(0, 0, 4000), w(2, 0, 6000)])).toEqual([w(0, 0, 4000), w(1, 0, 0), w(2, 0, 6000)]);
  });

  it('an already-contiguous list is returned unchanged (ascending)', () => {
    expect(fillContiguousWeights([w(5, 100), w(6, 200), w(7, 300)])).toEqual([w(5, 100), w(6, 200), w(7, 300)]);
  });

  it('sorts an unordered contiguous input ascending by binId', () => {
    expect(fillContiguousWeights([w(7, 300), w(5, 100), w(6, 200)]).map((b) => b.binId)).toEqual([5, 6, 7]);
  });

  it('single bin → itself; empty → empty', () => {
    expect(fillContiguousWeights([w(3, 10000)])).toEqual([w(3, 10000)]);
    expect(fillContiguousWeights([])).toEqual([]);
  });
});

describe('planReshape — SHAPE-EXACT per-bin re-sync (the fix for selective per-bin add/remove)', () => {
  const RATIO = 0.5;
  const MAX = 1.0;
  const DEAD = 0.005;
  const bins = (...xs: Array<[number, number]>): BinSol[] => xs.map(([offset, sol]) => ({ offset, sol }));

  it('ours empty, leader spread over bins → ADD on every bin at factor×leader', () => {
    const ops = planReshape(bins([0, 0.1], [1, 0.1]), [], RATIO, MAX, DEAD);
    expect(ops.map((o) => o.action)).toEqual(['add', 'add']);
    const adds = ops.flatMap((o) => (o.action === 'add' ? [o.addSol] : []));
    expect(adds).toHaveLength(2);
    for (const a of adds) expect(a).toBeCloseTo(0.05, 9);
  });

  it('REGRESSION: leader EMPTIED one bin → remove 100% on THAT bin only (others untouched)', () => {
    // WHY: the size-only planResync would trim every bin uniformly → shape drifts. A selective per-bin leader
    // remove must be mirrored on the exact bin. Leader was [.1,.1,.1] now [.1, 0, .1]; ours = .5× = [.05,.05,.05].
    const ops = planReshape(bins([0, 0.1], [1, 0], [2, 0.1]), bins([0, 0.05], [1, 0.05], [2, 0.05]), RATIO, MAX, DEAD);
    expect(ops).toEqual([{ offset: 1, action: 'remove', bps: 10000 }]);
  });

  it('leader GREW one bin → ADD the difference on that bin only', () => {
    // leader [.1,.3,.1], ours [.05,.05,.05] → target [.05,.15,.05] → add 0.10 on offset 1 only.
    const ops = planReshape(bins([0, 0.1], [1, 0.3], [2, 0.1]), bins([0, 0.05], [1, 0.05], [2, 0.05]), RATIO, MAX, DEAD);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op).toMatchObject({ offset: 1, action: 'add' });
    if (op?.action === 'add') expect(op.addSol).toBeCloseTo(0.1, 9);
  });

  it('a bin WE hold but the leader no longer covers → remove 100% (the leader closed that bin)', () => {
    const ops = planReshape(bins([0, 0.1]), bins([0, 0.05], [5, 0.03]), RATIO, MAX, DEAD);
    expect(ops).toEqual([{ offset: 5, action: 'remove', bps: 10000 }]);
  });

  it('cap: total target never exceeds maxSol — factor scales ALL bins down', () => {
    // leader total 20, ratio 0.5 → 10 > maxSol 1.0 → factor = 1/20 = 0.05 → each .05; sum = 1.0.
    const ops = planReshape(bins([0, 10], [1, 10]), [], RATIO, MAX, DEAD);
    const added = ops.reduce((s, o) => s + (o.action === 'add' ? o.addSol : 0), 0);
    expect(added).toBeCloseTo(1.0, 9);
  });

  it('per-bin wiggle within the deadband → no churn', () => {
    expect(planReshape(bins([0, 0.1]), bins([0, 0.049]), RATIO, MAX, DEAD)).toEqual([]);
  });

  it('alignment is by OFFSET (leader/ours at different active bins, same offsets) → matched, in sync → []', () => {
    expect(planReshape(bins([-1, 0.1], [0, 0.1]), bins([-1, 0.05], [0, 0.05]), RATIO, MAX, DEAD)).toEqual([]);
  });

  it('ratio 0 or leader empty → no ops', () => {
    expect(planReshape(bins([0, 0.1]), [], 0, MAX, DEAD)).toEqual([]);
    expect(planReshape([], bins([0, 0.05]), RATIO, MAX, DEAD)).toEqual([]);
  });
});

describe('reshapeToCalls — per-offset ops → SDK calls at our lower-bin base (minimize txs)', () => {
  const BASE = 100; // our position's lower bin (offset 0 = our lower = leader lower, per the open re-anchor)
  const rm = (offset: number, bps: number): ReshapeOp => ({ offset, action: 'remove', bps });
  const ad = (offset: number, addSol: number): ReshapeOp => ({ offset, action: 'add', addSol });

  it('uniform trim (contiguous bins, same bps) → ONE removeLiquidity range', () => {
    const calls = reshapeToCalls([rm(0, 3000), rm(1, 3000), rm(2, 3000)], BASE);
    expect(calls.removes).toEqual([{ fromBin: 100, toBin: 102, bps: 3000 }]);
    expect(calls.adds).toEqual([]);
  });

  it('selective remove (non-contiguous) → separate ranges', () => {
    const calls = reshapeToCalls([rm(0, 10000), rm(3, 10000)], BASE);
    expect(calls.removes).toEqual([
      { fromBin: 100, toBin: 100, bps: 10000 },
      { fromBin: 103, toBin: 103, bps: 10000 },
    ]);
  });

  it('adjacent bins with DIFFERENT bps → NOT collapsed', () => {
    const calls = reshapeToCalls([rm(0, 3000), rm(1, 5000)], BASE);
    expect(calls.removes).toEqual([
      { fromBin: 100, toBin: 100, bps: 3000 },
      { fromBin: 101, toBin: 101, bps: 5000 },
    ]);
  });

  it('adds map to our binIds (base + offset)', () => {
    const calls = reshapeToCalls([ad(0, 0.05), ad(1, 0.05)], BASE);
    expect(calls.adds).toEqual([
      { binId: 100, addSol: 0.05 },
      { binId: 101, addSol: 0.05 },
    ]);
    expect(calls.removes).toEqual([]);
  });

  it('mixed remove + add in one re-shape', () => {
    const calls = reshapeToCalls([rm(0, 10000), ad(2, 0.1)], BASE);
    expect(calls.removes).toEqual([{ fromBin: 100, toBin: 100, bps: 10000 }]);
    expect(calls.adds).toEqual([{ binId: 102, addSol: 0.1 }]);
  });
});
