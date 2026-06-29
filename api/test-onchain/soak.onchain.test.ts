import { appendFileSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_COIN_SOL, POOL_STABLE, POOL_VOLATILE, connection } from './env';
import { Harness } from './harness';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pollUntil = async (pred: () => Promise<boolean>, timeoutMs: number, stepMs = 2500): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
};

// ★ VOLUME SOAK — the operational bar: ZERO issues across 500+ DIFFERENT positions. The slightest anomaly (a failed
// open/close, a dormant position, an off-band fidelity, a latency-SLA breach, a NEW unswept token, a thrown error)
// is recorded as a SERIOUS issue. The loop is RESILIENT (one bad position records + continues, so a batch surfaces
// EVERY issue, not just the first) and ACCUMULATES across batches via a JSONL tally → run repeatedly until the
// cumulative clean count ≥ 500. Parameterised by SOAK_ITERATIONS (per-batch, sized to the ~10-min run + wallet fees).
const ITERATIONS = Number(process.env.SOAK_ITERATIONS ?? '10');
const TALLY = '/tmp/copybot-soak.jsonl'; // one line per position, accumulated across batches
const SLA_MS = 3000;
const STRATEGIES = ['spot', 'bidask', 'curve'] as const;
const SIZES = [0.05, 0.06, 0.08, 0.07] as const; // varied; all ≥ 0.05 → copy ≥ 0.025 > the 0.02 min (0.04 lands below the floor → a correct skip, not an issue)
// Rotate ALL pools (user-requested coverage beyond SOL/USDC): stable SOL/USDC, a Token-2022 pump, a COIN/SOL pump.
const POOLS = [POOL_STABLE, POOL_VOLATILE, POOL_COIN_SOL] as const;
// Only the deep, liquid pool guarantees a residual is SELLABLE → assert a clean sweep there. On an ILLIQUID pump
// pool the bot CORRECTLY leaves an unsellable sub-economic residual (no Jupiter route) → the sweep is best-effort;
// the HARD guarantee everywhere is no-dormant-POSITION + faithful economic fidelity.
const SWEEP_STRICT = new Set<string>([POOL_STABLE]);
const MAX_ECON_DIFF_PCT = 12; // per-bin shape tolerance: the ~0.8s copy-entry delay shifts the active bin → edge-bin econ diff (value-total stays faithful); matches the reshape arb-tolerance

const cumulative = (): { total: number; issues: number } => {
  try {
    const lines = readFileSync(TALLY, 'utf8').trim().split('\n').filter(Boolean);
    return { total: lines.length, issues: lines.filter((l) => !(JSON.parse(l) as { ok: boolean }).ok).length };
  } catch {
    return { total: 0, issues: 0 };
  }
};

describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · VOLUME SOAK — zero issues across 500+ positions', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterAll(() => {
    const c = cumulative();
    console.log(`\n🛁 SOAK cumulative: ${c.total - c.issues}/${c.total} clean (${c.issues} issue(s)). Target: 500+ clean, 0 issues.`);
  });

  it(`soak batch of ${ITERATIONS} open→close cycles (varied pool/strategy/size) — ZERO issues required`, async () => {
    const batchIssues: string[] = [];
    const start0 = cumulative().total;
    for (let i = 0; i < ITERATIONS; i++) {
      const n = start0 + i; // global position index across batches
      const pool = POOLS[n % POOLS.length]!; // rotate ALL pools (not just SOL/USDC)
      const poolTag = pool === POOL_STABLE ? 'stable' : pool === POOL_VOLATILE ? 'vol2022' : 'coinSOL';
      const strategy = STRATEGIES[n % STRATEGIES.length]!;
      const sol = SIZES[n % SIZES.length]!;
      const tag = `#${n} ${poolTag} ${strategy} ${sol}SOL`;
      const problems: string[] = [];
      try {
        // CLEAN START: a flaky prior cycle (enumerator lag) could leave a lingering position → settle both sides to
        // 0 first so this cycle is INDEPENDENT (no cross-cycle pollution masquerading as a bot issue).
        const cleanStart = await pollUntil(async () => (await h.leaderPositions(pool)).length === 0 && (await h.copierPositions(pool)).length === 0, 30_000);
        if (!cleanStart) problems.push('did not reach a clean start (lingering position from a prior cycle)');

        const before = await h.copierMints();
        const leaderPos = await h.leaderOpen({ pool, strategy, sol });
        const copy = await h.waitForCopy(pool, 45_000);
        await sleep(5_000); // settle: let the copy's bins index + any entry-instant arb settle before reading the shape (an instant read under load catches a partial/early distribution, not the bot's true fidelity)

        const f = await h.fidelity(pool, leaderPos, copy);
        // Gate on the ECONOMIC ratio (both legs valued) + the per-bin econ shape diff — these are ARB/latency-
        // invariant (value is conserved when the active bin moves), unlike the raw solLegRatio whose SOL/token SPLIT
        // drifts with the inherent ~0.8s copy-entry delay on a volatile pool. This measures the real job: deploy
        // ratio × the leader's VALUE, faithfully shaped.
        if (typeof f.totalRatio !== 'number' || Number.isNaN(f.totalRatio)) problems.push('fidelity read returned no totalRatio');
        else if (!(f.totalRatio > 0.43 && f.totalRatio < 0.6)) problems.push(`totalRatio ${f.totalRatio.toFixed(3)} off-band (COPY_RATIO 0.5)`);
        if (typeof f.maxEconDiffPct === 'number' && f.maxEconDiffPct >= MAX_ECON_DIFF_PCT) problems.push(`maxEconDiff ${f.maxEconDiffPct.toFixed(1)}% (shape)`);

        const openMs = h.copyLatencyMs('open');
        if (openMs != null && openMs > SLA_MS) problems.push(`open latency ${openMs}ms > ${SLA_MS}`);

        // CLOSE — robust against leader-control / enumerator lag: poll the leader account to confirm it settled, retry once.
        await h.leaderClose(pool);
        let leaderClosed = await pollUntil(() => h.accountExists(leaderPos).then((e) => !e), 20_000);
        if (!leaderClosed) {
          await h.leaderClose(pool);
          leaderClosed = await pollUntil(() => h.accountExists(leaderPos).then((e) => !e), 20_000);
        }
        if (!leaderClosed) problems.push('leader close did not land (after retry)');

        await h.waitForCopyClosed(copy, 60_000); // throws if the copy is dormant → caught below (the HARD no-miss guarantee, ALL pools)
        const closeMs = h.copyLatencyMs('close');
        if (closeMs != null && closeMs > SLA_MS) problems.push(`close latency ${closeMs}ms > ${SLA_MS}`);

        // sweep: STRICT only on a liquid pool (residual is sellable). On an ILLIQUID pump pool the bot correctly
        // leaves an unsellable sub-economic residual (no Jupiter route) → best-effort: log, don't flag as an issue.
        let swept = false;
        for (let t = 0; t < 75_000 && !swept; t += 5000) {
          if (await h.copierCleanOf(before)) swept = true;
          else await sleep(5000);
        }
        if (!swept && SWEEP_STRICT.has(pool)) problems.push('NEW non-SOL token not swept within 75s');
        else if (!swept) console.log(`🛁 ${tag} → residual left on illiquid pool (best-effort sweep, expected)`);
      } catch (e) {
        problems.push(`threw: ${(e as Error).message}`);
      }
      try {
        await h.resetState(pool);
        await pollUntil(async () => (await h.copierPositions(pool)).length === 0, 20_000); // settle before the next cycle
      } catch (e) {
        problems.push(`reset failed: ${(e as Error).message}`);
      }
      const ok = problems.length === 0;
      appendFileSync(TALLY, `${JSON.stringify({ n, strategy, sol, ok, problems })}\n`);
      if (!ok) batchIssues.push(`${tag}: ${problems.join('; ')}`);
      console.log(`🛁 ${tag} → ${ok ? 'CLEAN' : `ISSUE: ${problems.join('; ')}`}`);
    }
    const c = cumulative();
    console.log(`🛁 batch done: ${ITERATIONS - batchIssues.length}/${ITERATIONS} clean this batch; cumulative ${c.total - c.issues}/${c.total} clean`);
    expect(batchIssues, `SOAK found ${batchIssues.length} SERIOUS issue(s): ${batchIssues.join(' || ')}`).toHaveLength(0);
  }, 600_000);
});
