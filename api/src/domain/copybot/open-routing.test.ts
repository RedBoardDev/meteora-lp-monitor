import { describe, expect, it } from 'vitest';
import dlmmIdl from '@/infrastructure/solana/dlmm/dlmm-idl.json';
import { ATOMIC_BY_WEIGHT_BIN_LIMIT, isWideOpen, MAX_SINGLE_POSITION_BINS } from './open-routing';

describe('isWideOpen — when an open must be sequenced (create → deposit) vs the atomic single-tx open', () => {
  // WHY: the atomic by-weight open chunks at 26 bins and the deposit is NOT the first chunk — publishing only the
  // first tx (the historical empty-position bug) creates a position with no liquidity. The boundary must be exact.
  it('narrow open (< 26 bins) → atomic single tx (not wide)', () => {
    expect(isWideOpen(1)).toBe(false);
    expect(isWideOpen(15)).toBe(false);
    expect(isWideOpen(25)).toBe(false);
  });

  it('boundary at the SDK chunk limit: 25 stays atomic, 26 must be sequenced (no off-by-one → no silent empty position)', () => {
    expect(isWideOpen(ATOMIC_BY_WEIGHT_BIN_LIMIT - 1)).toBe(false);
    expect(isWideOpen(ATOMIC_BY_WEIGHT_BIN_LIMIT)).toBe(true);
  });

  it('wide open (≥ 26 bins) → sequenced', () => {
    expect(isWideOpen(26)).toBe(true);
    expect(isWideOpen(50)).toBe(true);
    expect(isWideOpen(70)).toBe(true);
  });
});

describe('SDK-drift lock — our hardcoded DLMM limits must not silently diverge from the SDK/program', () => {
  // WHY: `open-routing.ts` duplicates two @meteora-ag/dlmm limits. If a future SDK/program upgrade changes them,
  // our chunking/routing would mis-behave with no signal. `assertSdkConstants()` in dlmm-tx-builder.ts throws at
  // bundle load on the SDK side (import-only, not testable here). This locks the side we CAN read statically in
  // CI: the bundled program IDL, which is the SDK's own source-of-truth for DEFAULT_BIN_PER_POSITION.
  const idlConstants = (dlmmIdl as { constants: { name: string; value: string }[] }).constants;

  it('70-bin single-position limit matches the IDL DEFAULT_BIN_PER_POSITION constant', () => {
    const c = idlConstants.find((k) => k.name === 'DEFAULT_BIN_PER_POSITION');
    expect(c, 'DEFAULT_BIN_PER_POSITION missing from the bundled DLMM IDL').toBeDefined();
    expect(Number(c?.value)).toBe(MAX_SINGLE_POSITION_BINS);
  });

  it('26-bin atomic single-tx limit is pinned (SDK MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX)', () => {
    // Not an IDL constant — it lives only in the SDK code, so the runtime `assertSdkConstants()` guard covers the
    // SDK side. Here we pin the value we routed against so a stray edit to open-routing fails CI.
    expect(ATOMIC_BY_WEIGHT_BIN_LIMIT).toBe(26);
  });
});
