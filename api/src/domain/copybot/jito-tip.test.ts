import { describe, expect, it } from 'vitest';
import { CONSERVATIVE_JITO_TIP_LAMPORTS, JITO_TIP_ACCOUNTS, jitoTipLamports, pickJitoTipAccount } from './jito-tip';

describe('jito-tip · jitoTipLamports (within the shared cap)', () => {
  const CAP = 5_000_000; // 0.005 SOL cap

  it('pays the conservative tip when there is ample headroom', () => {
    expect(jitoTipLamports(CAP, 40_000)).toBe(CONSERVATIVE_JITO_TIP_LAMPORTS);
  });

  it('NEVER lets priority + tip exceed the cap (tip clamped to the headroom)', () => {
    // WHY: the cap is the user's hard cost bound — the tip must take only what's left, never push past it.
    for (const prio of [0, 4_960_000, 4_999_999, 5_000_000, 6_000_000]) {
      const tip = jitoTipLamports(CAP, prio);
      expect(prio + tip).toBeLessThanOrEqual(CAP + Math.max(0, prio - CAP)); // tip never adds beyond the cap
      expect(tip).toBeGreaterThanOrEqual(0);
    }
  });

  it('is 0 when the priority fee already used the whole cap (tip starved, not negative)', () => {
    expect(jitoTipLamports(CAP, CAP)).toBe(0);
    expect(jitoTipLamports(CAP, CAP + 1)).toBe(0);
  });

  it('clamps the tip to a thin remaining headroom', () => {
    expect(jitoTipLamports(CAP, CAP - 10_000)).toBe(10_000); // only 10k left → tip = 10k (< conservative)
  });
});

describe('jito-tip · pickJitoTipAccount', () => {
  it('always returns one of the known tip accounts, for any seed (incl. negative)', () => {
    const set = new Set(JITO_TIP_ACCOUNTS.map((a) => a.toBase58()));
    for (const seed of [0, 1, 7, 8, 99, -3]) expect(set.has(pickJitoTipAccount(seed).toBase58())).toBe(true);
  });

  it('rotates across accounts (different seeds hit different accounts)', () => {
    expect(pickJitoTipAccount(0).toBase58()).not.toBe(pickJitoTipAccount(1).toBase58());
  });
});
