/**
 * Copy-bot · on-chain · OBSERVABILITY of the residual SELL + the sub-floor SKIP (closes the `swap.executed` /
 * `sizing.below_min_floor` feed gaps). Both assertions read the SAME `copy_journal` the live bot writes (Postgres
 * :5435), so they prove the brain actually EMITTED the feed row end-to-end — not just that the code path exists.
 *
 *  (a) A two-sided coin/SOL close returns a residual non-SOL token leg → the brain sells it back to SOL; once that
 *      sell lands, `ev:executed{kind:'sell'}` must drive the FEED `swap.executed` row (the previously-missing emit).
 *  (b) A sub-floor leader open (copy size < the 0.02 min floor) must be SKIPPED and logged as the FEED
 *      `sizing.below_min_floor` row ("copy pas fait" transparency). Cheap — no copy is opened.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@/infrastructure/persistence/database';
import { ensureBotStarted } from './bot-controller';
import { POOL_COIN_SOL, POOL_STABLE, connection } from './env';
import { Harness } from './harness';

const DB_URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const db = openDatabase(DB_URL);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the live journal until a feed row with `code` and a non-null correlation_id appears (after `sinceTs`). */
async function waitForFeedRow(code: string, sinceTs: number, timeoutMs: number, stepMs = 2500): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await db.execute(
      sql`SELECT ts, code, audience, correlation_id, signature, pool, detail
          FROM copy_journal
          WHERE code = ${code} AND audience = 'feed' AND ts >= ${sinceTs}
          ORDER BY ts DESC LIMIT 1`,
    )) as unknown as Array<Record<string, unknown>>;
    if (rows.length > 0) return rows[0]!;
    await sleep(stepMs);
  }
  return null;
}

describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · observability — residual swap.executed + sub-floor sizing.below_min_floor reach the FEED', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(async () => {
    await h.resetState(POOL_COIN_SOL);
    await h.resetState(POOL_STABLE);
  });

  it('(a) closing a two-sided coin/SOL copy → the residual token→SOL sell lands → FEED `swap.executed` row (non-null correlation_id)', async () => {
    // WHY: before the fix the SELL published + landed but `swap.executed` was emitted NOWHERE — the user feed never
    // showed "Swapped X → SOL". This row appearing proves the new `ev:executed{kind:'sell'}` → onSellConfirmed path.
    const sinceTs = Date.now();
    await h.leaderOpen({ pool: POOL_COIN_SOL, strategy: 'spot', sol: 0.06 }); // two-sided → bot copies a token leg
    const copy = await h.waitForCopy(POOL_COIN_SOL);
    await h.leaderClose(POOL_COIN_SOL);
    await h.waitForCopyClosed(copy); // the close landed → the brain now sells the residual token back to SOL

    const row = await waitForFeedRow('swap.executed', sinceTs, 90_000); // sell build+land+confirm takes seconds
    expect(row, 'no `swap.executed` feed row after a close-triggered residual sell — the emit gap is NOT closed').not.toBeNull();
    expect(row?.audience, 'swap.executed must be a feed row (user-visible)').toBe('feed');
    expect(row?.correlation_id, 'swap.executed must carry a non-null correlation_id (= the sell commandId)').toBeTruthy();
  }, 120_000);

  it('(b) a sub-floor leader open (copy < 0.02 SOL floor) → NO copy, FEED `sizing.below_min_floor` row ("copy pas fait")', async () => {
    // WHY: the user wants the transparency "copy not made" reason. sol=0.03 × 50% trade ratio = 0.015 < the 0.02
    // configured min floor (bot-controller brainEnv) → the brain SKIPS the open and logs the reason to the feed.
    const sinceTs = Date.now();
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.03 }); // copy 0.015 < 0.02 → skip (no copy opened)

    const row = await waitForFeedRow('sizing.below_min_floor', sinceTs, 60_000);
    expect(row, 'no `sizing.below_min_floor` feed row — the sub-floor skip was not logged for the user').not.toBeNull();
    expect(row?.audience, 'sizing.below_min_floor must be a feed row (user-visible transparency)').toBe('feed');

    // Belt-and-suspenders: confirm the bot did NOT open a copy for the sub-floor leader open.
    await sleep(8000);
    expect((await h.copierPositions(POOL_STABLE)).length, 'a copy was opened for a SUB-FLOOR leader open — sizing skip did not gate the open').toBe(0);
  }, 90_000);
});
