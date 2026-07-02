import { describe, expect, it } from 'vitest';
import { type BinSol, type ReshapeOp, type WeightBinShape, chunkBySpan, fillContiguousWeights, lamportsToSol, planReshape, reshapeToCalls } from './position-adjust';

describe('chunkBySpan — split a wide reshape add into ≤maxSpan-bin chunks (each a single-tx deposit)', () => {
  const adds = (...binIds: number[]) => binIds.map((binId) => ({ binId, addSol: 0.01 }));

  it('a narrow add (span ≤ maxSpan) → ONE chunk (unchanged single-tx behaviour)', () => {
    const chunks = chunkBySpan(adds(10, 11, 12, 13, 14), 25);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });

  it('a wide add (span > maxSpan) → split so each chunk spans ≤ maxSpan bins (the SDK 1-tx limit)', () => {
    // WHY: a ≥26-bin by-weight deposit chunks into [pre, main, post] in the SDK → can't be one published tx. Each
    // chunk must span ≤25 bins so its addLiquidityOneSide fits a single tx; together they deposit the full deficit.
    const wide = adds(...Array.from({ length: 40 }, (_, i) => 100 + i)); // 40 contiguous bins (span 40)
    const chunks = chunkBySpan(wide, 25);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.at(-1)!.binId - c[0]!.binId + 1).toBeLessThanOrEqual(25); // every chunk fits one tx
    expect(chunks.flat()).toHaveLength(40); // no bin dropped
  });

  it('span boundary: exactly maxSpan stays one chunk, maxSpan+1 splits (the deposit fills the contiguous range)', () => {
    expect(chunkBySpan(adds(0, 24), 25)).toHaveLength(1); // span 25 = limit → one chunk
    expect(chunkBySpan(adds(0, 25), 25)).toHaveLength(2); // span 26 > limit → split (no off-by-one → no oversized tx)
  });

  it('sparse bins are grouped by span, not count (gaps count toward the span the deposit must fill)', () => {
    // bins 0 and 30 are 31 apart → can't share a ≤25-span chunk even though there are only 2.
    expect(chunkBySpan(adds(0, 30), 25)).toHaveLength(2);
  });

  it('sorts by binId before chunking (unordered input is handled)', () => {
    const chunks = chunkBySpan(adds(30, 0, 10), 25);
    expect(chunks[0]![0]!.binId).toBe(0); // chunk 1 = {0,10} (span 11), chunk 2 = {30}
    expect(chunks).toHaveLength(2);
  });
});

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

  it('a trim that passes the deadband but rounds to 0 bps → NO remove op (a bps-0 removeLiquidity is a wasted no-op tx)', () => {
    // WHY: on the two-sided TOKEN leg `cur` is huge, so a delta above the deadband can still be a negligible fraction:
    // round((-delta/cur)×10000) = 0. Pushing that bin emits an on-chain removeLiquidity(_, _, 0) — a no-op that burns a
    // fee + priority fee + head-of-line-blocks the serial coffre, while the reshape converges without it. Meanwhile a
    // genuine trim on another bin must still produce its op. Here offset 0: target 1000, cur 1000.01 → delta −0.01
    // (> deadband) but (0.01/1000.01)×10000 ≈ 0.1 → rounds to 0. offset 1 is a real 50% trim.
    const ops = planReshape(bins([0, 1000], [1, 0.1]), bins([0, 1000.01], [1, 0.2]), 1, 2000, DEAD);
    expect(ops).toEqual([{ offset: 1, action: 'remove', bps: 5000 }]);
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

  it('near-uniform bps (per-bin rounding jitter) → coalesced into ONE range (fixes the per-bin-tx explosion on wide memecoin positions)', () => {
    // A uniform ~50% leader trim: planReshape rounds (-delta/cur)×10000 per bin → 4999/5000/5001 jitter. Strict
    // equality used to emit ONE removeLiquidity PER BIN (≈8 txs on a 17-bin bidask position). They must now merge.
    const calls = reshapeToCalls([rm(0, 5001), rm(1, 4999), rm(2, 5000), rm(3, 5001)], BASE);
    expect(calls.removes).toEqual([{ fromBin: 100, toBin: 103, bps: 5000 }]); // midpoint of [4999,5001] = 5000
  });

  it('bps differing BEYOND the tolerance → still split (a genuine selective trim is preserved, not blurred away)', () => {
    const calls = reshapeToCalls([rm(0, 5000), rm(1, 5025)], BASE); // 25 bps apart > 20 tol
    expect(calls.removes).toEqual([
      { fromBin: 100, toBin: 100, bps: 5000 },
      { fromBin: 101, toBin: 101, bps: 5025 },
    ]);
  });

  it('a slowly-drifting gradient splits when the RUN spread (not the step) exceeds the tolerance', () => {
    // 5000→5015 merges (spread 15 ≤ 20); adding 5030 would make the run span 30 > 20 → it starts a new range.
    const calls = reshapeToCalls([rm(0, 5000), rm(1, 5015), rm(2, 5030)], BASE);
    expect(calls.removes).toEqual([
      { fromBin: 100, toBin: 101, bps: 5008 }, // midpoint of [5000,5015] = 5007.5 → 5008
      { fromBin: 102, toBin: 102, bps: 5030 },
    ]);
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
