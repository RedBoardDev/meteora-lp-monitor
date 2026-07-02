import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveCommandId } from '@/copybot/command-id';
import { openDatabase } from '@/infrastructure/persistence/database';
import { executions } from '@/infrastructure/persistence/schema';
import { ensureBotStarted, killBrain, restartBrain } from './bot-controller';
import { LEADER_TEST, POOL_COIN_SOL, POOL_STABLE, connection } from './env';
import { Harness } from './harness';
import { pollUntil } from './util';

// ★ REGRESSION for the stuck-phantom bug (fix: forceReclaim on failsafe/orphan closes). The 500-position mega-soak
// NEVER hit it: each scenario opens a FRESH position → a UNIQUE failsafe-close commandId, closed on the FIRST attempt
// while the bot runs → never a re-attempt of the same commandId past a stale terminal state. This test injects EXACTLY
// that missing condition — a failsafe close pre-recorded as 'landed' (a prior close that was logged but never removed
// the position) — on MULTIPLE positions across MULTIPLE coins (classic SOL/USDC + a Token-2022 memecoin), then orphans
// every copy (leader closes while the bot is DOWN) and asserts the reconcile FORCE-CLOSES them all → copier SOL-only.
// Without the fix, each reconcile re-close is rejected as a 'duplicate' forever and the phantoms stay open.
const COINS = [
  { pool: POOL_STABLE, twosided: false, label: 'SOL/USDC (classic SPL)' },
  { pool: POOL_COIN_SOL, twosided: true, label: '9cRCn (Token-2022)' },
];
const DB_URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const OPEN_TIMEOUT_MS = 90_000;
const PHANTOM_CLOSE_TIMEOUT_MS = 150_000; // restart → first reconcile tick (~30s) → failsafe close lands
const WALLET_SOL_ONLY_TIMEOUT_MS = 120_000;

describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · fail-safe — phantom positions across MULTIPLE coins are force-closed', () => {
  let h: Harness;
  const db = openDatabase(DB_URL);
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterAll(async () => {
    for (const c of COINS) await h.leaderCloseAll(c.pool).catch(() => undefined); // best-effort cleanup
  });

  it('multiple orphan copies, each with a STALE landed close, all auto-close → copier SOL-only', async () => {
    const ignore = await h.copierMints(); // pre-existing dust to ignore in the final clean check

    // 1) Open a copy on EACH coin (the bot copies the leader).
    const opened: Array<{ pool: string; leaderPos: string; copy: string; label: string }> = [];
    for (const c of COINS) {
      // sol 0.06 → copy = 0.5× = 0.03, comfortably above COPYBOT_MIN_POSITION_SOL (0.02); a smaller open is correctly
      // SKIPPED by the bot's min-floor filter (NOT copied) — that is by design, not a fail-safe concern.
      const leaderPos = await h.leaderOpen({ pool: c.pool, twosided: c.twosided, sol: 0.06, token: 2_000_000, strategy: 'spot' });
      const copy = await h.waitForCopy(c.pool, OPEN_TIMEOUT_MS);
      opened.push({ pool: c.pool, leaderPos, copy, label: c.label });
      console.error(`[failsafe] opened ${c.label}: leader=${leaderPos} copy=${copy}`);
    }

    // 2) INJECT the bug condition: pre-record each copy's failsafe close commandId as a terminal 'landed' (a prior
    //    close that was logged but never actually removed the position). This is the state the soak never produced.
    for (const o of opened) {
      const eventKey = `${LEADER_TEST.toBase58()}:${o.pool}:failsafe:${o.leaderPos}`;
      const commandId = deriveCommandId(eventKey);
      await db
        .insert(executions)
        .values({ commandId, eventKey, state: 'landed', deadlineSlot: 0, createdAt: Date.now(), updatedAt: Date.now() })
        .onConflictDoUpdate({ target: executions.commandId, set: { state: 'landed', updatedAt: Date.now() } });
      console.error(`[failsafe] seeded stale 'landed' close for ${o.label} (cmd ${commandId.slice(0, 10)}…)`);
    }

    // 3) Orphan every copy: kill the brain, close every leader (the bot is DOWN → cannot copy the close), restart.
    await killBrain();
    for (const o of opened) await h.leaderClose(o.pool);
    await restartBrain();

    // 4) ★ The reconcile must FORCE-CLOSE every phantom despite the stale 'landed' row (forceReclaim). No dormant.
    for (const o of opened) {
      const gone = await pollUntil(() => h.accountExists(o.copy).then((e) => !e), PHANTOM_CLOSE_TIMEOUT_MS, 4000);
      expect(gone, `phantom NOT closed for ${o.label} (copy ${o.copy}) — stuck behind the stale 'landed' row`).toBe(true);
      console.error(`[failsafe] ${o.label}: phantom closed ✓`);
    }

    // 5) Copier returns to SOL-only (the withdrawn non-SOL legs are swept).
    const clean = await pollUntil(() => h.copierCleanOf(ignore), WALLET_SOL_ONLY_TIMEOUT_MS, 5000);
    const residual = (await h.copierTokens()).filter((t) => !ignore.has(t.mint) && t.amountRaw >= 100_000n);
    expect(clean, `copier not SOL-only after the force-closes — residual: ${residual.map((t) => `${t.mint.slice(0, 6)}=${t.amountRaw}`).join(', ')}`).toBe(true);
  }, 600_000);
});
