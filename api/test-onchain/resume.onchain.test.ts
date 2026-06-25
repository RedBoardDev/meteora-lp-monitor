import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted, killBrain, restartBrain } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// REAL chaos test for the #1 robustness guarantee (copybot-restart-semantics): the bot must NEVER leave a dormant
// position after a crash/disconnect. We kill the brain mid-position, close the LEADER while the brain is down (no
// WS to catch it), restart the brain → its boot replay + loadOpen + reconcile must CLOSE the orphaned copy.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · robustness — resume after brain restart', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(async () => {
    await ensureBotStarted(); // make sure the brain is back for the next test (in case a test left it killed)
    await h.resetState(POOL_STABLE);
  });

  it('brain dies mid-position + leader closes during downtime → on restart the bot closes the orphaned copy', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy = await h.waitForCopy(POOL_STABLE);
    expect(await h.accountExists(copy)).toBe(true);

    await killBrain(); // 💥 the brain crashes / loses connection while we hold a copied position
    await h.leaderClose(POOL_STABLE); // the leader closes during the downtime — no live brain to detect it
    await restartBrain(); // 🔁 brain reboots → replay (cursor only) + reload persisted mirrors + boot reconcile

    // The boot reconcile must detect the leader is gone and close our orphaned copy — no dormant position.
    await h.waitForCopyClosed(copy, 60_000);
    expect(await h.accountExists(copy)).toBe(false);
  }, 180_000);

  it('brain restarts while the leader is STILL open → keeps the copy (no false-close, no duplicate)', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy = await h.waitForCopy(POOL_STABLE);

    await restartBrain(); // 🔁 brain restarts while the leader position is healthy/open
    await sleep(40_000); // let the boot reconcile + the next RECON_MS tick run (open-grace must protect the copy)

    expect(await h.accountExists(copy), 'healthy copy was FALSE-CLOSED by the restart reconcile').toBe(true);
    expect((await h.copierPositions(POOL_STABLE)).length, 'restart re-copied a DUPLICATE position').toBe(1);
  }, 180_000);
});
