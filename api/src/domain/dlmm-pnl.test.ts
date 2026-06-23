import { describe, expect, it } from 'vitest';
import type { DlmmLeg, PoolMeta } from './dlmm';
import {
  binPriceRaw,
  legValueSol,
  openUnrealizedPnlSol,
  positionEconomics,
  solSideOf,
} from './dlmm-pnl';

const SOL = 'So11111111111111111111111111111111111111112';
const leg = (
  kind: DlmmLeg['kind'],
  activeBinId: number,
  amountX: bigint,
  amountY: bigint,
): DlmmLeg => ({
  kind,
  activeBinId,
  amountX,
  amountY,
  signature: '',
  blockTime: 0,
  position: '',
  lbPair: '',
});

describe('binPriceRaw', () => {
  it('is 1.0 at bin 0 (price reference) and geometric in binId', () => {
    expect(binPriceRaw(0, 100)).toBe(1);
    expect(binPriceRaw(1, 100)).toBeCloseTo(1.01, 10); // +binStep/10000
    expect(binPriceRaw(-1, 100)).toBeCloseTo(1 / 1.01, 10);
  });
});

describe('solSideOf', () => {
  it('detects which side is SOL, or null for a non-SOL-quote pool', () => {
    expect(solSideOf('Memecoin111', SOL)).toBe('Y');
    expect(solSideOf(SOL, 'Memecoin111')).toBe('X');
    expect(solSideOf('Usdc111', 'Memecoin111')).toBeNull();
  });
});

describe('positionPnlSol — validated against Meteora on real on-chain data', () => {
  // GYMtBiHX4MCa (SOTER-like / SOL pool, binStep 100): the exact raw amounts + active bins decoded
  // from chain. Meteora's own pnl for this position is 0.2415 SOL — the bin-price reconstruction must
  // reproduce it to the cent. This is the test that proves the decoupled valuation is correct.
  const meta: PoolMeta = { binStep: 100, solSide: 'Y' };
  const legs: DlmmLeg[] = [
    leg('deposit', -437, 205945537665n, 3376692725n),
    leg('withdraw', -429, 156784710127n, 4039260423n),
    leg('claim', -429, 0n, 46620648n),
  ];

  it('reproduces Meteora pnl 0.2415 to the cent', () => {
    expect(positionEconomics(legs, meta).pnlSol).toBeCloseTo(0.2415, 3);
  });

  it('values the deposit leg = Meteora deposit_sol 6.0393', () => {
    expect(legValueSol(legs[0]!, meta)).toBeCloseTo(6.0393, 3);
  });

  it('values the withdraw leg = Meteora withdraw_sol 6.2343', () => {
    expect(legValueSol(legs[1]!, meta)).toBeCloseTo(6.2343, 3);
  });

  it('splits economics into deposit / withdraw / claimed-fees that reconcile to the validated pnl', () => {
    const e = positionEconomics(legs, meta);
    expect(e.depositSol).toBeCloseTo(6.0393, 3);
    expect(e.withdrawSol).toBeCloseTo(6.2343, 3);
    expect(e.claimedFeesSol).toBeCloseTo(0.0466, 3); // claimed fees are split OUT of withdrawals
    // the split must reconcile to the on-chain-validated total — fees never double-counted into withdraw
    expect(e.withdrawSol + e.claimedFeesSol - e.depositSol).toBeCloseTo(e.pnlSol, 9);
    expect(e.pnlSol).toBeCloseTo(0.2415, 3);
  });
});

describe('positionPnlSol — orientation + direction', () => {
  it('sums withdrawals + claims minus deposits', () => {
    const meta: PoolMeta = { binStep: 100, solSide: 'Y' };
    // deposit 1 SOL (all Y), withdraw 1.5 SOL (all Y), claim 0.1 SOL → +0.6
    const legs = [
      leg('deposit', 0, 0n, 1_000_000_000n),
      leg('withdraw', 0, 0n, 1_500_000_000n),
      leg('claim', 0, 0n, 100_000_000n),
    ];
    expect(positionEconomics(legs, meta).pnlSol).toBeCloseTo(0.6, 9);
  });

  it('values the non-SOL leg via price for a SOL-as-X pool (inverted)', () => {
    const meta: PoolMeta = { binStep: 100, solSide: 'X' };
    // bin 0 → price 1; X=SOL leg counts directly, Y leg divided by price.
    const v = legValueSol(leg('deposit', 0, 2_000_000_000n, 5_000_000_000n), meta);
    expect(v).toBeCloseTo(7, 9); // (2e9 + 5e9/1) / 1e9
  });
});

describe('openUnrealizedPnlSol — open = snapshot ⊕ legs', () => {
  it('equals realized PnL when nothing is left in the position (live = 0)', () => {
    // a fully-withdrawn position must reconcile to its realized economics, not double-count
    const econ = { depositSol: 6.0393, withdrawSol: 6.2343, claimedFeesSol: 0.0466 };
    expect(openUnrealizedPnlSol(econ, { sizeSol: 0, unclaimedFeesSol: 0 })).toBeCloseTo(0.2416, 4);
  });

  it('adds live liquidity + unclaimed fees on top of the cost basis', () => {
    // deposited 6, nothing withdrawn/claimed yet, 6.5 still in pool + 0.1 unclaimed → +0.6
    const econ = { depositSol: 6, withdrawSol: 0, claimedFeesSol: 0 };
    expect(openUnrealizedPnlSol(econ, { sizeSol: 6.5, unclaimedFeesSol: 0.1 })).toBeCloseTo(0.6, 9);
  });

  it('combines partial withdrawals, claims, live size and unclaimed fees', () => {
    // 4 + 0.2 + 7 + 0.3 − 10 = 1.5
    const econ = { depositSol: 10, withdrawSol: 4, claimedFeesSol: 0.2 };
    expect(openUnrealizedPnlSol(econ, { sizeSol: 7, unclaimedFeesSol: 0.3 })).toBeCloseTo(1.5, 9);
  });
});
