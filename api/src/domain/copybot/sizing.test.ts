import { describe, expect, it } from 'vitest';
import { type SizingConfig, coreRatioMaxSizingBrick, computeCopySize } from './sizing';

// Spec "preset" defaults (06 §1.1/§1.8): ratio 50%, max 1.0, floor 0.05, reserve 0.05, skip by default.
const base = (over: Partial<SizingConfig> = {}): SizingConfig => ({
  tradeRatioPct: 50,
  maxTradeSizeSol: 1.0,
  minPositionSizeSol: 0.05,
  solReserveSol: 0.05,
  onInsufficient: 'skip',
  ...over,
});
// Large default balance to isolate the ratio/cap logic from the balance check.
const flush = { availableBalanceSol: 1000 };

describe('computeCopySize — the copy size (P2.2, the heart)', () => {
  // The spec's own numeric example (04 §2.1) — exact parity = the strongest guarantee.
  describe('parity with the spec example (04 §2.1: ratio 50% + cap 1 SOL)', () => {
    it('leader 2 SOL ⇒ open 1 SOL (50%×2 = 1, = cap)', () => {
      const d = computeCopySize(base(), 2, flush);
      expect(d).toMatchObject({ action: 'open', reduced: false });
      if (d.action === 'open') expect(d.sizeSol).toBeCloseTo(1, 9);
    });
    it('leader 0.5 SOL ⇒ open 0.25 SOL (50%×0.5, below the cap)', () => {
      const d = computeCopySize(base(), 0.5, flush);
      if (d.action === 'open') expect(d.sizeSol).toBeCloseTo(0.25, 9);
      else throw new Error('expected open');
    });
    it('empty ratio + cap 1 SOL ⇒ always 1 SOL (fixed-size mode), whatever the leader size', () => {
      expect(computeCopySize(base({ tradeRatioPct: null }), 0.001, flush)).toMatchObject({
        action: 'open',
        sizeSol: 1,
      });
      expect(computeCopySize(base({ tradeRatioPct: null }), 999, flush)).toMatchObject({
        action: 'open',
        sizeSol: 1,
      });
    });
  });

  it('a ratio > 100% is allowed (no clamping to 100%)', () => {
    // WHY: the spec explicitly allows a ratio above 100% (Valhalla 120%).
    const d = computeCopySize(base({ tradeRatioPct: 120, maxTradeSizeSol: 5 }), 1, flush);
    if (d.action === 'open') expect(d.sizeSol).toBeCloseTo(1.2, 9);
    else throw new Error('expected open');
  });

  it('the maxTradeSizeSol cap is ALWAYS applied last', () => {
    // WHY: 50%×10 = 5 SOL, but the hard cap brings it back to 1 SOL — protects whatever the ratio/leader.
    const d = computeCopySize(base({ maxTradeSizeSol: 1 }), 10, flush);
    if (d.action === 'open') expect(d.sizeSol).toBeCloseTo(1, 9);
    else throw new Error('expected open');
  });

  describe('anti-dust floor (0.05)', () => {
    it('desired size below the floor ⇒ skip below_min_floor (never a dust position)', () => {
      // ratio 100 × 0.04 = 0.04 < 0.05 (×1 avoids any float drift at the floor).
      expect(computeCopySize(base({ tradeRatioPct: 100 }), 0.04, flush)).toEqual({
        action: 'skip',
        reason: 'below_min_floor',
      });
    });
    it('desired size exactly at the floor ⇒ open (bound included)', () => {
      const d = computeCopySize(base({ tradeRatioPct: 100 }), 0.05, flush);
      expect(d.action).toBe('open');
      if (d.action === 'open') expect(d.sizeSol).toBeCloseTo(0.05, 9);
    });
  });

  describe('insufficient balance', () => {
    it("'skip' mode (default) ⇒ skip insufficient_balance", () => {
      // wants 1 SOL, available = 0.5 − 0.05 reserve = 0.45 < 1 → abstain.
      expect(computeCopySize(base(), 2, { availableBalanceSol: 0.5 })).toEqual({
        action: 'skip',
        reason: 'insufficient_balance',
      });
    });
    it("'reduceToFit' mode ⇒ open with the available amount (balance − reserve), reduced=true", () => {
      // WHY: reduceToFit deploys what remains after the gas reserve rather than missing the copy.
      const d = computeCopySize(base({ onInsufficient: 'reduceToFit' }), 2, { availableBalanceSol: 0.5 });
      expect(d).toMatchObject({ action: 'open', reduced: true });
      if (d.action === 'open') expect(d.sizeSol).toBeCloseTo(0.45, 9); // 0.5 − 0.05
    });
    it("'reduceToFit' but the available is below the floor ⇒ skip insufficient_balance (re-checked at the floor)", () => {
      // available = 0.06 − 0.05 = 0.01 < 0.05 → we do not open dust even under reduceToFit.
      expect(
        computeCopySize(base({ onInsufficient: 'reduceToFit' }), 2, { availableBalanceSol: 0.06 }),
      ).toEqual({ action: 'skip', reason: 'insufficient_balance' });
    });
    it('the gas reserve is indeed subtracted (bound: balance = desired size + reserve ⇒ opens exactly, not reduced)', () => {
      // wants 1 SOL, balance 1.05, reserve 0.05 → available 1.0 = desired → open 1.0 reduced=false.
      const d = computeCopySize(base({ tradeRatioPct: null }), 0, { availableBalanceSol: 1.05 });
      expect(d).toMatchObject({ action: 'open', reduced: false });
      if (d.action === 'open') expect(d.sizeSol).toBeCloseTo(1.0, 9);
    });
  });

  it('the coreRatioMax brick exposes the right metadata and delegates to computeCopySize', () => {
    // Seed of the "registration test" (spec 15 §3): declared shape + scope, and size() == the pure function.
    expect(coreRatioMaxSizingBrick).toMatchObject({
      id: 'coreRatioMax',
      family: 'sizing',
      scope: 'per-leader',
      speedClass: 'instant',
      defaultEnabled: true,
    });
    const cfg = base();
    expect(coreRatioMaxSizingBrick.size(cfg, 2, flush)).toEqual(computeCopySize(cfg, 2, flush));
  });
});
