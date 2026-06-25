import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';

// REAL selective-reshape tests: a DLMM leader trims/adds liquidity on SPECIFIC bins, not just the whole position.
// The copy must mirror the trim/add on the SAME offset bins (shape-exact re-sync), NOT just match the total size.
// The discriminating signal is `maxSolLegDiffPct` staying LOW through an ASYMMETRIC reshape: a proportional (size-
// only) regression would keep the copy's old shape while the leader's shape changed → the per-bin diff blows up.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · reshape — selective per-bin add/remove', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  it('leader empties a sub-range (100%) → the copy empties the SAME bins (shape, not a proportional shrink)', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.12 });
    const copyPos = await h.waitForCopy(POOL_STABLE);
    const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(before.maxSolLegDiffPct).toBeLessThan(8); // the uniform copy reproduces the uniform leader

    // Empty the BOTTOM half of the leader's bins (100% out of [lower, mid]) — a SELECTIVE trim, not a global shrink.
    const [lp] = await h.leaderPositions(POOL_STABLE);
    expect(lp, 'leader position not found on-chain').toBeDefined();
    if (!lp) return;
    const mid = Math.floor((lp.lowerBinId + lp.upperBinId) / 2);
    await h.leaderRemove(POOL_STABLE, 10_000, lp.lowerBinId, mid);

    // The bot mirrors the trim on the SAME offsets → the copy ends concentrated in the upper bins, so the
    // normalized SOL-leg shapes STILL match. A proportional-remove regression would keep the copy uniform while
    // the leader is now top-heavy → maxSolLegDiffPct would blow up → this FAILS.
    const after = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol < before.totalCopySol * 0.85);
    expect(after.maxSolLegDiffPct).toBeLessThan(12); // shape preserved through the selective trim (arb-tolerant)
  }, 240_000);

  it('leader adds a SPIKE on one existing SOL bin → the copy reproduces the spike on the same bin (not uniform)', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copyPos = await h.waitForCopy(POOL_STABLE);
    const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(before.maxSolLegDiffPct).toBeLessThan(8);

    // Spike the leader's LARGEST-SOL bin — guaranteed to exist AND to be spanned by the copy (so the add isn't
    // dropped as out-of-range). `add --dist` runs from lowerBinId, so the spike index = that bin's binId − lower;
    // zeros elsewhere ⇒ the 0.06 SOL lands ONLY on that bin, making it dominant.
    const ls = await h.leaderShape(leaderPos, POOL_STABLE);
    const solBin = ls.bins.filter((b) => b.sol > 0).sort((a, b) => b.sol - a.sol)[0];
    expect(solBin, 'leader has no SOL bin').toBeDefined();
    if (!solBin) return;
    const idx = ls.activeBinId + solBin.off - ls.lowerBinId;
    const dist = Array.from({ length: idx + 1 }, (_, i) => (i === idx ? 8 : 0)).join(',');
    await h.leaderAdd({ pool: POOL_STABLE, dist, sol: 0.06 });

    // The bot must add the deficit on the SAME bin → the copy reproduces the spike fraction (a half-size add on a
    // half-size position normalizes to the SAME per-bin distribution). A uniform/proportional-add regression would
    // diverge from the leader's now-spiked shape → maxSolLegDiffPct blows up → this FAILS.
    const after = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol > before.totalCopySol * 1.15);
    expect(after.maxSolLegDiffPct).toBeLessThan(12); // the spike is reproduced on the matching bin (arb-tolerant)
  }, 240_000);
});
