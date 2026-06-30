/**
 * Copy-bot · observability — `resolveLegacyReason` (the P1 shim's reason→code mapping). These tests encode the
 * WHY: the shim back-fills the `code` column from the verbatim journaled `reason`, and that mapping MUST be the
 * same deterministic rule the registry test (`codes.test.ts`) locks — alias map first, else the unique
 * `namespace.<reason>` leaf, else the deterministic fallback. A drift here would mis-bucket (or drop the code of)
 * a journaled event during the cutover.
 */
import { describe, expect, it } from 'vitest';
import { CODE_REGISTRY, FALLBACK_CODE, resolveLegacyReason } from './codes';

describe('resolveLegacyReason · alias map (SPEC §2.3)', () => {
  it('resolves a legacy alias to its canonical leaf', () => {
    expect(resolveLegacyReason('leader_closed')).toBe('failsafe.activated');
    expect(resolveLegacyReason('orphan')).toBe('failsafe.orphan_closed');
    expect(resolveLegacyReason('non_sol_pool')).toBe('eligibility.non_sol_paired');
    expect(resolveLegacyReason('insufficient_balance')).toBe('balance.insufficient');
    expect(resolveLegacyReason('wallb:foreign_sol_destination')).toBe('wallb.foreign_sol_destination');
  });
});

describe('resolveLegacyReason · verbatim leaf (no alias needed)', () => {
  it('resolves a reason that already IS a leaf suffix to its single namespaced code', () => {
    expect(resolveLegacyReason('below_min_market_cap')).toBe('filter.below_min_market_cap');
    expect(resolveLegacyReason('max_open_positions')).toBe('cap.max_open_positions');
    expect(resolveLegacyReason('below_min_floor')).toBe('sizing.below_min_floor');
    // A two-segment leaf suffix still resolves uniquely.
    expect(resolveLegacyReason('failed_after_retries')).toBe('swap.failed_after_retries');
  });
});

describe('resolveLegacyReason · unmapped + empty (the fallback contract)', () => {
  it('returns undefined for a reason that maps to no leaf (the shim then uses FALLBACK_CODE)', () => {
    // Real producer reasons that have no typed leaf yet (P2 will give them precise codes).
    expect(resolveLegacyReason('build_error')).toBeUndefined();
    expect(resolveLegacyReason('wall_b_reject')).toBeUndefined();
    expect(resolveLegacyReason('sign_land_failed')).toBeUndefined();
  });

  it('returns undefined for an absent/empty reason (progress-outcome rows carry no reason)', () => {
    expect(resolveLegacyReason(undefined)).toBeUndefined();
    expect(resolveLegacyReason('')).toBeUndefined();
  });

  it('FALLBACK_CODE is a real internal, non-pinned code (an unmapped reason never reaches the user feed)', () => {
    const meta = CODE_REGISTRY[FALLBACK_CODE];
    expect(meta).toBeTruthy();
    expect(meta.audience).toBe('internal');
    expect(meta.pinned ?? false).toBe(false);
  });
});
