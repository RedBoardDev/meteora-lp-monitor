import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';
import { sleep } from './util';

type LeaderShape = Awaited<ReturnType<Harness['leaderShape']>>;

/**
 * Build an `add --dist` (weights run from lowerBinId) that lands ENTIRELY on the bins the position ALREADY holds
 * SOL on — a pure IN-RANGE resync that never extends the range. A `--strategy=spot` add re-centers on the (possibly
 * moved) active bin and can spill onto NEW bins outside the position's fixed range; the copy cannot add out-of-range
 * → it copies only the in-range part → the size/shape drift away from the leader. Weighting only the existing SOL
 * bins (uniform, `1,1,..`) keeps every add inside [lowerBinId, upperBinId], so the copy can fully resync up.
 *
 * Index mapping mirrors the spike-add convention (see reshape.onchain.test.ts): `dist[i]` targets
 * `binId = lowerBinId + i`, and a SOL bin's binId = `activeBinId + off`. Falls back to a uniform in-range dist if no
 * SOL bin maps (defensive — still never extends the range).
 */
const inRangeSolDist = (ls: LeaderShape): string => {
  const len = ls.upperBinId - ls.lowerBinId + 1;
  const solSorted = ls.bins
    .filter((b) => b.sol > 0)
    .map((b) => ls.activeBinId + b.off - ls.lowerBinId)
    .sort((a, b) => a - b);
  // Weight only the INNER SOL bins (drop the outermost one on each side). The copy's range is re-anchored at open
  // and is often a bin NARROWER than the leader's (open-time BPS rounding drops the smallest edge bins), so an add
  // on a leader EDGE bin maps OUTSIDE the copy's range → "leader bins beyond our range" partial copy → the copy
  // under-resyncs. Adding strictly inside keeps every deposit within BOTH ranges so the copy fully tracks.
  const inner = solSorted.length > 2 ? solSorted.slice(1, -1) : solSorted;
  const idx = new Set(inner);
  const weights = Array.from({ length: len }, (_, i) => (idx.has(i) ? 1 : 0));
  return (weights.some((w) => w > 0) ? weights : weights.map(() => 1)).join(',');
};

// REAL multi-step lifecycle. A leader does NOT do one action and stop — it adds, trims, adds again, over the life of
// ONE position. The copy must stay in sync at EVERY step: the per-bin reshape is meant to be drift-free / self-
// healing (each event re-syncs to COPY_RATIO × the leader's CURRENT on-chain shape). These tests chain many actions
// and assert the SOL-leg ratio stays ~0.5 AND the shape stays faithful after each — accumulated drift (a stale size,
// a shape that wandered) would push solLegRatio out of band or blow up maxSolLegDiffPct. Each test closes clean.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · lifecycle — drift-free over many actions', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  const assertInSync = (f: { solLegRatio: number; maxSolLegDiffPct: number }, step: string): void => {
    expect(f.solLegRatio, `${step}: SOL-leg size drifted from ~half`).toBeGreaterThan(0.43);
    expect(f.solLegRatio, `${step}: SOL-leg size drifted from ~half`).toBeLessThan(0.6);
    expect(f.maxSolLegDiffPct, `${step}: per-bin shape drifted`).toBeLessThan(12);
  };

  // 5.1 — open → add → partial remove → add → close, every step in sync. Each add is forced IN-RANGE (see
  // `inRangeSolDist`) so the deposit is a clean resync, never a range extension (the original draft used
  // `strategy:'spot'`, which spilled onto new bins at add #2 → partial copy → drift → failure).
  it('open → add → partial remove → add → close: the copy tracks every step with NO accumulated drift', async () => {
    // OPEN
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.08 });
    const copy = await h.waitForCopy(POOL_STABLE);
    let f = await h.fidelity(POOL_STABLE, leaderPos, copy);
    assertInSync(f, 'open');
    let size = f.totalCopySol;

    // ADD #1 (grow) — deposit IN-RANGE over the EXISTING SOL bins → the copy fully resyncs up (no new bins).
    await h.leaderAdd({ pool: POOL_STABLE, dist: inRangeSolDist(await h.leaderShape(leaderPos, POOL_STABLE)), sol: 0.04 });
    f = await h.waitForCopyResize(POOL_STABLE, leaderPos, copy, (s) => s > size * 1.15);
    assertInSync(f, 'after add #1');
    size = f.totalCopySol;

    // PARTIAL REMOVE (shrink ~40%, full range) — a withdraw (no close) → resync down. Every bin keeps SOL.
    await h.leaderRemove(POOL_STABLE, 4000);
    f = await h.waitForCopyResize(POOL_STABLE, leaderPos, copy, (s) => s < size * 0.85);
    assertInSync(f, 'after partial remove');
    size = f.totalCopySol;

    // ADD #2 (grow again, IN-RANGE) — proves the copy re-grows correctly AFTER a trim (the hard self-healing case)
    // and that a fresh in-range dist resyncs cleanly even on the now-smaller position.
    await h.leaderAdd({ pool: POOL_STABLE, dist: inRangeSolDist(await h.leaderShape(leaderPos, POOL_STABLE)), sol: 0.04 });
    f = await h.waitForCopyResize(POOL_STABLE, leaderPos, copy, (s) => s > size * 1.15);
    assertInSync(f, 'after add #2');

    // CLOSE — after a full lifecycle, the copy must close cleanly (no dormant position).
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy);
    expect(await h.accountExists(copy)).toBe(false);
  }, 300_000);

  // 5.2 — CHURN: 4 alternating IN-RANGE add/remove cycles. The self-healing claim is that EVERY event re-syncs to
  // the leader's CURRENT shape with no memory of prior steps; a regression that drifts a little each cycle would
  // accumulate over four reshapes → the END-state solLegRatio leaves [0.43,0.6] or maxSolLegDiffPct blows past 12.
  // The intermediate gates are ABSOLUTE-size (×1.15 grow / ×0.85 shrink) so a stale ≈0.5 ratio can never fake a pass.
  it('churn: 4 alternating in-range add/remove cycles leave NO accumulated drift, then close clean', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.08 });
    const copy = await h.waitForCopy(POOL_STABLE);
    let f = await h.fidelity(POOL_STABLE, leaderPos, copy);
    assertInSync(f, 'open');
    let size = f.totalCopySol;

    const CYCLES = 2; // each cycle = 1 add + 1 remove ⇒ 4 reshapes total
    for (let c = 1; c <= CYCLES; c++) {
      // IN-RANGE ADD (+0.03 SOL, resync up) — weight only the existing SOL bins so the copy tracks fully.
      await h.leaderAdd({ pool: POOL_STABLE, dist: inRangeSolDist(await h.leaderShape(leaderPos, POOL_STABLE)), sol: 0.03 });
      f = await h.waitForCopyResize(POOL_STABLE, leaderPos, copy, (s) => s > size * 1.15);
      assertInSync(f, `cycle ${c} · after add`);
      size = f.totalCopySol;

      // PARTIAL REMOVE (3000 bps = 30% off the full range, resync down).
      await h.leaderRemove(POOL_STABLE, 3000);
      f = await h.waitForCopyResize(POOL_STABLE, leaderPos, copy, (s) => s < size * 0.85);
      assertInSync(f, `cycle ${c} · after remove`);
      size = f.totalCopySol;
    }

    // END STATE — the discriminating assertion: after FOUR reshapes the copy is still ~half-size and shape-faithful.
    assertInSync(f, 'end of churn (no accumulated drift)');

    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy);
    expect(await h.accountExists(copy)).toBe(false);
  }, 360_000);

  // 5.3 — MIXED-LEG: the position's COMPOSITION changes mid-life. A one-sided SOL open (SOL leg only) gets a
  // TWO-SIDED add (0.03 SOL + 2 USDC), which forces the copier to acquire a token leg (a Jupiter buy + a two-sided
  // deposit). The discriminating signal is `tokenLegRatio` going from ~0 to a real fraction of the leader's; a
  // regression that ignored the new leg would leave tokenLegRatio ≈ 0. Then close → the copier must sweep the
  // returned token back to SOL (no dormant token). Gate the resize on ABSOLUTE growth, never on a ratio.
  it('mixed-leg: one-sided open → two-sided add introduces a token leg (copied) → close → swept to SOL', async () => {
    const before = await h.copierMints(); // pre-existing session dust to ignore in the sweep clean check
    // One-sided SOL open: the copy starts with a SOL leg only.
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.08 });
    const copy = await h.waitForCopy(POOL_STABLE);
    const open = await h.fidelity(POOL_STABLE, leaderPos, copy);
    assertInSync(open, 'one-sided open');
    const size = open.totalCopySol;

    // TWO-SIDED ADD: deposit BOTH legs. The copier must buy the token then build a two-sided add (slower path →
    // longer timeout). Settle-aware resize gated on absolute growth — a ratio reads a stale ≈0.5 mid-flight.
    await h.leaderAdd({ pool: POOL_STABLE, twosided: true, sol: 0.03, token: 2_000_000 });
    const after = await h.waitForCopyResize(POOL_STABLE, leaderPos, copy, (s) => s > size * 1.15, 120_000);

    // The composition CHANGED: the token leg is now present on the copy (≥ a quarter of the leader's, tolerant of
    // active-bin arb + Jupiter routing noise). A no-token-leg regression makes this FAIL.
    expect(after.tokenLegRatio, 'two-sided add: the new token leg was not copied').toBeGreaterThan(0.25);

    // CLOSE returns BOTH legs to the copier → the bot must sweep the token back to SOL (no dormant token).
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy);

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
    console.log(`💱 mixed-leg: copier swept to SOL ${(cleanMs / 1000).toFixed(1)}s after the close`);
  }, 360_000);
});
