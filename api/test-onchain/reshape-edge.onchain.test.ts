import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';

// FEATURE 3 — reshape EDGE cases (per-bin selective add/remove, extremes, and the documented v1 range limit).
// These extend the canonical reshape example (3.1 sub-range empty / 3.2 single-bin spike). The discriminating
// signal everywhere is `maxSolLegDiffPct` staying LOW through ASYMMETRIC reshapes: a size-only (proportional)
// regression keeps the copy's OLD per-bin shape while the leader's shape changes → the per-bin diff blows up.
// `maxSolLegDiffPct` is shift-invariant (best-fit ±2 bins, keyed by offset-from-lower) so it forgives active-bin
// read noise but CATCHES a real distortion (a hole that isn't reproduced, a spike on the wrong bin).
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · reshape EDGE — refill / extreme / multi-bin / range-limit', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  // 3.3 — emptied ≠ forgotten. Empty ONE bin 100% → the copy carves the SAME hole; then ADD a spike back on the
  // SAME bin → the copy RE-FILLS it. A regression that "forgot" an emptied bin would never re-fill it.
  it('re-fills an emptied bin: empty ONE SOL bin (100%) → copy empties it → add it back → copy re-fills the SAME bin', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.12 });
    const copyPos = await h.waitForCopy(POOL_STABLE);
    const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(before.maxSolLegDiffPct).toBeLessThan(8); // the uniform copy reproduces the uniform leader

    // Pick the leader's LARGEST-SOL bin (guaranteed to exist AND to be spanned by the copy) and EMPTY it 100%.
    // `remove --frombin=binId --tobin=binId` trims exactly that one bin (a selective hole, not a global shrink).
    const ls = await h.leaderShape(leaderPos, POOL_STABLE);
    const solBin = ls.bins.filter((b) => b.sol > 0).sort((a, b) => b.sol - a.sol)[0];
    expect(solBin, 'leader has no SOL bin').toBeDefined();
    if (!solBin) return;
    const binId = ls.activeBinId + solBin.off;
    const totalSol = ls.bins.reduce((s, b) => s + b.sol, 0);
    const binFrac = solBin.sol / totalSol; // fraction of the SOL leg this single bin holds
    await h.leaderRemove(POOL_STABLE, 10_000, binId, binId);

    // The bot mirrors the single-bin emptying → the copy SHRINKS by ~binFrac AND the per-bin shapes still match
    // (the hole is reproduced at the same offset). Gate the shrink on a fraction DERIVED from that bin's real share
    // (require ≥half the expected drop to have landed+settled); a proportional regression would keep every bin
    // filled (no localized hole) → maxSolLegDiffPct would blow up → this FAILS.
    const emptied = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol < before.totalCopySol * (1 - binFrac * 0.5));
    expect(emptied.maxSolLegDiffPct).toBeLessThan(12); // hole reproduced on the SAME bin (arb-tolerant)

    // Now ADD a SPIKE back on the SAME bin. `add --dist` runs ascending from lowerBinId, so the spike index =
    // binId − lowerBinId; zeros elsewhere ⇒ the 0.06 SOL lands ONLY on the previously-emptied bin.
    const idx = binId - ls.lowerBinId;
    const dist = Array.from({ length: idx + 1 }, (_, i) => (i === idx ? 8 : 0)).join(',');
    await h.leaderAdd({ pool: POOL_STABLE, dist, sol: 0.06 });

    // The copy must RE-FILL that exact bin → it grows back. A bin the bot had "forgotten" after the empty would
    // never re-fill → no grow → waitForCopyResize THROWS → this FAILS. The re-filled shape must match again.
    const refilled = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol > emptied.totalCopySol * 1.15);
    // The re-filled bin sits at/near the ACTIVE bin, whose SOL↔token split arbs between the leader's and copy's
    // reads → the SOL-leg-only per-bin diff runs a touch higher here than a static shape (≈12–13%). The ECON diff
    // confirms the value landed on the right bin; assert SOL-leg < 15 (a real mis-fill onto a wrong bin = 20–40%).
    expect(refilled.maxEconDiffPct).toBeLessThan(8); // economic shape matches → the bin was re-filled correctly
    expect(refilled.maxSolLegDiffPct).toBeLessThan(15); // the bin is back; SOL-leg shape matches (active-bin arb tolerant)
  }, 300_000);

  // 3.4 — extreme shrink (near-liquidation, NOT a close). Remove 90% over the full range → the copy shrinks to a
  // small fraction, but the SOL-leg ratio stays ~half (proportional), and the close after still leaves no dormant.
  it('extreme shrink: leader removes 90% → copy shrinks to <20% of before, solLegRatio stays ~0.5, no dormant after close', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.12 });
    const copyPos = await h.waitForCopy(POOL_STABLE);
    const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(before.maxSolLegDiffPct).toBeLessThan(8);

    // Remove 90% across the FULL range (default from/to = the whole position) — a near-liquidation, not a close.
    await h.leaderRemove(POOL_STABLE, 9_000);

    // The copy must shrink proportionally to ~10% → gate on the ABSOLUTE copy SOL dropping below 20% of before
    // (settle-aware; a ratio reads a stale ≈0.5 mid-flight). A regression that ignored the big remove would stay
    // flat → never crosses 0.2× → waitForCopyResize THROWS → this FAILS.
    const after = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol < before.totalCopySol * 0.2);
    // The SOL-leg ratio is still ≈ COPY_RATIO (0.5) even after a 90% trim — the copy removed PROPORTIONALLY, it
    // didn't over- or under-shoot. Tolerant band: tiny absolute amounts amplify relative noise post-shrink.
    expect(after.solLegRatio).toBeGreaterThanOrEqual(0.4);
    expect(after.solLegRatio).toBeLessThanOrEqual(0.62);

    // After the extreme shrink, a normal close must still leave NO dormant copy (strict — the resetState wait is
    // best-effort; we assert it here).
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copyPos);
  }, 300_000);

  // 3.5 — multi-bin selective remove. Empty TWO DISJOINT single bins (100% each) → the copy carves BOTH holes and
  // keeps every other bin. The shift-invariant shape still matches (two interior holes can't be absorbed by a rigid
  // ±2 frame shift), so maxSolLegDiffPct stays low — but a proportional-shrink regression (no holes) fails it.
  it('multi-bin selective remove: empty TWO disjoint bins (100% each) → copy empties exactly those two, keeps the rest', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.12 });
    const copyPos = await h.waitForCopy(POOL_STABLE);
    const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(before.maxSolLegDiffPct).toBeLessThan(8);

    // Pick two DISJOINT (non-adjacent) interior SOL bins so the two holes are clearly separate AND not at the edge
    // (an edge hole could be partly absorbed by the ±2 best-fit alignment). Need ≥5 bins so index 1 and len−2 are
    // ≥2 apart (truly disjoint). A one-sided spot open spans ~9 SOL bins, so this holds.
    const ls = await h.leaderShape(leaderPos, POOL_STABLE);
    const solBins = ls.bins.filter((b) => b.sol > 0).sort((a, b) => a.off - b.off);
    expect(solBins.length, 'need ≥5 SOL bins to empty two disjoint interior bins').toBeGreaterThanOrEqual(5);
    if (solBins.length < 5) return;
    const lowBin = solBins[1];
    const highBin = solBins[solBins.length - 2];
    expect(lowBin && highBin, 'could not pick two disjoint SOL bins').toBeTruthy();
    if (!lowBin || !highBin) return;
    const binA = ls.activeBinId + lowBin.off;
    const binB = ls.activeBinId + highBin.off;
    await h.leaderRemove(POOL_STABLE, 10_000, binA, binA);
    await h.leaderRemove(POOL_STABLE, 10_000, binB, binB);

    // The bot mirrors BOTH single-bin removes → the copy ends with two holes at the matching offsets. Two of ~9
    // bins gone → shrink to ~78% → gate on <85% (settle-aware; the two removes land as two steps). A proportional
    // regression keeps all bins filled → the two holes never appear → maxSolLegDiffPct blows up → this FAILS.
    const after = await h.waitForCopyResize(POOL_STABLE, leaderPos, copyPos, (copySol) => copySol < before.totalCopySol * 0.85);
    expect(after.maxSolLegDiffPct).toBeLessThan(12); // both holes reproduced at the same offsets; the rest kept
  }, 300_000);

  // 3.6 — range-extension limit (DOCUMENTED v1 limit, ⚠️). The copy holds a SINGLE fixed-range position; it cannot
  // add liquidity to bins outside that range. So when the leader tries to extend BEYOND its range, the copy can only
  // do a PARTIAL copy. This test ENCODES the limit by asserting the copy still BEHAVES (no crash, no orphan, clean
  // close) — it does NOT assert perfect fidelity. NOTE: a single Meteora position's range is fixed at init, so the
  // leader-side extending add is itself rejected on-chain (this is exactly why the 5.1 lifecycle add#2 fails); we
  // tolerate that and prove the copy/bot is unharmed and keeps tracking.
  it('range-extension limit: leader adds BEYOND its fixed range → copy stays valid (no crash/orphan) and closes clean', async () => {
    // NARROW open (3 bins) so "beyond the range" is unambiguous.
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, dist: '1,1,1', sol: 0.1 });
    const copyPos = await h.waitForCopy(POOL_STABLE);
    const before = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    expect(before.totalCopySol, 'the narrow copy did not open').toBeGreaterThan(0); // a real copy landed (sanity)

    // Attempt to EXTEND the leader's range: an `add --dist` with weight ONLY on indices PAST upperBinId (zeros are
    // spacers, dropped by reanchor). The copy's single position cannot follow outside its fixed range → PARTIAL.
    const ls = await h.leaderShape(leaderPos, POOL_STABLE);
    const width = ls.upperBinId - ls.lowerBinId; // current range width (in bins)
    const dist = Array.from({ length: width + 4 }, (_, i) => (i > width ? 1 : 0)).join(','); // weight strictly BEYOND
    // The leader-side add to out-of-range bins is rejected by the SDK/on-chain (fixed-width position) — tolerate it;
    // the point is that the copy must NOT be corrupted by such a leader event, however it resolves.
    // NEEDS-HELPER: to drive a TRUE partial copy (a leader genuinely WIDER than the copy, not a rejected extend) the
    // harness needs a multi-position leader (a 2nd leader position covering the new bins) — a single position's range
    // is fixed at init and cannot be extended. Until then this test documents the limit via the no-harm assertions.
    await h.leaderAdd({ pool: POOL_STABLE, dist, sol: 0.05 }).catch(() => undefined);
    await h.reshapeSettle();

    // DOCUMENTED LIMIT — assert the copy BEHAVES, not perfect fidelity:
    //  (1) the copy still exists on-chain (the bot didn't crash, didn't erroneously close/orphan it on the event).
    expect(await h.accountExists(copyPos)).toBe(true);
    //  (2) the bot is still ALIVE and TRACKING: a subsequent leader close is correctly mirrored → no dormant copy.
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copyPos);
  }, 300_000);
});
