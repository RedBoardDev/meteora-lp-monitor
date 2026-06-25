import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';

// REAL two-sided tests: the leader opens a genuine two-sided position (SOL + token); the bot must replicate BOTH
// legs (buy the token + deposit two-sided). The DISCRIMINATING assertion is `tokenLegRatio` (copy token / leader
// token, raw units): ≈ COPY_RATIO (0.5) when the token leg is faithfully replicated, exactly 0 for a one-sided
// copy. Unlike the econ `totalRatio` (dominated by the larger SOL leg → one-sided vs two-sided bands sit too close
// when the token leg is small), the token-leg ratio cleanly separates the two regardless of leg sizes.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · two-sided — replicate BOTH legs', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  it('two-sided open → SOL leg AND token leg replicated at half size', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, twosided: true, sol: 0.1, token: 4_000_000 });
    const copyPos = await h.waitForCopy(POOL_STABLE, 60_000); // two-sided open = build-after-buy (slowest path)
    const f = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(f.solLegRatio).toBeGreaterThan(0.43); // SOL leg copied at ~half (the dominant, low-noise leg)
    expect(f.solLegRatio).toBeLessThan(0.6);
    // TOKEN leg copied at ~half ⇒ two-sided. A one-sided copy lands this at EXACTLY 0. The band is wide because the
    // token leg is genuinely noisy: the active bin's token↔SOL split moves with arb between the leader's and the
    // (seconds-later) copy's deposits, so the raw token ratio drifts ~0.33–0.55 around the 0.5 target. The point is
    // discriminating two-sided (clearly non-zero, ~half) from one-sided (0) and a gross mis-size — not fake precision.
    expect(f.tokenLegRatio).toBeGreaterThan(0.25);
    expect(f.tokenLegRatio).toBeLessThan(0.75);
    expect(f.maxEconDiffPct).toBeLessThan(8); // both-leg distribution reproduced (arb-tolerant)
  }, 180_000);

  // GROW: the leader adds MORE two-sided liquidity to its existing position. The bot must reshape its copy — BUY
  // the extra token deficit (ExactOut) + add BOTH legs by-weight — so the copy grows proportionally and the token
  // leg stays at ≈ COPY_RATIO. A regression that ignores the add (copy stays flat) or only adds the SOL leg (the
  // token buy fails / is skipped) leaves the copy under-grown or drops tokenLegRatio below 0.4 → this FAILS.
  it('leader grows two-sided → bot reshapes (buy + two-sided add), copy grows proportionally', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, twosided: true, sol: 0.1, token: 4_000_000 });
    const copyPos = await h.waitForCopy(POOL_STABLE, 60_000); // two-sided open = build-after-buy (slowest path)
    const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(before.tokenLegRatio).toBeGreaterThan(0.25); // baseline: a genuine two-sided copy landed (token leg present)

    // +40% liquidity on BOTH legs. handleResync reads both shapes on-chain, computes the per-bin deficit, buys the
    // token deficit then adds both legs (the two-sided reshape-add path).
    await h.leaderAdd({ pool: POOL_STABLE, twosided: true, sol: 0.04, token: 2_000_000 });

    // Wait for the copy's absolute econ size to GROW ≥15% (clearly above arb noise) — proves the reshape add landed.
    const after = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol > before.totalCopySol * 1.15);
    // The token leg is still ~half (the buy + two-sided add worked) — a SOL-only reshape would drop it toward 0.
    expect(after.tokenLegRatio).toBeGreaterThan(0.25);
    expect(after.tokenLegRatio).toBeLessThan(0.75);
    expect(after.solLegRatio).toBeGreaterThan(0.43); // SOL leg grew proportionally too (dominant, low-noise leg)
    expect(after.solLegRatio).toBeLessThan(0.6);
  }, 240_000);

  // SHRINK: the leader removes half its liquidity (bps=5000) proportionally across all bins. The bot must reshape
  // its copy DOWN by the same proportion — a proportional remove covers BOTH legs. We assert both leg ratios held
  // (the copy removed token AND SOL in proportion) + that the copy actually shrank meaningfully. NOTE: the absolute
  // econ magnitude can drift a few % — bps removes round per-bin and the active bin's SOL↔token split moves with
  // arb between the two reads — so the discriminating check is the leg PROPORTIONS, not the exact post-shrink size.
  it('leader shrinks (50% remove) → bot reshapes down, both leg proportions maintained', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, twosided: true, sol: 0.1, token: 4_000_000 });
    const copyPos = await h.waitForCopy(POOL_STABLE, 60_000); // two-sided open = build-after-buy (slowest path)
    const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(before.tokenLegRatio).toBeGreaterThan(0.25);

    await h.leaderRemove(POOL_STABLE, 5000); // remove 50% proportionally → withdrawSol > 0 → handleResync (down)

    // Wait until the copy's econ size dropped ≥20% — proves the proportional remove landed on the copy.
    const after = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol < before.totalCopySol * 0.8);
    expect(after.solLegRatio).toBeGreaterThan(0.4); // SOL-leg proportion held through the shrink (arb-tolerant)
    expect(after.solLegRatio).toBeLessThan(0.62);
    // Token leg shrank in proportion too. THE REGRESSION GUARD: before the pure-token-bin remove fix, the copy kept
    // its token while the leader halved → tokenLegRatio shot to ~1.0. Asserting < 0.75 fails that buggy behavior;
    // > 0.25 catches an over-remove. (Wide band = the same active-bin arb noise as the open.)
    expect(after.tokenLegRatio).toBeGreaterThan(0.25);
    expect(after.tokenLegRatio).toBeLessThan(0.75);
  }, 240_000);
});
