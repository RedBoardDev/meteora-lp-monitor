import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, POOL_VOLATILE, connection } from './env';
import { Harness } from './harness';
import { sleep } from './util';

// REAL multi-position coverage (TEST-PLAN FEATURE 4). The bot must track MORE than one position at a time — both
// several positions on the SAME pool and one position on TWO different pools — without confusing them: copy ALL of
// them, and when a leader closes, close ONLY the matching copy (no cross-close, no missed close, no dormant).
//
// Why STRUCTURE (counts + existence), not per-position fidelity: pairing a copy to its leader by pubkey is not
// possible with the current harness (the copy keypair is generated bot-side; two same-pool opens can even share a
// bin range). So we assert on the COUNT of copies and on full-reset-to-zero. That still discriminates the real
// regressions this feature guards against: copying only ONE of two positions, or false-closing the wrong number.
//
// Detection note: `waitForCopy(pool)` returns only the LATEST copy pubkey the brain published (from its log) — it
// cannot distinguish/confirm multiple concurrent copies. So copy COUNTING goes through `copierPositions(pool)` (the
// SDK enumerator = the source of truth for "how many copies exist"). That enumerator LAGS fresh opens/closes by a
// few seconds, so every count assertion polls it via `waitForCopierCount` until the expected count appears.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · multiple positions — structure (counts + existence)', () => {
  let h: Harness;

  const COUNT_TIMEOUT_MS = 90_000; // stable pool: time for the copy to land AND the SDK enumerator to catch up
  const COUNT_POLL_MS = 3_000; // enumerator re-read cadence while waiting for a count to settle
  const KEPT_COPY_SETTLE_MS = 25_000; // window to re-confirm a kept copy was NOT later false-closed (WS/reconcile tick)
  const MAX_CLEANUP_CLOSES = 3; // a test opens at most 2 leader positions per pool → bound the afterEach close loop

  type CopierPositions = Awaited<ReturnType<Harness['copierPositions']>>;

  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });

  /**
   * Poll the SDK position enumerator until EXACTLY `expected` copies are reported on `pool`, or throw on timeout.
   * Using an exact count (not >=) is what makes the close path discriminating: a cross-close that drops the count
   * past the expected value never settles there → this throws → the test FAILS. A missed copy/close that leaves
   * the count too high likewise never reaches the target → FAIL.
   */
  const waitForCopierCount = async (pool: string, expected: number, timeoutMs = COUNT_TIMEOUT_MS): Promise<CopierPositions> => {
    const deadline = Date.now() + timeoutMs;
    let last: CopierPositions = [];
    while (Date.now() < deadline) {
      last = await h.copierPositions(pool);
      if (last.length === expected) return last;
      await sleep(COUNT_POLL_MS);
    }
    throw new Error(`timeout: copierPositions(${pool}) = ${last.length}, expected ${expected} within ${timeoutMs}ms`);
  };

  afterEach(async () => {
    // resetState closes only the FIRST leader position with liquidity (readLeaderPositionShape), but a multi-
    // position test can leave a SECOND leader position open. Close leader positions until none remain, then run
    // the standard per-pool guardrail (waits for the copies to close + sweeps). Both pools are reset, since the
    // different-pools test touches POOL_VOLATILE. NEEDS-HELPER: a central resetStateAll(pool) that closes ALL
    // leader positions on a pool would replace this bounded loop.
    for (const pool of [POOL_STABLE, POOL_VOLATILE]) {
      for (let i = 0; i < MAX_CLEANUP_CLOSES && (await h.leaderPositions(pool)).length > 0; i++) {
        await h.leaderClose(pool);
      }
      await h.resetState(pool);
    }
  });

  // 4.1 — two positions on the SAME pool: the bot copies BOTH, and closing the leaders one at a time drives the
  // copier count 2 → 1 → 0 (no cross-close, no missed close, no dormant). Assumes a clean slate at start (the
  // sequential bench + afterEach guarantee it), so the absolute counts measure a true delta.
  it('4.1 two positions on the SAME pool → bot copies BOTH; closing leaders drives the count 2→1→0 (no dormant)', async () => {
    // leader-control `open` generates a NEW position keypair each call → two DISTINCT on-chain positions (not a
    // reshape of one). Wait for the FIRST copy to be enumerated BEFORE opening the second, so the bot is provably
    // tracking #1 while it handles #2.
    const leader1 = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    await waitForCopierCount(POOL_STABLE, 1);
    const leader2 = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    expect(leader2, 'leader-control opened the same position twice — test setup is invalid').not.toBe(leader1);

    // KEY assertion: the bot tracks BOTH positions concurrently on one pool (the tracker is keyed by leader
    // position pubkey). A regression that copies only ONE of two (e.g. keying mirror state by pool) never reaches
    // 2 → the poll throws → FAIL.
    const both = await waitForCopierCount(POOL_STABLE, 2);
    expect(new Set(both.map((p) => p.position)).size, 'expected two DISTINCT copy positions, not one double-counted').toBe(2);

    // Close ONE leader position. NEEDS-HELPER: close a SPECIFIC leader position by pubkey — leader-control `close`
    // closes the FIRST leader position with liquidity, so we cannot pin WHICH leader closes and therefore cannot
    // verify the bot kept the MATCHING copy. We assert on STRUCTURE: closing ONE leader must drive the copier count
    // to EXACTLY 1 (one copy closed, the other KEPT). A cross-close (closes both) drops to 0 → never settles at 1
    // → FAIL; a missed close stays at 2 → FAIL.
    await h.leaderClose(POOL_STABLE);
    await waitForCopierCount(POOL_STABLE, 1);
    // Re-confirm the kept copy was NOT subsequently FALSE-closed (by a late WS handler or a reconcile tick): the
    // remaining leader position is still open, so the count must stay at 1 across a settle window. (The primary
    // discriminator is the count transition itself; this guards against a DELAYED cross-close.)
    await sleep(KEPT_COPY_SETTLE_MS);
    expect((await h.copierPositions(POOL_STABLE)).length, 'kept copy was FALSE-closed after the other leader closed').toBe(1);

    // Close the SECOND leader position → full reset → the bot closes the remaining copy → 0 dormant.
    await h.leaderClose(POOL_STABLE);
    await waitForCopierCount(POOL_STABLE, 0);
    expect((await h.copierPositions(POOL_STABLE)).length, 'a dormant copy remained after both leaders closed').toBe(0);
  }, 300_000);

  // 4.2 — CROSS-POOL independence: a second pool's leader open/close must NOT disturb the stable copy. The bot keys
  // tracking by position PUBKEY, so pools are independent. We anchor on the STABLE copy via DIRECT account reads
  // (lag-free) and treat the VOLATILE COPY as BEST-EFFORT: the volatile pool's active bin makes that open two-sided,
  // whose copy needs a Jupiter buy of an illiquid Token-2022 pump token — environment-fragile (confirmed on-chain),
  // so hard-asserting it lands would be a flaky test (Rule 8). We instead assert the volatile LEADER's open + close
  // never disturbs the stable copy, and that nothing is left dormant.
  it('4.2 cross-pool independence — a volatile-pool leader open/close does NOT disturb the stable copy; no dormant', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const stableCopy = await h.waitForCopy(POOL_STABLE);
    expect(await h.accountExists(stableCopy), 'stable copy did not land').toBe(true);

    // Volatile LEADER open — its copy may or may not land (fragile two-sided Jupiter path); the stable copy must be untouched.
    await h.leaderOpen({ pool: POOL_VOLATILE, strategy: 'spot', sol: 0.1 });
    await sleep(20_000);
    expect(await h.accountExists(stableCopy), 'the volatile-pool OPEN disturbed the stable copy (cross-pool interference)').toBe(true);

    // Close the VOLATILE leader (close-all handles a stuck/empty two-sided leader) → the stable copy must STILL live.
    await h.leaderCloseAll(POOL_VOLATILE);
    await sleep(20_000);
    expect(await h.accountExists(stableCopy), 'closing the VOLATILE leader cross-closed the stable copy').toBe(true);

    // Now close the STABLE leader → its copy closes (the stable side was tracked + closeable throughout).
    await h.leaderCloseAll(POOL_STABLE);
    await h.waitForCopyClosed(stableCopy);
    expect(await h.accountExists(stableCopy), 'stable copy not closed').toBe(false);

    // Clean slate on both pools (afterEach also resets; assert the stable pool here — the volatile copy, if it ever
    // landed, is closed by the afterEach close-all + reconcile).
    expect((await waitForCopierCount(POOL_STABLE, 0)).length, 'dormant copy remained on the stable pool').toBe(0);
  }, 300_000);
});
