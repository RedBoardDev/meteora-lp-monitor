import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';

// REAL latency SLA. Our edge is a FAITHFUL + FAST mirror: the copy must land within ≤3s of the bot seeing the
// leader's action (PLAN.md §1.4, the ≤3s end-to-end budget). We measure the bot's CONTROLLABLE reaction — from the
// brain's "event routed" (WS delivered the leader event) to the coffre's "signed + landed" (our copy on the wire) —
// from the real bot logs. If a path blows the budget this FAILS (a real SLA violation to optimise, not a flake).
const SLA_MS = 3000;

describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · latency — copy lands within the ≤3s SLA', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  it('OPEN copy latency ≤ 3s (event seen → copy landed)', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    await h.waitForCopy(POOL_STABLE);
    const ms = h.copyLatencyMs('open');
    console.log(`⏱️  OPEN latency: ${ms}ms (budget ${SLA_MS}ms)`);
    expect(ms, 'no open latency measured from the bot logs').not.toBeNull();
    expect(ms as number).toBeLessThanOrEqual(SLA_MS);
  }, 120_000);

  it('CLOSE copy latency ≤ 3s (critical: a slow close risks a missed exit)', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy = await h.waitForCopy(POOL_STABLE);
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy);
    const ms = h.copyLatencyMs('close');
    console.log(`⏱️  CLOSE latency: ${ms}ms (budget ${SLA_MS}ms)`);
    expect(ms, 'no close latency measured from the bot logs').not.toBeNull();
    expect(ms as number).toBeLessThanOrEqual(SLA_MS);
  }, 120_000);
});
