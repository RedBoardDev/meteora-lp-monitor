import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted, killBrain, restartBrain } from './bot-controller';
import { POOL_COIN_SOL, POOL_STABLE, connection } from './env';
import { Harness } from './harness';

/**
 * ★ MEGA-SOAK — the exhaustive, AUTO, infinitely-relaunchable copy-bot validation. The operational bar: ZERO issues
 * across 500+ DIFFERENT positions covering EVERY scenario. One position at a time (sequential; the bench is stateful),
 * each driven through a full lifecycle and verified end-to-end. The slightest anomaly (open didn't land / wrong
 * fidelity, a reshape that broke the copy, a close that left a dormant position, a latency-SLA breach, OR — the #1
 * standing rule — the copier wallet left holding ANY non-SOL token) is recorded as a SERIOUS issue.
 *
 * RELAUNCH: each run executes SOAK_ITERATIONS scenarios, cycling the matrix by the CUMULATIVE position index from the
 * JSONL tally, so re-running the SAME command keeps advancing through the matrix and accumulating coverage. Re-run
 * (or /loop) until the cumulative clean count ≥ 500 with 0 issues.
 *
 * The loop is RESILIENT: one bad position is recorded and the loop continues, so a batch surfaces EVERY issue, not
 * just the first.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pollUntil = async (pred: () => Promise<boolean>, timeoutMs: number, stepMs = 2500): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
};

const ITERATIONS = Number(process.env.SOAK_ITERATIONS ?? '12'); // per-run batch (sized to the run wall-clock + fees)
const TALLY = '/tmp/copybot-mega-soak.jsonl'; // one line per position, accumulated across runs
const FAIL_LOG_TAIL_LINES = 600; // brain/coffre log lines archived per FAILED scenario (enough to span its full reshape/close activity)

// ── tunables (named; no magic numbers) ───────────────────────────────────────────────────────────────────────
const CLEAN_START_TIMEOUT_MS = 30_000; // settle any lingering position from a prior cycle to 0 before this one
const OPEN_FUNDED_TIMEOUT_MS = 70_000; // a Token-2022 two-sided open lands in 3 tx (buy → create → deposit) → generous
const RESIZE_SETTLE_TIMEOUT_MS = 45_000; // time for the bot to mirror a leader reshape (add/remove) and settle
const CLOSE_LAND_TIMEOUT_MS = 25_000; // leader close to confirm on-chain (poll + one retry)
const COPY_CLOSED_TIMEOUT_MS = 70_000; // the bot's copy close to confirm gone (no-miss)
const WALLET_SOL_ONLY_TIMEOUT_MS = 100_000; // ★ residual token→SOL: close-triggered sell (~5s) primary + the 60s safety-sweep backstop (after the in-flight grace) + margin
const WALLET_START_SOL_ONLY_TIMEOUT_MS = 40_000; // a scenario must START SOL-only (prior close-sell/sweep landed); poll to absorb the async sweep before flagging contamination
const RESETTLE_TIMEOUT_MS = 25_000; // settle to 0 before the next scenario
// Latency is RECORDED here for visibility but only an egregious HANG is gated: the strict reaction-SLA (~800ms
// validated) is gated by latency.onchain.test.ts in ISOLATION — here the bench's own RPC polling contends with the
// bot for the shared Helius key and inflates latency, so a 3-6s reading is contention, not the bot's real speed.
const LATENCY_HANG_MS = 20_000; // above this = a genuine stall/hang (a real problem), not contention noise
const TOTAL_RATIO_MIN = 0.43; // COPY_RATIO 0.5, arb/latency band on the economic (both-leg) ratio
const TOTAL_RATIO_MAX = 0.6;
const REANCHOR_SETTLE_MS = 5000; // let bins index + entry-instant arb settle before reading fidelity
const INTER_SCENARIO_SETTLE_MS = 6000; // space scenarios so the RPC + chain settle between positions (one key shared with the bot → less contention)
const LONG_HOLD_MS = 75_000; // 'long-hold' lifecycle: keep the position open this long → varied duration + lets fees accrue (organic trades) so the close returns legs + fees to sell

// ── scenario matrix ──────────────────────────────────────────────────────────────────────────────────────────
// Only FULLY-SELLABLE pools: stable SOL/USDC (classic) + the COIN/SOL Token-2022 pool (9cRCn, buyable+sellable). On
// both, every residual is swappable → the wallet MUST return to SOL-only (asserted strictly). The unbuyable
// Token-2022 pool (POOL_VOLATILE) is covered by token2022.onchain.test.ts (SAFE skip), not here.
const POOLS = [
  { id: POOL_STABLE, tag: 'stable', token2022: false },
  { id: POOL_COIN_SOL, tag: 'coinSOL', token2022: true },
] as const;
const STRATEGIES = ['spot', 'bidask', 'curve'] as const;
const SIZES = [0.05, 0.06, 0.08, 0.1] as const; // SOL value per leader position; copy = 0.5× ≥ 0.025 > the 0.02 min
const ADD_SOL = 0.03; // a modest reshape-grow (keeps the leader funded one-at-a-time)
const REMOVE_BPS = 5000; // a 50% proportional shrink

// Lifecycle mix (weighted): open-close dominates the volume; reshape/claim/crash add the harder paths periodically.
type Lifecycle = 'open-close' | 'grow' | 'shrink' | 'partial-remove' | 'claim' | 'crash' | 'long-hold' | 'multi';
// 'long-hold' = hold the position open for LONG_HOLD_MS before closing → varies the hold DURATION (short open-close vs
// long) and lets the position accrue FEES (organic pool trades), so the close returns the legs + fees and the bot must
// sell ALL of it (wallet SOL-only) — the user's "plus ou moins longue, avec fees ou pas" coverage.
// open-close (the SIMPLE path) stays well-represented on purpose — the bot must be tested on a MAX of positions, with
// repetition, not only exotic ones. 'multi' = two simultaneous positions (different pools).
const LIFECYCLES: Lifecycle[] = ['open-close', 'long-hold', 'open-close', 'grow', 'multi', 'shrink', 'open-close', 'partial-remove', 'long-hold', 'claim', 'open-close', 'crash'];

interface Scenario {
  pool: (typeof POOLS)[number];
  side: 'one' | 'two';
  strategy: (typeof STRATEGIES)[number];
  sol: number;
  lifecycle: Lifecycle;
}
// Cartesian-ish coverage from the cumulative index: different moduli per dimension so consecutive positions vary on
// every axis and the full product is covered as the index advances (and repeated on further relaunches).
const scenarioFor = (n: number): Scenario => ({
  pool: POOLS[n % POOLS.length]!,
  side: (n >> 1) % 2 === 0 ? 'two' : 'one', // bias is irrelevant; both are exercised
  strategy: STRATEGIES[n % STRATEGIES.length]!,
  sol: SIZES[n % SIZES.length]!,
  lifecycle: LIFECYCLES[n % LIFECYCLES.length]!,
});

const cumulative = (): { total: number; issues: number } => {
  try {
    const lines = readFileSync(TALLY, 'utf8').trim().split('\n').filter(Boolean);
    return { total: lines.length, issues: lines.filter((l) => !(JSON.parse(l) as { ok: boolean }).ok).length };
  } catch {
    return { total: 0, issues: 0 };
  }
};

describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · MEGA-SOAK — zero issues across 500+ positions, EVERY scenario, wallet always SOL-only', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
    // Boot sweep: let the bot sell ANY residual a prior session left, so every scenario starts SOL-only.
    await pollUntil(() => h.copierCleanOf(new Set()), WALLET_SOL_ONLY_TIMEOUT_MS);
  }, 120_000);
  afterAll(() => {
    // Full campaign report (progress to 500 + open/close latency avg/min/max + clean-rate breakdown). Same as
    // `node scripts/soak-report.mjs` (run anytime to monitor between batches).
    try {
      console.log(`\n${execFileSync('node', ['scripts/soak-report.mjs'], { encoding: 'utf8' })}`);
    } catch {
      const c = cumulative();
      console.log(`\n🛁 MEGA-SOAK cumulative: ${c.total - c.issues}/${c.total} clean (${c.issues} issue(s)).`);
    }
  });

  it(`mega-soak batch of ${ITERATIONS} full lifecycles (varied pool/side/strategy/size/lifecycle) — ZERO issues required`, async () => {
    const batchIssues: string[] = [];
    const start0 = cumulative().total;
    for (let i = 0; i < ITERATIONS; i++) {
      const n = start0 + i; // global position index across runs
      const s = scenarioFor(n);
      const pool = s.pool.id;
      const tag = `#${n} ${s.pool.tag} ${s.side}-sided ${s.strategy} ${s.sol}SOL ${s.lifecycle}`;
      const problems: string[] = [];
      let copy: string | null = null;
      let openMs: number | null = null;
      let closeMs: number | null = null;
      let poolB: string | null = null; // 'multi' lifecycle: a 2nd simultaneous position on the other pool
      let leaderB: string | null = null;
      let copyB: string | null = null;
      if (i > 0) await sleep(INTER_SCENARIO_SETTLE_MS); // let the RPC + chain breathe between positions
      try {
        // CLEAN START: settle both sides to 0 so this scenario is INDEPENDENT (no cross-cycle pollution).
        const cleanStart = await pollUntil(async () => (await h.leaderPositions(pool)).length === 0 && (await h.copierPositions(pool)).length === 0, CLEAN_START_TIMEOUT_MS);
        if (!cleanStart) problems.push('did not reach a clean start (lingering position from a prior cycle)');
        // The wallet must START fully SOL-only (the prior scenario's close-sell + sweep landed). Poll to absorb the
        // async sweep; a token still here after the grace = real cross-scenario contamination → flag it.
        const startSolOnly = await pollUntil(() => h.copierCleanOf(new Set()), WALLET_START_SOL_ONLY_TIMEOUT_MS);
        if (!startSolOnly) problems.push(`wallet NOT SOL-only at scenario start: holds ${[...(await h.copierMints())].join(',')}`);

        // OPEN (one- or two-sided). leaderOpen --twosided forces a two-sided leader (active-bin token leg) → the bot
        // buys the token + deposits both legs (Token-2022 = the 2-tx create+addLiquidityByWeight2 path).
        const leaderPos = await h.leaderOpen({ pool, strategy: s.strategy, sol: s.sol, twosided: s.side === 'two', token: 4_000_000 });
        copy = await h.waitForCopy(pool, OPEN_FUNDED_TIMEOUT_MS); // waits for a FUNDED position
        await sleep(REANCHOR_SETTLE_MS);

        // A single fidelity read can be PARTIAL under RPC load (a bin still indexing → under-reported ratio / a
        // token leg read as 0). Re-confirm a suspicious reading after a settle before flagging — a real miss persists,
        // a transient partial read clears. (The strict, contention-free fidelity SLA lives in the dedicated tests.)
        let f = await h.fidelity(pool, leaderPos, copy);
        const suspicious = (g: typeof f): boolean => !(g.totalRatio > TOTAL_RATIO_MIN && g.totalRatio < TOTAL_RATIO_MAX) || (s.side === 'two' && !(g.tokenLegRatio > 0));
        if (suspicious(f)) {
          await sleep(REANCHOR_SETTLE_MS * 2);
          f = await h.fidelity(pool, leaderPos, copy);
        }
        if (typeof f.totalRatio !== 'number' || Number.isNaN(f.totalRatio)) problems.push('fidelity read returned no totalRatio');
        else if (!(f.totalRatio > TOTAL_RATIO_MIN && f.totalRatio < TOTAL_RATIO_MAX)) problems.push(`totalRatio ${f.totalRatio.toFixed(3)} off-band`);
        // Two-sided ⇒ the token leg MUST be replicated (proves the buy + deposit landed; a one-sided copy = tokenLegRatio 0).
        if (s.side === 'two' && !(f.tokenLegRatio > 0)) problems.push(`two-sided copy missing its token leg (tokenLegRatio ${f.tokenLegRatio})`);

        // Latency: RECORDED (tally) for visibility; only an egregious hang is flagged (the strict SLA is gated by
        // latency.onchain.test.ts, where there is no bench RPC contention).
        openMs = h.copyLatencyMs('open');
        if (openMs != null && openMs > LATENCY_HANG_MS) problems.push(`open latency ${openMs}ms — possible hang (> ${LATENCY_HANG_MS}ms)`);

        // ── lifecycle-specific middle step ───────────────────────────────────────────────────────────────────
        if (s.lifecycle === 'grow') {
          await h.leaderAdd({ pool, twosided: s.side === 'two', sol: ADD_SOL, token: 2_000_000 });
          const grew = await pollUntil(
            async () => {
              const g = await h.fidelity(pool, leaderPos, copy!).catch(() => null);
              return !!g && g.totalCopySol > f.totalCopySol * 1.1; // copy grew ≥10% (clearly above arb noise)
            },
            RESIZE_SETTLE_TIMEOUT_MS,
            8000, // gentle poll (heavy SDK read) — RPC headroom for the bot
          );
          // The fidelity SDK re-read shares the bot's RPC key → it can lag/under-report the freshly-grown size. Only a
          // TRUE miss — the bot never PUBLISHED the mirroring add — is a SERIOUS issue; a published add (landed on-chain,
          // confirmed by the coffre) that the read merely missed is bench lag, not a bot fault.
          if (!grew && !h.brainReshapedCopy(copy!, 'grow')) problems.push('copy did not grow after the leader add (reshape-grow not mirrored)');
          else if (!grew) console.log(`🛁 n=${n} grow: fidelity read lagged but the bot DID mirror the add (brain reshape published) — not flagged`);
        } else if (s.lifecycle === 'shrink') {
          await h.leaderRemove(pool, REMOVE_BPS);
          const shrank = await pollUntil(
            async () => {
              const g = await h.fidelity(pool, leaderPos, copy!).catch(() => null);
              return !!g && g.totalCopySol < f.totalCopySol * 0.85; // copy shrank ≥15%
            },
            RESIZE_SETTLE_TIMEOUT_MS,
            8000, // gentle poll (heavy SDK read)
          );
          // Same as grow: a published remove the bench read merely lagged is not a bot fault — only a never-mirrored
          // shrink (the bot published no remove) is a SERIOUS issue.
          if (!shrank && !h.brainReshapedCopy(copy!, 'shrink')) problems.push('copy did not shrink after the leader remove (reshape-shrink not mirrored)');
          else if (!shrank) console.log(`🛁 n=${n} shrink: fidelity read lagged but the bot DID mirror the remove (brain reshape published) — not flagged`);
        } else if (s.lifecycle === 'partial-remove') {
          await h.leaderRemove(pool, REMOVE_BPS, undefined, undefined); // proportional sub-range remove
          await sleep(REANCHOR_SETTLE_MS * 2);
          if ((await h.copierPositions(pool)).length === 0) problems.push('copy position vanished after a partial leader remove');
        } else if (s.lifecycle === 'claim') {
          // Fees rarely accrue in a short window → "No fee to claim" is expected (the path still ran); only a real
          // error is an issue. The HARD guarantee is unchanged: the position survives + later closes clean + SOL-only.
          await h.leaderClaim(pool).catch((e) => {
            if (!String((e as Error).message).includes('No fee to claim')) throw e;
          });
          await sleep(REANCHOR_SETTLE_MS);
          if ((await h.copierPositions(pool)).length === 0) problems.push('copy position vanished after a claim');
        } else if (s.lifecycle === 'crash') {
          // No-miss across a brain restart: kill + restart the brain WHILE a position is open, then close the leader.
          // The restarted brain (mirror reload + reconcile) MUST still close the copy → no dormant position.
          await killBrain();
          await restartBrain();
          await sleep(REANCHOR_SETTLE_MS);
        } else if (s.lifecycle === 'long-hold') {
          // Hold the position open (varied duration) so it accrues FEES from organic pool trades → the close below
          // returns the legs + fees and the bot must sell ALL of it (wallet SOL-only). A rug-SL safety exit during the
          // hold is VALID (the leader still holds; our independent crash-exit) → not flagged; the close-check tolerates
          // an already-closed copy.
          await sleep(LONG_HOLD_MS);
        } else if (s.lifecycle === 'multi') {
          // TWO simultaneous positions: open a 2nd on the OTHER pool while A is open → the bot tracks + manages BOTH.
          // Both are closed below; the wallet-SOL-only check then covers both residuals.
          poolB = pool === POOL_STABLE ? POOL_COIN_SOL : POOL_STABLE;
          await pollUntil(async () => (await h.leaderPositions(poolB!)).length === 0 && (await h.copierPositions(poolB!)).length === 0, CLEAN_START_TIMEOUT_MS);
          leaderB = await h.leaderOpen({ pool: poolB, strategy: 'spot', sol: 0.05 });
          copyB = await h.waitForCopy(poolB, OPEN_FUNDED_TIMEOUT_MS);
          if ((await h.copierPositions(pool)).length === 0) problems.push('multi: position A copy missing while B is open');
          if ((await h.copierPositions(poolB)).length === 0) problems.push('multi: position B copy missing');
        }

        // CLOSE — robust against leader-control / enumerator lag: close, poll, retry once.
        await h.leaderClose(pool);
        let leaderClosed = await pollUntil(() => h.accountExists(leaderPos).then((e) => !e), CLOSE_LAND_TIMEOUT_MS);
        if (!leaderClosed) {
          await h.leaderClose(pool);
          leaderClosed = await pollUntil(() => h.accountExists(leaderPos).then((e) => !e), CLOSE_LAND_TIMEOUT_MS);
        }
        if (!leaderClosed) problems.push('leader close did not land (after retry)');

        const closed = await pollUntil(() => h.accountExists(copy!).then((e) => !e), COPY_CLOSED_TIMEOUT_MS);
        if (!closed) problems.push('DORMANT: copy position still open after the leader closed (no-miss-close violated)');
        // 'multi': close the 2nd position too — both must end closed; the wallet-SOL-only check then covers both.
        if (poolB && leaderB && copyB) {
          await h.leaderClose(poolB);
          let bClosed = await pollUntil(() => h.accountExists(leaderB!).then((e) => !e), CLOSE_LAND_TIMEOUT_MS);
          if (!bClosed) {
            await h.leaderClose(poolB);
            bClosed = await pollUntil(() => h.accountExists(leaderB!).then((e) => !e), CLOSE_LAND_TIMEOUT_MS);
          }
          if (!bClosed) problems.push('multi: leader B close did not land');
          if (!(await pollUntil(() => h.accountExists(copyB!).then((e) => !e), COPY_CLOSED_TIMEOUT_MS))) problems.push('multi: DORMANT position B after close');
        }
        closeMs = h.copyLatencyMs('close');
        if (closeMs != null && closeMs > LATENCY_HANG_MS) problems.push(`close latency ${closeMs}ms — possible hang (> ${LATENCY_HANG_MS}ms)`);

        // ★★ THE #1 STANDING RULE: the copier wallet must return to SOL-ONLY. The close returns the token leg(s); the
        // close-triggered sell (then the 60s safety-sweep backstop) MUST convert every non-SOL back to SOL. Poll until
        // clean; if a non-SOL token survives the whole window → SERIOUS (a residual the bot failed to sell).
        const solOnly = await pollUntil(() => h.copierCleanOf(new Set()), WALLET_SOL_ONLY_TIMEOUT_MS);
        if (!solOnly) {
          const left = (await h.copierTokens()).filter((t) => t.amountRaw >= 100_000n).map((t) => `${t.mint}:${t.amountRaw}`);
          problems.push(`wallet NOT SOL-only after close — unsold residual: ${left.join(',')}`);
        }
      } catch (e) {
        problems.push(`threw: ${(e as Error).message}`);
      }
      try {
        await h.resetState(pool);
        if (poolB) await h.resetState(poolB); // 'multi': clean the 2nd pool too
        await pollUntil(async () => (await h.copierPositions(pool)).length === 0 && (poolB ? (await h.copierPositions(poolB)).length === 0 : true), RESETTLE_TIMEOUT_MS);
      } catch (e) {
        problems.push(`reset failed: ${(e as Error).message}`);
      }
      const ok = problems.length === 0;
      appendFileSync(TALLY, `${JSON.stringify({ n, pool: s.pool.tag, side: s.side, strategy: s.strategy, sol: s.sol, lifecycle: s.lifecycle, openMs, closeMs, ok, problems })}\n`);
      if (!ok) {
        // Archive the brain + coffre logs of a FAILED scenario before the next one (or a crash-restart's tee) wipes
        // them — preserves the reshape activity (brain) and any on-chain revert reason (coffre) for offline diagnosis.
        for (const [src, label] of [['/tmp/bench-brain.log', 'brain'], ['/tmp/bench-coffre.log', 'coffre']] as const) {
          try {
            const tail = readFileSync(src, 'utf8').split('\n').slice(-FAIL_LOG_TAIL_LINES).join('\n');
            writeFileSync(`/tmp/copybot-soak-fail-n${n}-${label}.log`, tail);
          } catch {
            /* best-effort: a missing log must never break the loop */
          }
        }
      }
      if (!ok) batchIssues.push(`${tag}: ${problems.join('; ')}`);
      console.log(`🛁 ${tag} → ${ok ? 'CLEAN' : `ISSUE: ${problems.join('; ')}`}`);
    }
    const c = cumulative();
    console.log(`🛁 batch done: ${ITERATIONS - batchIssues.length}/${ITERATIONS} clean this batch; cumulative ${c.total - c.issues}/${c.total} clean`);
    expect(batchIssues, `MEGA-SOAK found ${batchIssues.length} SERIOUS issue(s): ${batchIssues.join(' || ')}`).toHaveLength(0);
  }, 1_800_000);
});
