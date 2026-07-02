import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';
import { sleep } from './util';

// FEATURE 2 (TEST-PLAN.md) — two-sided opens on NON-spot shapes (bidask / curve) + a two-sided close → sweep.
// The DISCRIMINATING assertion is `tokenLegRatio` (copy token / leader token, raw units): ≈ COPY_RATIO (0.5) when
// the token leg is faithfully replicated, EXACTLY 0 for a one-sided copy of a two-sided leader. A regression that
// drops the token buy (one-sided copy of a two-sided bidask/curve open) lands tokenLegRatio at 0 → caught here.
// bidask/curve concentrate liquidity differently than spot (edge bins vs center bins), so the same two-sided
// build-after-buy path runs over a non-uniform shape; the bands match the proven two-sided example (the active-bin
// token↔SOL split is genuinely noisy), with maxEconDiff loosened to <10% (shape is less uniform than spot).
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · two-sided shapes — bidask/curve open + sweep', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  // 2.4 — two-sided BIDASK open. The leader concentrates BOTH legs toward the range edges (ascending/U shape). The
  // bot must still buy the token leg AND deposit two-sided. tokenLegRatio≈0 would mean a one-sided copy (regression).
  it('two-sided bidask open → SOL leg AND token leg replicated at half size', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, twosided: true, strategy: 'bidask', sol: 0.1, token: 4_000_000 });
    const copyPos = await h.waitForCopy(POOL_STABLE, 60_000); // two-sided open = build-after-buy (slowest path)
    const f = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(f.solLegRatio).toBeGreaterThan(0.43); // SOL leg copied at ~half (the dominant, low-noise leg)
    expect(f.solLegRatio).toBeLessThan(0.6);
    // TOKEN leg copied at ~half ⇒ two-sided. A one-sided copy lands this at EXACTLY 0. Wide band = genuine active-bin
    // arb noise between the leader's and the (seconds-later) copy's deposits — discriminates two-sided from one-sided.
    expect(f.tokenLegRatio).toBeGreaterThan(0.25);
    expect(f.tokenLegRatio).toBeLessThan(0.75);
    expect(f.maxEconDiffPct).toBeLessThan(10); // both-leg distribution reproduced over a non-uniform shape (arb-tolerant)
  }, 240_000);

  // 2.5 — two-sided CURVE open. The leader concentrates BOTH legs toward the active bin (descending/center shape).
  // Same two-sided guarantee: a SOL-only copy of this two-sided leader drops tokenLegRatio to 0 → caught.
  it('two-sided curve open → SOL leg AND token leg replicated at half size', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, twosided: true, strategy: 'curve', sol: 0.1, token: 4_000_000 });
    const copyPos = await h.waitForCopy(POOL_STABLE, 60_000); // two-sided open = build-after-buy (slowest path)
    const f = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(f.solLegRatio).toBeGreaterThan(0.43); // SOL leg copied at ~half (the dominant, low-noise leg)
    expect(f.solLegRatio).toBeLessThan(0.6);
    expect(f.tokenLegRatio).toBeGreaterThan(0.25); // token leg present ⇒ two-sided (one-sided copy = 0)
    expect(f.tokenLegRatio).toBeLessThan(0.75);
    expect(f.maxEconDiffPct).toBeLessThan(10); // both-leg distribution reproduced over a non-uniform shape (arb-tolerant)
  }, 240_000);

  // 2.6 — two-sided close → SWEEP. A two-sided close returns BOTH legs into the copier wallet (SOL + a real,
  // above-floor token balance). The bot MUST convert that token back to SOL (close-sell + periodic sweep). This
  // FAILS if the bot leaves a dormant non-SOL token (a no-miss-sweep regression) OR the sweep never lands within 80s.
  it('two-sided close → copier swept token→SOL (no dormant token)', async () => {
    const before = await h.copierMints(); // pre-existing session dust (illiquid Token-2022) to ignore
    await h.leaderOpen({ pool: POOL_STABLE, twosided: true, sol: 0.1, token: 4_000_000 });
    const copy = await h.waitForCopy(POOL_STABLE, 60_000); // two-sided open = build-after-buy (slowest path)
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy); // the close returns SOL + the token leg into the copier wallet

    const start = Date.now();
    let cleanMs = -1;
    while (Date.now() - start < 80_000) {
      if (await h.copierCleanOf(before)) {
        cleanMs = Date.now() - start;
        break;
      }
      await sleep(5000);
    }
    expect(cleanMs, 'copier still holds a non-SOL token after 80s — DORMANT TOKEN').toBeGreaterThanOrEqual(0);
    console.log(`💱 copier swept to SOL ${(cleanMs / 1000).toFixed(1)}s after the two-sided close`);
  }, 240_000);
});
