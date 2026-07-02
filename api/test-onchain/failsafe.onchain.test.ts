import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted, killBrain, restartBrain } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';
import { sleep } from './util';

// FEATURE 6 — fail-safe / no-miss / chaos: the #1 robustness pillar (copybot-restart-semantics). A crash, a lost
// WS signal, a mid-flight open, a restart with many positions, a rapid open→close — NONE may leave a dormant copy
// position or a stuck (un-swept) token. Every assertion below FAILS if a no-miss guarantee regresses: a dormant
// orphan, a false-close, a duplicate, or a token the sweep never reclaimed. Mirrors resume.onchain.test.ts (kill/
// restart the brain via bot-controller; read on-chain truth directly via accountExists — no enumerator lag).
//
// NEEDS-HELPER (6.6 coffre crash idempotency): bot-controller exposes killBrain/restartBrain but NO killCoffre /
// restartCoffre (only startCoffre + stopBot, which also kills the brain). 6.6 needs to kill+restart the COFFRE
// alone (brain stays up) to prove a pending `cmd:sign` is re-consumed and lands EXACTLY once. Not implementable
// with the current controller → 6.6 is intentionally NOT in this file.

// The copier-token "clean" floor: a residual below this raw amount is dust/closed-out, not a dormant token leg.
// Matches the robustness sweep test's threshold (well under the bench DUST_TOKEN_RAW=1e6).
const TOKEN_CLEAN_FLOOR_RAW = 100_000n;

// Timing constants (named per the no-magic-numbers rule).
const MISSED_CLOSE_BACKSTOP_MS = 60_000; // window for the boot reconcile / cursor-poll to close a WS-missed close
const MID_OPEN_KILL_DELAY_MS = 2_000; // long enough for the open WS event to be SEEN, short enough that the copy has NOT landed
const RAPID_CLOSE_DELAY_MS = 3_000; // close almost immediately after the open — before the copy can settle
const RESTART_SETTLE_MS = 40_000; // boot reconcile + at least one RECON_MS tick (same settle as resume 6.2)
const MULTI_COPY_LAND_MS = 90_000; // two SEQUENTIAL opens → window for BOTH copies to build + land
const CLEAN_END_STATE_MS = 80_000; // generous window for the no-miss recovery (close + sweep) to reach a clean slate
const POLL_MS = 3_000; // position-count poll cadence
const END_STATE_POLL_MS = 4_000; // combined (positions + tokens) poll cadence

// copierPositions() reads through the SDK enumerator, which LAGS fresh opens/closes by a few seconds — so we POLL
// the on-chain position count to a target instead of reading once. Returns true once reached, false on timeout.
async function waitForCopierPositionCount(h: Harness, pool: string, target: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await h.copierPositions(pool)).length === target) return true;
    await sleep(POLL_MS);
  }
  return false;
}

// Poll until the copier wallet reaches a CLEAN end state: zero positions on `pool` AND no above-floor token.
// Returns the last observed values (so a timeout asserts the actual residual, not just "false"). The no-miss
// guarantee = this becomes clean; a regression that orphans a position or strands a token never does → FAIL.
async function waitForCleanEndState(h: Harness, pool: string, timeoutMs: number, ignoreMints: Set<string>): Promise<{ positions: number; clean: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let positions = -1;
  let clean = false;
  while (Date.now() < deadline) {
    positions = (await h.copierPositions(pool)).length;
    clean = await h.copierCleanOf(ignoreMints, TOKEN_CLEAN_FLOOR_RAW); // ignore pre-existing session dust (illiquid Token-2022)
    if (positions === 0 && clean) return { positions, clean };
    await sleep(END_STATE_POLL_MS);
  }
  return { positions, clean };
}

describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · fail-safe — no-miss / chaos (FEATURE 6)', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(async () => {
    await ensureBotStarted(); // recover the brain for the next test (some tests below leave it killed/restarted)
    await h.resetState(POOL_STABLE);
  });

  // 6.3 — MISSED-CLOSE BACKSTOP (cursor-poll completeness path). The leader closes while the brain is DOWN, so the
  // WS open/close stream never delivers the close — the brain comes back with NO live event for it. The only thing
  // that can save us is the boot completeness backstop: the cursor-poll / reconcile re-derives the leader's true
  // on-chain state (gone) and closes our orphan. This is 6.1's scenario reframed to exercise the cursor-poll path,
  // NOT the live WS handler. FAILS if a missed close (the most dangerous miss) leaves a dormant copy.
  it('6.3 missed-close backstop: leader closes during brain downtime → boot cursor-poll/reconcile closes the orphan', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy = await h.waitForCopy(POOL_STABLE);
    expect(await h.accountExists(copy)).toBe(true);

    await killBrain(); // 💥 brain down → the close that follows is NEVER seen on the live WS stream
    await h.leaderClose(POOL_STABLE); // the leader closes during the blackout (no live brain to catch the WS event)
    await restartBrain(); // 🔁 reboot → the cursor-poll/reconcile completeness backstop must reconstruct "leader gone"

    await h.waitForCopyClosed(copy, MISSED_CLOSE_BACKSTOP_MS); // throws (test fails) if the backstop misses the close
    expect(await h.accountExists(copy), 'WS-missed close left a DORMANT copy — cursor-poll backstop regressed').toBe(false);
  }, 300_000);

  // 6.4 — BRAIN DIES MID-OPEN (hardest no-miss case). We kill the brain a couple seconds after the leader opens —
  // the open event was seen but the copy has NOT landed (mid-build; for a two-sided this would be after the buy but
  // before the deposit). On restart the brain may finish/redo the copy LATE or never start it; either is fine. The
  // invariant: once the leader is gone, the end state is clean — NO dormant copy position AND NO stranded bought
  // token (the boot sweep recovers anything left mid-flight). FAILS if recovery leaves an orphan or a stuck token.
  it('6.4 brain dies mid-open → on restart no orphan position and no stranded token (sweep recovers any mid-flight buy)', async () => {
    const before = await h.copierMints(); // pre-existing session dust to ignore in the clean check
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    await sleep(MID_OPEN_KILL_DELAY_MS); // open SEEN, copy NOT yet landed
    await killBrain(); // 💥 crash mid-open — the copy may be half-built (or a token half-bought) and never placed
    await restartBrain(); // 🔁 reboot → reconcile + boot sweep must clean up whatever was left mid-flight

    await h.leaderClose(POOL_STABLE); // the leader goes away; any (late) copy is now an orphan unless the bot closes it
    expect(await h.accountExists(leaderPos), 'leader close did not land — clean-state assertion would be vacuous').toBe(false);

    const end = await waitForCleanEndState(h, POOL_STABLE, CLEAN_END_STATE_MS, before);
    expect(end.positions, 'DORMANT copy after a mid-open crash + leader close — no-miss recovery regressed').toBe(0);
    expect(end.clean, 'copier still holds a non-SOL token after the mid-open crash — boot sweep missed it').toBe(true);
  }, 300_000);

  // 6.5 — RESTART WITH MULTIPLE OPEN POSITIONS. The leader holds TWO independent positions on the same pool, both
  // copied. On a brain restart, the boot reconcile must keep BOTH: open-grace protects them, the per-position
  // matching must not false-close a healthy copy, and the replay must not re-open a DUPLICATE. We assert the count
  // is STILL exactly 2 after the settle (a single read post-settle is strict: <2 = a false-close, >2 = a duplicate).
  it('6.5 restart with 2 open positions → both reconciled (none false-closed, none orphaned, none duplicated)', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 }); // leader position #1
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 }); // leader position #2 (distinct account)
    const bothCopied = await waitForCopierPositionCount(h, POOL_STABLE, 2, MULTI_COPY_LAND_MS);
    expect(bothCopied, 'the bot did not copy BOTH leader positions before the restart').toBe(true);

    await restartBrain(); // 🔁 reboot with two live copies on the books
    await sleep(RESTART_SETTLE_MS); // let the boot reconcile + at least one RECON tick run (open-grace must hold both)

    const after = (await h.copierPositions(POOL_STABLE)).length;
    expect(after, 'restart did not preserve EXACTLY 2 copies (<2 = a healthy copy was false-closed; >2 = a duplicate)').toBe(2);

    // Full reset: close BOTH leader positions (leaderClose closes one live position per call) → the bot must close
    // both copies. Poll the copier count to 0 so the next test starts on a clean slate.
    await h.leaderClose(POOL_STABLE); // closes leader position #1
    await h.leaderClose(POOL_STABLE); // closes the remaining leader position #2
    const allClosed = await waitForCopierPositionCount(h, POOL_STABLE, 0, CLEAN_END_STATE_MS);
    expect(allClosed, 'the bot did not close all copies after both leaders closed — dormant position left behind').toBe(true);
  }, 300_000);

  // 6.7 — RAPID OPEN→CLOSE. The leader closes ~3s after opening, before the copy can settle — the close may arrive
  // while the copy is still building (or before it ever starts). The bot must NOT orphan: end state = no copy
  // position and no stuck token, whether the copy never opened or opened-then-closed. We confirm the LEADER really
  // closed (accountExists on the pubkey we hold) so "no copy" is a real no-orphan result, not a silently-failed close.
  it('6.7 rapid open→close (close before the copy settles) → no orphan position, no stuck token', async () => {
    const before = await h.copierMints(); // pre-existing session dust to ignore in the clean check
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    await sleep(RAPID_CLOSE_DELAY_MS); // close almost immediately — race the copy build
    await h.leaderClose(POOL_STABLE);
    expect(await h.accountExists(leaderPos), 'leader close did not land — no-orphan assertion would be vacuous').toBe(false);

    const end = await waitForCleanEndState(h, POOL_STABLE, CLEAN_END_STATE_MS, before);
    expect(end.positions, 'rapid open→close ORPHANED a copy position (close-before-settle not handled)').toBe(0);
    expect(end.clean, 'rapid open→close left a stuck non-SOL token on the copier').toBe(true);
  }, 300_000);
});
