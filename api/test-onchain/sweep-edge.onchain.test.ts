import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UserPosition } from '@/infrastructure/solana/dlmm/leader-position-reader';
import { ensureBotStarted } from './bot-controller';
import { COPIER_TEST, POOL_STABLE, connection, solBalance } from './env';
import { Harness } from './harness';

/**
 * REAL on-chain edge tests — FEATURE 7.4 (sweep keeps the SOL reserve) + FEATURE 9.1/9.2/9.4 (dust no-churn,
 * remove-to-zero, reopen-after-close). Each FAILS on a genuine regression (churn on dust, a wrongly-trimmed/closed
 * copy, a stale re-copy, a drained wallet), never on the happy path alone (Rule 8).
 *
 * NO-CHURN technique (9.1 + 9.2): a sub-deadband dust add (or a zero-total empty leader) barely moves the copy's
 * SOL size — a size delta alone cannot tell "kept the copy" from "rebuilt it". So the no-churn proof reads the
 * brain's OWN decision log (`/tmp/bench-brain.log`, tee'd by bot-controller): a `"reshape published"` line means it
 * CHURNED; a `"in sync — no adjustment"` line means it saw the leader event and correctly left the copy untouched.
 * The brain logs these at `info` (pino default), the same level the harness already parses for the open pubkey.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Brain stdout tee written by bot-controller's spawnUntil (same file the harness reads for the published copy).
const BRAIN_LOG = '/tmp/bench-brain.log';
// brain msg "🔧 reshape published (per-bin exact)" — a reshape tx WAS issued (the churn signal).
const RESHAPE_MARKER = 'reshape published';
// brain msg "⚖️ in sync — no adjustment" — the bot processed the leader event and deliberately kept the copy as-is.
const IN_SYNC_MARKER = 'no adjustment';

const TOKEN_CLEAN_RAW = 100_000n; // RAW token balance below this = swept clean (matches robustness.onchain.test.ts)
const MIN_SOL_RESERVE = 0.05; // COPYBOT reserve (TEST-PLAN bench config); the always-to-SOL sweep must leave at least this much NATIVE SOL — it converts the non-SOL token, never SOL itself
const RESYNC_DECISION_TIMEOUT_MS = 30_000; // max wait for the brain to PROCESS a leader resync (WS detect + handleResync + log)
const SWEEP_WINDOW_MS = 80_000; // max wait for the periodic token→SOL sweep (matches robustness.onchain.test.ts)
const POSITIONS_SETTLE_MS = 30_000; // max wait for the SDK position enumerator (lags fresh opens/closes) to settle

function readBrainLog(): string {
  try {
    return readFileSync(BRAIN_LOG, 'utf8');
  } catch {
    return ''; // log not created yet → no lines
  }
}

/** Count brain-log lines mentioning BOTH `marker` and `position`. pino emits one JSON line per log call with the
 *  bindings inline (`{... "position":"<leaderPos>", ..., "msg":"<marker>"}`); scoping by the leader position pubkey
 *  isolates THIS test's resync events from earlier tests (the brain log is NOT truncated between tests in a run). */
function countLogLines(log: string, marker: string, position: string): number {
  return log.split('\n').filter((l) => l.includes(marker) && l.includes(position)).length;
}

/**
 * Wait until the brain PROCESSES a leader resync event for `position` and assert it took the NO-CHURN path (a NEW
 * "in sync — no adjustment", NO new "reshape published"). THROWS (test FAILS) on:
 *  - a "reshape published" line → the bot CHURNED (deadband regressed/removed) — fee-bleed,
 *  - a timeout                  → no decision logged → the leader event was likely MISSED (the cardinal sin).
 */
async function expectInSyncNoChurn(position: string, baseReshape: number, baseInSync: number, timeoutMs = RESYNC_DECISION_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = readBrainLog();
    if (countLogLines(log, RESHAPE_MARKER, position) > baseReshape) {
      throw new Error(`CHURN: brain published a reshape for ${position} on a sub-deadband/zero-total leader change (expected "in sync — no adjustment")`);
    }
    if (countLogLines(log, IN_SYNC_MARKER, position) > baseInSync) return; // saw the event, correctly kept the copy
    await sleep(1500);
  }
  throw new Error(`timeout: brain logged no resync decision for ${position} within ${timeoutMs}ms — the leader event was likely MISSED`);
}

describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · sweep reserve + edge actions (FEATURE 7.4 + 9.1/9.2/9.4)', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  /** Poll the (lagging) SDK enumerator until the copier's positions on `pool` satisfy `predicate`, then return the
   *  reading. On timeout returns the LAST reading so the caller's assertion reports the real (wrong) state. */
  const pollCopierPositions = async (pool: string, predicate: (p: UserPosition[]) => boolean, timeoutMs = POSITIONS_SETTLE_MS): Promise<UserPosition[]> => {
    const deadline = Date.now() + timeoutMs;
    let last: UserPosition[] = [];
    while (Date.now() < deadline) {
      last = await h.copierPositions(pool);
      if (predicate(last)) return last;
      await sleep(3000);
    }
    return last;
  };

  // 7.4 — after a two-sided close + sweep, the copier's NON-SOL token is converted to SOL AND it still holds its
  // native-SOL reserve (the sweep never feeds SOL itself into Jupiter / drains the gas). A regression that swept
  // native SOL would empty the wallet → the reserve assertion fails. (No helper needed: solBalance is exported.)
  it('7.4 sweep keeps the SOL reserve — two-sided close → token swept, native SOL not drained', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, twosided: true, sol: 0.1, token: 4_000_000 });
    const copy = await h.waitForCopy(POOL_STABLE, 60_000); // two-sided opens build-after-buy → slower
    const solMidOpen = await solBalance(connection(), COPIER_TEST); // diagnostic baseline (mid-open, SOL deployed)
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy); // the close returns SOL + the token leg into the copier wallet

    // Poll until the swept (USDC) token leg is gone — modelled on robustness.onchain.test.ts.
    const start = Date.now();
    let clean = false;
    while (Date.now() - start < SWEEP_WINDOW_MS) {
      const tokens = await h.copierTokens();
      if (tokens.every((t) => t.amountRaw < TOKEN_CLEAN_RAW)) {
        clean = true;
        break;
      }
      await sleep(5000);
    }
    expect(clean, 'copier still holds a non-SOL token after the sweep window — DORMANT TOKEN').toBe(true);

    // The sweep converted the token to SOL but must KEEP a native-SOL reserve. solBalance reads the chain directly.
    const solAfter = await solBalance(connection(), COPIER_TEST);
    expect(solAfter, `copier SOL drained to ${solAfter.toFixed(4)} — the always-to-SOL sweep must keep the gas reserve, never sweep SOL itself`).toBeGreaterThanOrEqual(MIN_SOL_RESERVE);
    console.log(`💰 7.4 copier SOL: mid-open ${solMidOpen.toFixed(4)} → after sweep ${solAfter.toFixed(4)} (≥ reserve ${MIN_SOL_RESERVE})`);
  }, 240_000);

  // 9.1 (dust no-churn) is covered OFF-CHAIN, NOT here: an on-chain micro-add can't be reliably held below the
  // per-bin reshape deadband (the bench's spot add concentrates near the active bin → a bin's delta exceeds the
  // 0.0002 SOL deadband → the bot CORRECTLY reshapes, so it's not "dust"). The deadband logic — "a per-bin change
  // within the deadband produces NO reshape op" — is deterministically unit-tested in
  // `src/domain/copybot/position-adjust.test.ts` ("per-bin wiggle within the deadband → no churn" → planReshape === []).
  // Forcing it on-chain would be a miscalibrated, flaky test (Rule 8: no fake/fragile tests).

  // 9.2 — remove-to-zero (NOT close): empty ALL the leader's liquidity over the full range. The position account
  // persists empty, so planReshape (leaderTotal=0) short-circuits → the bot logs "in sync" and KEEPS the copy open
  // (documented: emptied→still-open; a zero-total leader gives no shape to mirror — the CLOSE, not the empty,
  // cleans the copy). Then leaderClose → the copy is closed, no dormant. Tolerant of a bench remove that auto-closes.
  it('9.2 remove-to-zero (not close) — emptied leader kept open; close then resets clean, no dormant', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy = await h.waitForCopy(POOL_STABLE);
    expect(await h.accountExists(copy), 'copy did not land on-chain').toBe(true);

    const log0 = readBrainLog();
    const baseReshape = countLogLines(log0, RESHAPE_MARKER, leaderPos);
    const baseInSync = countLogLines(log0, IN_SYNC_MARKER, leaderPos);

    await h.leaderRemove(POOL_STABLE, 10_000); // 100% over the full range — empties liquidity (may NOT close the account)

    if (await h.accountExists(leaderPos)) {
      // Targeted case: leader emptied-but-OPEN. The bot must see the remove and keep the copy (no trim/close).
      await expectInSyncNoChurn(leaderPos, baseReshape, baseInSync);
      expect(await h.accountExists(copy), 'copy closed while the leader is still open-but-empty (documented: emptied→still-open)').toBe(true);
      console.log('📍 9.2 leader emptied-but-OPEN → bot logged "in sync", copy kept open (documented: emptied→still-open)');
    } else {
      // The bench's remove(100%) auto-closed the leader (not the targeted empty-but-open path) — the close path cleans up.
      console.warn('9.2: leaderRemove(100%) auto-closed the leader position — the close/reconcile path will clean the copy');
    }

    // Whatever the intermediate, the close MUST reset to a fully clean slate: no dormant copy, no dormant position.
    // close-ALL (not close): an emptied-but-open leader is invisible to `close` (it has no liquidity to find), so we
    // must close it explicitly → the bot detects the close (or the reconcile, once the leader is truly gone) and
    // closes the copy. waitForCopyClosed gets a longer window: an emptied-then-closed leader can rely on the
    // reconcile backstop (the empty close carries no withdraw leg for the WS path) which is gated by the open-grace.
    await h.leaderCloseAll(POOL_STABLE);
    await h.waitForCopyClosed(copy, 120_000);
    expect(await h.accountExists(copy), 'copy still on-chain after close — DORMANT POSITION').toBe(false);
    const end = await pollCopierPositions(POOL_STABLE, (p) => p.length === 0);
    expect(end.length, 'copier still tracks a position on the pool after close — DORMANT POSITION').toBe(0);
  }, 240_000);

  // 9.4 — reopen after close on the SAME pool: the second copy must be a FRESH, distinct position (no resurrection
  // of, or stale tracking from, the closed first copy). A regression that re-used/re-tracked copy1 → copy2===copy1
  // (or a lingering copy1) → fails.
  it('9.4 reopen after close — the second copy is fresh and distinct, no stale state from the first', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy1 = await h.waitForCopy(POOL_STABLE);
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy1);
    expect(await h.accountExists(copy1), 'first copy not fully closed before reopen').toBe(false);

    // Reopen the SAME pool. waitForCopy returns the LATEST published open — it cannot return copy1 (its account is gone).
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy2 = await h.waitForCopy(POOL_STABLE);

    // The real "fresh, distinct, no resurrection" proof is via DIRECT account reads (no enumerator lag): copy2 is a
    // NEW pubkey, copy2 is live, copy1 stays gone. (We do NOT assert a copierPositions count: the SDK enumerator
    // lags a CLOSE by >30s, so it can still list the already-closed copy1 — that's a read artifact, not the bot's
    // tracking. accountExists below is the authoritative, lag-free signal.)
    expect(copy2, 'reopen produced the SAME copy pubkey as the closed one — stale resurrection').not.toBe(copy1);
    expect(await h.accountExists(copy2), 'second copy did not land on-chain').toBe(true);
    expect(await h.accountExists(copy1), 'the first (closed) copy reappeared on-chain — stale resurrection').toBe(false);
  }, 240_000);
});
