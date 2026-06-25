import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';

// REAL on-chain tests — FEATURE 1, edge opens (1.6 narrow, 1.7 wide, 1.8 near-min size). They drive a leader open
// of an EDGE bin-count / EDGE size on the stable SOL/USDC pool, wait for the bot to copy, and assert the copy
// reproduces the leader's SOL-leg distribution (faithful) at half size (COPY_RATIO 0.5). These FAIL if the
// open / re-anchor / sizing / min-size-floor logic regresses on these boundary cases.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · open — edge bin-count + near-min size (stable SOL/USDC)', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  // SOL-leg fidelity band (COPY_RATIO 0.5; arb on the older leader's SOL leg widens it a touch). A sizing
  // regression (e.g. the 0.806× bug) trips this; a re-anchor regression mis-places SOL across bins → big diff.
  const SOL_LEG_RATIO_MIN = 0.43;
  const SOL_LEG_RATIO_MAX = 0.6;
  // Edge shapes (1–3 bins, ~15 bins) concentrate / spread the SOL leg so a single arb'd bin moves the shape diff
  // more than the canonical simple-shape bound of 8 → use the proven arb-tolerant reshape bound of 12. A real
  // re-anchor regression (SOL mis-placed across bins) still blows well past 12 (15–40%) and is caught.
  const MAX_SOL_LEG_DIFF_PCT = 12;
  // Use a generous wait: edge opens (max bin count / build) can land slower than a 4-bin spot open.
  const WAIT_COPY_MS = 60_000;

  // Wait for the copy, then assert the SOL leg is reproduced (shape) at half size (ratio). Throws (test fails) if
  // the bot never copies — which for 1.8 is ALSO the min-size-floor regression signal (a wrongly-skipped open).
  const assertFaithfulHalf = async (leaderPos: string): Promise<void> => {
    const copyPos = await h.waitForCopy(POOL_STABLE, WAIT_COPY_MS);
    const f = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(f.maxSolLegDiffPct).toBeLessThan(MAX_SOL_LEG_DIFF_PCT);
    expect(f.solLegRatio).toBeGreaterThan(SOL_LEG_RATIO_MIN);
    expect(f.solLegRatio).toBeLessThan(SOL_LEG_RATIO_MAX);
  };

  // 1.6 — narrow open: 3 bins, center-weighted (minimal bin count). Copy must reproduce the same tight SOL leg.
  it('narrow open (3 bins, center spike) → copied faithfully at half size', async () => {
    const NARROW_DIST = '1,5,1'; // 3 bins, spike in the middle — the minimal-bin-count edge
    await assertFaithfulHalf(await h.leaderOpen({ pool: POOL_STABLE, dist: NARROW_DIST, sol: 0.1 }));
  }, 180_000);

  // 1.7 — wide open: 15 flat bins (max bin count / CU edge). Copy must spread the SOL leg across the same width.
  it('wide open (15 flat bins) → copied faithfully at half size', async () => {
    const WIDE_BIN_COUNT = 15; // max-bin-count / CU stress: the copy must still land + spread faithfully
    const WIDE_DIST = Array(WIDE_BIN_COUNT).fill('1').join(','); // '1,1,...,1' ×15 — flat, full-width
    await assertFaithfulHalf(await h.leaderOpen({ pool: POOL_STABLE, dist: WIDE_DIST, sol: 0.1 }));
  }, 180_000);

  // 1.8 — near-min size: leader 0.042 SOL → copy ≈0.021 SOL, just ABOVE the 0.02 min floor → IS copied (not
  // skipped). waitForCopy succeeding proves "not skipped"; the band asserts the copy is genuinely the near-min
  // half-size (not mis-sized). If the min-floor regressed (copy sized < 0.02 → skipped) waitForCopy would throw.
  it('near-min size open (leader 0.042 → copy ≈0.021 ≥ 0.02 min) → IS copied at half size', async () => {
    const NEAR_MIN_LEADER_SOL = 0.042; // 0.5 × 0.042 = 0.021 copy ≥ the 0.02 min floor (just above)
    const NEAR_MIN_COPY_FLOOR_SOL = 0.018; // noise-tolerant lower bound (~15% under the ~0.021 target) — proves near-min, not a skip
    const NEAR_MIN_COPY_CEIL_SOL = 0.03; // upper bound — rules out a mis-size (the copy IS the ~0.021 near-min size)
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: NEAR_MIN_LEADER_SOL });
    const copyPos = await h.waitForCopy(POOL_STABLE, WAIT_COPY_MS);
    const f = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(f.maxSolLegDiffPct).toBeLessThan(MAX_SOL_LEG_DIFF_PCT);
    expect(f.solLegRatio).toBeGreaterThan(SOL_LEG_RATIO_MIN);
    expect(f.solLegRatio).toBeLessThan(SOL_LEG_RATIO_MAX);
    expect(f.totalCopySol).toBeGreaterThan(NEAR_MIN_COPY_FLOOR_SOL); // the copy is genuinely the near-min size…
    expect(f.totalCopySol).toBeLessThan(NEAR_MIN_COPY_CEIL_SOL); // …not accidentally larger
  }, 180_000);
});
