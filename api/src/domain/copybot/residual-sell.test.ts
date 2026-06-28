import { describe, expect, it } from 'vitest';
import { decideResidualSell, minOutWithSlippage, planWalletSweep } from './residual-sell';

const WSOL = 'So11111111111111111111111111111111111111112';

describe('decideResidualSell — skip dust, sell real residual', () => {
  it('zero balance → no_residual (nothing to swap)', () => {
    expect(decideResidualSell(0n, 1_000n)).toEqual({ sell: false, reason: 'no_residual' });
  });

  it('balance at or below the dust threshold → dust (a tiny swap would fail/cost more than it returns)', () => {
    expect(decideResidualSell(1_000n, 1_000n)).toEqual({ sell: false, reason: 'dust' });
    expect(decideResidualSell(999n, 1_000n)).toEqual({ sell: false, reason: 'dust' });
  });

  it('balance above the dust threshold → sell', () => {
    expect(decideResidualSell(1_001n, 1_000n)).toEqual({ sell: true });
  });

  it('any positive residual with a zero dust threshold → sell', () => {
    expect(decideResidualSell(1n, 0n)).toEqual({ sell: true });
  });
});

describe('minOutWithSlippage — slippage floor (never sell into a terrible route)', () => {
  it('0 bps slippage → exactly the quoted output', () => {
    expect(minOutWithSlippage(1_000_000n, 0)).toBe(1_000_000n);
  });

  it('50 bps (0.5%) → quoted × 0.995', () => {
    // WHY: the landed swap must return at least this much SOL or it reverts — bounds MEV/bad routes.
    expect(minOutWithSlippage(1_000_000n, 50)).toBe(995_000n);
  });

  it('100 bps (1%) → quoted × 0.99, floor division (no rounding up)', () => {
    expect(minOutWithSlippage(101n, 100)).toBe(99n); // 101*9900/10000 = 99.99 → 99
  });

  it('negative slippage is rejected (programming error, fail loud)', () => {
    expect(() => minOutWithSlippage(1n, -1)).toThrow();
  });

  it('slippage >= 100% is rejected — a 0/negative floor would accept a near-total drain (fail loud, not silent)', () => {
    // WHY: at 10000 bps the floor is 0 (accepts ANY output); above it the floor goes negative (always passes). A
    // fat-finger config >= 100% must crash, not silently disable the protection this module exists for.
    expect(() => minOutWithSlippage(1_000_000n, 10_000)).toThrow();
    expect(() => minOutWithSlippage(1_000_000n, 10_001)).toThrow();
    expect(minOutWithSlippage(1_000_000n, 9_999)).toBeGreaterThan(0n); // 99.99% slippage still keeps a positive floor
  });
});

describe('planWalletSweep — no-miss safety net: every non-SOL token above dust gets swept', () => {
  it('sweeps a real non-SOL token (the dormant-balance bug this prevents)', () => {
    expect(planWalletSweep([{ mint: 'TOKEN', amountRaw: 6_217n }], WSOL, 100n)).toEqual([{ mint: 'TOKEN', amountRaw: 6_217n }]);
  });

  it('skips wSOL — it is SOL already, swapping it would be circular', () => {
    expect(planWalletSweep([{ mint: WSOL, amountRaw: 1_000_000n }], WSOL, 100n)).toEqual([]);
  });

  it('skips dust below the threshold but keeps everything real', () => {
    expect(planWalletSweep([{ mint: 'A', amountRaw: 50n }, { mint: 'B', amountRaw: 5_000n }], WSOL, 100n)).toEqual([{ mint: 'B', amountRaw: 5_000n }]);
  });

  it('sweeps mixed classic + Token-2022 legs together (both must be caught — Token-2022 was the missed class)', () => {
    const balances = [{ mint: 'CLASSIC', amountRaw: 1_000n }, { mint: 'TOKEN2022', amountRaw: 2_000n }];
    expect(planWalletSweep(balances, WSOL, 100n)).toEqual(balances);
  });

  it('empty wallet → nothing to sweep', () => {
    expect(planWalletSweep([], WSOL, 100n)).toEqual([]);
  });
});
