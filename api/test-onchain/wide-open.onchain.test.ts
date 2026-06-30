import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_COIN_SOL, POOL_STABLE, connection } from './env';
import { Harness } from './harness';

// REAL on-chain tests — A1′ proper fix: WIDE opens (≥26 bins). The SDK's atomic by-weight open chunks at 26 bins into
// [pre, main(addLiquidityOneSide), post] where the deposit is NOT the first tx → the old single-tx publish created an
// EMPTY position. The fix sequences it: publish `pre` (create+wrap), then `main`+`post` merged (deposit+unwrap) once
// the create lands, using the SDK's NATIVE one-sided deposit ix (correct bin placement — unlike add2). These drive a
// WIDE leader open, wait for the bot to copy a FUNDED position (waitForCopy REQUIRES liquidity → an empty position
// FAILS it), and assert the SOL leg is reproduced faithfully at half size. Each afterEach also CLOSES the wide copy
// (proving a wide close is clean). Before the fix every one of these failed (empty copy / timeout).
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · A1′ — WIDE opens ≥26 bins (no empty-position bug)', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });

  // Half-size copy band (COPY_RATIO 0.5; arb on the older leader's SOL leg widens it a touch).
  const SOL_LEG_RATIO_MIN = 0.4;
  const SOL_LEG_RATIO_MAX = 0.62;
  // Wide flat shapes spread the SOL leg over many bins; a single arb'd bin moves the per-bin diff, so use a tolerant
  // bound. A real regression (empty position, partial/mis-shaped deposit) blows far past this (or fails waitForCopy).
  const MAX_SOL_LEG_DIFF_PCT = 16;
  const WAIT_COPY_MS = 90_000; // wide opens land in 2 sequential txs (create → deposit) → slower than a 1-tx open

  const flatDist = (bins: number): string => Array(bins).fill('1').join(','); // '1,1,…' ×bins — flat, full-width

  const assertWideOpenFaithful = async (pool: string, leaderPos: string): Promise<void> => {
    const copyPos = await h.waitForCopy(pool, WAIT_COPY_MS); // throws if the copy never becomes FUNDED (the A1′ bug)
    const f = await h.fidelity(pool, leaderPos, copyPos);
    expect(f.totalCopySol).toBeGreaterThan(0.02); // genuinely funded (not an empty/dust position)
    expect(f.solLegRatio).toBeGreaterThan(SOL_LEG_RATIO_MIN);
    expect(f.solLegRatio).toBeLessThan(SOL_LEG_RATIO_MAX);
    expect(f.maxSolLegDiffPct).toBeLessThan(MAX_SOL_LEG_DIFF_PCT);
  };

  describe('stable SOL/USDC (classic) — one-sided', () => {
    afterEach(() => h.resetState(POOL_STABLE)); // also proves a WIDE copy closes cleanly (no residual)

    // 26 bins = EXACTLY the SDK chunk boundary. The atomic open chunks here → must be sequenced. Off-by-one in the
    // routing would leave an empty position → waitForCopy throws.
    it('boundary open (26 bins) → sequenced create+deposit, copied faithfully (no empty position)', async () => {
      await assertWideOpenFaithful(POOL_STABLE, await h.leaderOpen({ pool: POOL_STABLE, dist: flatDist(26), sol: 0.12 }));
    }, 240_000);

    it('wide open (30 flat bins) → copied faithfully at half size', async () => {
      await assertWideOpenFaithful(POOL_STABLE, await h.leaderOpen({ pool: POOL_STABLE, dist: flatDist(30), sol: 0.12 }));
    }, 240_000);

    it('wide open (50 flat bins) → copied faithfully at half size', async () => {
      await assertWideOpenFaithful(POOL_STABLE, await h.leaderOpen({ pool: POOL_STABLE, dist: flatDist(50), sol: 0.14 }));
    }, 240_000);

    // WIDE partial REMOVE ("retrait"): open wide, then the leader trims 50% → the bot mirrors a remove (≤70 bins → 1
    // tx, always safe). The copy's economic size must shrink + settle. Proves a reshape REMOVE on a wide position.
    it('wide open then leader removes 50% → copy shrinks (wide remove)', async () => {
      const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, dist: flatDist(30), sol: 0.12 });
      const copyPos = await h.waitForCopy(POOL_STABLE, WAIT_COPY_MS);
      const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
      await h.leaderRemove(POOL_STABLE, 5000); // trim 50% of the leader's liquidity
      const after = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol < before.totalCopySol * 0.8);
      expect(after.totalCopySol).toBeLessThan(before.totalCopySol * 0.8); // the copy actually shrank on-chain
    }, 300_000);
  });

  describe('volatile coin/SOL (Token-2022) — one-sided', () => {
    afterEach(() => h.resetState(POOL_COIN_SOL));

    // A wide one-sided SOL open on a TOKEN-2022 pool: the deposit (addLiquidityOneSide) touches only the WSOL (classic)
    // leg, so it lands despite the Token-2022 token leg — and the sequencing handles the ≥26-bin chunk. Tolerant
    // bounds (low-liquidity coin → more arb on the SOL leg); the PRIMARY assertion is "funded, not empty".
    it('wide one-sided open (30 bins) on a Token-2022 pool → copied FUNDED', async () => {
      const leaderPos = await h.leaderOpen({ pool: POOL_COIN_SOL, dist: flatDist(30), sol: 0.12 });
      const copyPos = await h.waitForCopy(POOL_COIN_SOL, WAIT_COPY_MS);
      const f = await h.fidelity(POOL_COIN_SOL, leaderPos, copyPos);
      expect(f.totalCopySol).toBeGreaterThan(0.02); // funded (the A1′ regression left this at ~0)
      expect(f.solLegRatio).toBeGreaterThan(0.3); // generous (volatile coin) — proves a real proportional copy, not dust
    }, 240_000);
  });
});
