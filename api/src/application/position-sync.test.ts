import { type RangeStatus, SOL_MINT, type StrategyFamily } from '@binsight/shared';
import { describe, expect, it } from 'vitest';
import type { OnchainPositionValue } from '@/domain/dlmm';
import type { PositionPnl } from './dlmm-position-pnl';
import {
  buildPositionRows,
  type LivePositionValue,
  snapshotToLive,
  type TokenMetaResolver,
} from './position-sync';

const meta: TokenMetaResolver = (mint) =>
  mint === SOL_MINT ? { symbol: 'SOL' } : { symbol: 'MEME', icon: 'http://icon' };

const proj = (over: Partial<PositionPnl>): PositionPnl => ({
  position: 'pos1',
  pool: 'pool1',
  pnlSol: 0,
  depositSol: 0,
  withdrawSol: 0,
  claimedFeesSol: 0,
  legs: 1,
  tokenMint: 'MEMEmint',
  solDenominated: true,
  openedAt: 1000,
  closedAt: 2000,
  durationSeconds: 1,
  ...over,
});

const live = (over: Partial<LivePositionValue>): LivePositionValue => ({
  sizeSol: 0,
  unclaimedFeesSol: 0,
  minPrice: 0,
  maxPrice: 0,
  poolPrice: 0,
  rangeStatus: 'in',
  ...over,
});

const base = { wallet: 'W', strategy: new Map<string, StrategyFamily | null>(), now: 9999 };

describe('buildPositionRows — membership in the snapshot decides open vs closed', () => {
  it('emits a CLOSED row (realized economics) for a position absent from the live snapshot', () => {
    const p = proj({
      position: 'c1',
      pnlSol: 0.2415,
      depositSol: 6.0393,
      withdrawSol: 6.2343,
      claimedFeesSol: 0.0466,
      openedAt: 1000,
      closedAt: 3_601_000,
      durationSeconds: 3600,
    });
    const { open, closed } = buildPositionRows({
      ...base,
      projection: [p],
      live: new Map(),
      meta,
      priorOorSince: new Map(),
    });
    expect(open).toHaveLength(0);
    expect(closed).toHaveLength(1);
    const c = closed[0]!;
    expect(c.pnlSol).toBeCloseTo(0.2415, 6);
    expect(c.depositSol).toBeCloseTo(6.0393, 6);
    expect(c.withdrawSol).toBeCloseTo(6.2343, 6);
    expect(c.feesSol).toBeCloseTo(0.0466, 6); // claimed fees -> feesSol
    expect(c.pnlPctSol).toBeCloseTo((0.2415 / 6.0393) * 100, 4);
    expect(c.tokenX).toBe('MEME');
    expect(c.tokenY).toBe('SOL');
    expect(c.tokenXMint).toBe('MEMEmint');
    expect(c.closedAt).toBe(3_601_000);
    expect(c.durationSeconds).toBe(3600);
    expect(c.pnlSource).toBe('pool');
  });

  it('emits an OPEN row (snapshot ⊕ legs) for a position present in the live snapshot', () => {
    const p = proj({
      position: 'o1',
      depositSol: 6,
      withdrawSol: 0,
      claimedFeesSol: 0,
      openedAt: 500,
    });
    const { open, closed } = buildPositionRows({
      ...base,
      projection: [p],
      live: new Map([
        [
          'o1',
          live({
            sizeSol: 6.5,
            unclaimedFeesSol: 0.1,
            minPrice: 0.9,
            maxPrice: 1.1,
            poolPrice: 1.0,
          }),
        ],
      ]),
      meta,
      priorOorSince: new Map(),
    });
    expect(closed).toHaveLength(0);
    const o = open[0]!;
    expect(o.sizeSol).toBe(6.5);
    expect(o.pnlSol).toBeCloseTo(0.6, 9); // 0 + 0 + 6.5 + 0.1 − 6
    expect(o.claimedFeesSol).toBe(0);
    expect(o.unclaimedFeesSol).toBe(0.1);
    expect(o.rangeStatus).toBe('in');
    expect(o.minPrice).toBe(0.9);
    expect(o.maxPrice).toBe(1.1);
    expect(o.poolPrice).toBe(1.0);
    expect(o.outOfRangeSince).toBeNull();
    expect(o.openedAt).toBe(500);
    expect(o.pnlPctSol).toBeCloseTo((0.6 / 6) * 100, 6);
    expect(o.updatedAt).toBe(9999);
  });
});

describe('buildPositionRows — out-of-range clock is preserved across syncs', () => {
  const outLive = new Map([['o1', live({ sizeSol: 1, rangeStatus: 'out_up' as RangeStatus })]]);

  it('starts the OOR clock at now when freshly out of range', () => {
    const r = buildPositionRows({
      ...base,
      now: 5000,
      projection: [proj({ position: 'o1' })],
      live: outLive,
      meta,
      priorOorSince: new Map(),
    });
    expect(r.open[0]!.outOfRangeSince).toBe(5000);
  });

  it('keeps the prior OOR timestamp when still out of range (no reset)', () => {
    const r = buildPositionRows({
      ...base,
      now: 5000,
      projection: [proj({ position: 'o1' })],
      live: outLive,
      meta,
      priorOorSince: new Map([['o1', 1234]]),
    });
    expect(r.open[0]!.outOfRangeSince).toBe(1234);
  });

  it('clears the OOR clock when back in range', () => {
    const r = buildPositionRows({
      ...base,
      projection: [proj({ position: 'o1' })],
      live: new Map([['o1', live({ rangeStatus: 'in' })]]),
      meta,
      priorOorSince: new Map([['o1', 1234]]),
    });
    expect(r.open[0]!.outOfRangeSince).toBeNull();
  });
});

describe('buildPositionRows — robustness', () => {
  it('surfaces a non-SOL-quote position (flagged) rather than dropping it', () => {
    const p = proj({
      position: 'n1',
      solDenominated: false,
      pnlSol: 0,
      depositSol: 0,
      tokenMint: 'XmintBase',
    });
    const r = buildPositionRows({
      ...base,
      projection: [p],
      live: new Map(),
      meta,
      priorOorSince: new Map(),
    });
    expect(r.closed).toHaveLength(1);
    const c = r.closed[0]!;
    expect(c.tokenY).toBe('?'); // quote not reconstructed for a non-SOL pool — honest, not a SOL label
    expect(c.pnlSol).toBe(0);
  });

  it('maps the decoded strategy onto the row', () => {
    const r = buildPositionRows({
      ...base,
      strategy: new Map([['s1', 'Curve']]),
      projection: [proj({ position: 's1' })],
      live: new Map(),
      meta,
      priorOorSince: new Map(),
    });
    expect(r.closed[0]!.strategy).toBe('Curve');
  });
});

describe('snapshotToLive — on-chain range prices match the Meteora SDK convention', () => {
  const opv = (over: Partial<OnchainPositionValue>): OnchainPositionValue => ({
    positionAddress: 'p',
    lbPair: 'lb',
    tokenXMint: 'X',
    tokenYMint: SOL_MINT,
    amountX: 0n,
    amountY: 0n,
    feeX: 0n,
    feeY: 0n,
    decimalsX: 6,
    decimalsY: 9,
    activeId: 0,
    binStep: 100,
    lowerBinId: -10,
    upperBinId: 10,
    lamports: 0n,
    ...over,
  });

  it('prices = binPrice × 10^(decX−decY); active inside the band → in range; pulls size/fees from the valuation', () => {
    const live = snapshotToLive([opv({ positionAddress: 'p1' })], {
      sizeSolByPosition: new Map([['p1', 6.5]]),
      feeSolByPosition: new Map([['p1', 0.1]]),
    });
    const v = live.get('p1')!;
    expect(v.poolPrice).toBeCloseTo(1e-3, 12); // 1.01^0 × 10^(6−9)
    expect(v.minPrice).toBeCloseTo(1.01 ** -10 * 1e-3, 12);
    expect(v.maxPrice).toBeCloseTo(1.01 ** 10 * 1e-3, 12);
    expect(v.rangeStatus).toBe('in');
    expect(v.sizeSol).toBe(6.5);
    expect(v.unclaimedFeesSol).toBe(0.1);
  });

  it('classifies out_up when the active bin is above the upper bound', () => {
    const live = snapshotToLive([opv({ positionAddress: 'p2', activeId: 20 })], {
      sizeSolByPosition: new Map(),
      feeSolByPosition: new Map(),
    });
    const v = live.get('p2')!;
    expect(v.rangeStatus).toBe('out_up');
    expect(v.sizeSol).toBe(0); // absent from the valuation map → 0, never undefined
  });
});
