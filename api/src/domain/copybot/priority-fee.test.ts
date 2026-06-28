import { describe, expect, it } from 'vitest';
import { TIER_MICRO_LAMPORTS_PER_CU, computeUnitPriceMicroLamports, effectiveMicroPerCu } from './priority-fee';

describe('priority-fee · computeUnitPriceMicroLamports', () => {
  const CU = 200_000; // a typical DLMM tx CU limit
  const CAP = 0.005; // default cap (SOL)

  it('higher tiers map to higher prices when the cap is not binding', () => {
    const low = computeUnitPriceMicroLamports('low', CU, CAP);
    const med = computeUnitPriceMicroLamports('medium', CU, CAP);
    const high = computeUnitPriceMicroLamports('high', CU, CAP);
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
  });

  it('the worst-case fee (price × cuLimit) NEVER exceeds the cap (the cap always wins)', () => {
    // WHY: the cap is the user's hard cost bound — an aggressive tier or a high CU limit must never overspend.
    for (const tier of ['low', 'medium', 'high'] as const) {
      for (const cu of [50_000, 200_000, 1_400_000]) {
        for (const cap of [0.00005, 0.0005, 0.005]) {
          const price = computeUnitPriceMicroLamports(tier, cu, cap);
          const feeLamports = (price * cu) / 1_000_000;
          expect(feeLamports).toBeLessThanOrEqual(cap * 1_000_000_000 + 1); // +1 lamport floor tolerance
        }
      }
    }
  });

  it('a tiny cap clamps even the high tier down', () => {
    // 0.00005 SOL = 50_000 lamports cap; at 1.4M CU the high tier (1M µL/CU) must be clamped well below 1M.
    const price = computeUnitPriceMicroLamports('high', 1_400_000, 0.00005);
    expect(price).toBeLessThan(1_000_000);
    expect((price * 1_400_000) / 1_000_000).toBeLessThanOrEqual(50_000 + 1);
  });

  it('a generous cap leaves the tier price untouched', () => {
    // 0.005 SOL cap at 200k CU does not bind the medium tier → returns the full base price.
    expect(computeUnitPriceMicroLamports('medium', 200_000, 0.005)).toBe(200_000);
  });

  it('returns 0 for a zero CU limit or a zero cap (nothing to set)', () => {
    expect(computeUnitPriceMicroLamports('high', 0, 0.005)).toBe(0);
    expect(computeUnitPriceMicroLamports('high', 200_000, 0)).toBe(0);
  });
});

describe('priority-fee · effectiveMicroPerCu (live oracle floor)', () => {
  it('falls back to the static tier target when no live estimate is given (or it is invalid)', () => {
    // WHY: a dead/absent oracle must never zero the fee — the tier target is the no-oracle behavior, unchanged.
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(effectiveMicroPerCu(tier, null)).toBe(TIER_MICRO_LAMPORTS_PER_CU[tier]);
      expect(effectiveMicroPerCu(tier, 0)).toBe(TIER_MICRO_LAMPORTS_PER_CU[tier]);
      expect(effectiveMicroPerCu(tier, Number.NaN)).toBe(TIER_MICRO_LAMPORTS_PER_CU[tier]);
      expect(effectiveMicroPerCu(tier, -10)).toBe(TIER_MICRO_LAMPORTS_PER_CU[tier]);
    }
  });

  it('the tier is a FLOOR — a live estimate below it never lowers the fee', () => {
    expect(effectiveMicroPerCu('medium', 1_000)).toBe(TIER_MICRO_LAMPORTS_PER_CU.medium);
  });

  it('a live estimate ABOVE the tier raises the fee (congestion never under-pays)', () => {
    const live = TIER_MICRO_LAMPORTS_PER_CU.medium * 3;
    expect(effectiveMicroPerCu('medium', live)).toBe(live);
  });

  it('a raised live estimate is STILL bounded by the hard cap downstream', () => {
    // WHY: the oracle can only raise the pre-cap target — the cap must still clamp the worst-case fee.
    const huge = 50_000_000; // µL/CU well above any tier
    const price = computeUnitPriceMicroLamports('medium', 1_400_000, 0.00005, huge);
    expect((price * 1_400_000) / 1_000_000).toBeLessThanOrEqual(0.00005 * 1_000_000_000 + 1);
  });
});
