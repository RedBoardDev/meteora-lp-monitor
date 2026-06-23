import { SOL_MINT } from '@binsight/shared';
import { describe, expect, it } from 'vitest';
import type { OnchainPositionValue, OnchainWalletSnapshot } from './dlmm';
import { valueSnapshot } from './snapshot-valuation';

const posv = (over: Partial<OnchainPositionValue> = {}): OnchainPositionValue => ({
  positionAddress: 'p',
  lbPair: 'lb',
  tokenXMint: 'MEME',
  tokenYMint: SOL_MINT,
  amountX: 0n,
  amountY: 0n,
  feeX: 0n,
  feeY: 0n,
  decimalsX: 6,
  decimalsY: 9,
  activeId: 0,
  binStep: 100,
  lowerBinId: 0,
  upperBinId: 0,
  lamports: 0n,
  ...over,
});

const snap = (
  positions: OnchainPositionValue[],
  over: Partial<OnchainWalletSnapshot> = {},
): OnchainWalletSnapshot => ({
  owner: 'w',
  slot: 1,
  slotSkew: 0,
  nativeLamports: 0n,
  idleTokens: [],
  positions,
  complete: true,
  ...over,
});

describe('valueSnapshot', () => {
  it('values the non-SOL side via the on-chain pool price when Jupiter has no quote (correct decimals)', () => {
    // 1.0 MEME (decimalsX 6) at activeId 0 → pool price = 10^(decX−decY) = 10^(6−9) = 0.001 SOL/MEME.
    const s = valueSnapshot(snap([posv({ amountX: 1_000_000n })]), new Map());
    expect(s.tvlSol).toBeCloseTo(0.001, 6);
    // Regression guard: the old fallback used 10^(decY−decX) and blew this up to ~1000 SOL (a real bug
    // that pushed one wallet's TVL to 202M SOL until fixed).
    expect(s.tvlSol).toBeLessThan(1);
  });

  it('uses the Jupiter SOL price for the non-SOL side when available', () => {
    const s = valueSnapshot(snap([posv({ amountX: 1_000_000n })]), new Map([['MEME', 0.5]]));
    expect(s.tvlSol).toBeCloseTo(0.5, 6); // 1.0 MEME × 0.5 SOL
  });

  it('walletTotal = tvl + idle + unclaimed fees + locked rent ("tout inclus")', () => {
    const s = valueSnapshot(
      snap([posv({ amountY: 5_000_000_000n, feeY: 100_000_000n, lamports: 57_000_000n })], {
        nativeLamports: 2_000_000_000n,
      }),
      new Map(),
    );
    expect(s.tvlSol).toBeCloseTo(5, 6);
    expect(s.idleSol).toBeCloseTo(2, 6);
    expect(s.unclaimedFeesSol).toBeCloseTo(0.1, 6);
    expect(s.lockedRentSol).toBeCloseTo(0.057, 6);
    expect(s.walletTotalSol).toBeCloseTo(7.157, 6);
    expect(s.sizeSolByPosition.get('p')).toBeCloseTo(5, 6);
  });

  it('counts idle stablecoin ATAs via their Jupiter SOL price', () => {
    const s = valueSnapshot(
      snap([], { idleTokens: [{ mint: 'USDC', amount: 100_000_000n, decimals: 6 }] }),
      new Map([['USDC', 0.015]]),
    );
    expect(s.idleSol).toBeCloseTo(1.5, 6); // 100 USDC × 0.015 SOL
  });

  // R11: an under/over-stated valuation must be FLAGGED (complete:false) so it is never persisted as a
  // real Net Worth point. The value is still returned (deflated), but the flag tells the recorder to skip.
  it('is complete when every held side is priced (Jupiter or the on-chain pool fallback)', () => {
    // MEME/SOL position: SOL side = 1, MEME side falls back to the >0 pool price → fully priced.
    const s = valueSnapshot(snap([posv({ amountX: 1_000_000n, amountY: 1n })]), new Map());
    expect(s.complete).toBe(true);
  });

  it('flags incomplete when an idle token has no Jupiter quote (its value is silently dropped)', () => {
    const s = valueSnapshot(
      snap([], { idleTokens: [{ mint: 'USDC', amount: 100_000_000n, decimals: 6 }] }),
      new Map(), // Jupiter is down → no USDC price
    );
    expect(s.complete).toBe(false);
    expect(s.idleSol).toBe(0); // the 100 USDC was dropped to 0 — exactly the deflation we must not persist
  });

  it('flags incomplete when a non-SOL/non-SOL position has no price on either side', () => {
    // Neither side is SOL, so there is no pool-derived SOL fallback; with no Jupiter quotes the whole
    // position is valued at 0 (deflated).
    const s = valueSnapshot(
      snap([
        posv({ tokenXMint: 'AAA', tokenYMint: 'BBB', amountX: 1_000_000n, amountY: 1_000_000n }),
      ]),
      new Map(),
    );
    expect(s.complete).toBe(false);
    expect(s.tvlSol).toBe(0);
  });

  it('does NOT flag a side that holds nothing, even if its mint is unpriced', () => {
    // amountX 0 + feeX 0 → the unpriced MEME side contributes nothing, so it cannot deflate the total.
    const s = valueSnapshot(snap([posv({ tokenXMint: 'AAA', amountY: 1n })]), new Map());
    expect(s.complete).toBe(true);
  });

  it('propagates the snapshot-level incompleteness (unknown decimals / missing bin-array) through', () => {
    // Prices are all available, but the chain read itself was incomplete (snap.complete=false) — the
    // flag must survive valuation so freshness downstream becomes "syncing".
    const s = valueSnapshot(
      snap([posv({ amountX: 1_000_000n })], { complete: false }),
      new Map([['MEME', 0.5]]),
    );
    expect(s.complete).toBe(false);
  });
});
