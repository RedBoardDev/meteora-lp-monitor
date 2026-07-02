import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted, killCoffre, restartCoffre } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';
import { sleep } from './util';

// REAL chaos (FEATURE 6.6): the VAULT (coffre) crashes with an in-flight cmd:sign — it had READ the message
// (delivered, pending) but died before ACKing. Without recovery, XREADGROUP '>' never re-delivers it → the open is
// STRANDED → a missed copy (the cardinal sin). The fix: on boot the vault re-processes its PENDING (XREADGROUP '0'),
// exactly-once via the executions table. We make the pending deterministically (no flaky race) by reading the
// published cmd:sign into the vault consumer's PEL ourselves, then restarting the vault to recover it.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · fail-safe 6.6 — vault crash recovers the pending cmd:sign (exactly once)', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(async () => {
    await ensureBotStarted(); // make sure the vault is back for the next test / reset
    await h.resetState(POOL_STABLE);
  });

  it('vault dies with a read-but-unACKed open → on restart it recovers the PENDING + lands the copy EXACTLY once', async () => {
    await killCoffre(); // 💥 vault down; the brain stays up and still publishes
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });

    // The brain publishes cmd:sign(open). Deliver it into the vault consumer's PEL (read, NOT acked) → exactly the
    // "vault read it then crashed" state. Poll until the publish appears in the stream.
    let pending = 0;
    for (let i = 0; i < 12 && pending === 0; i++) {
      await sleep(2500);
      pending += await h.deliverCmdSignToVaultPending();
    }
    expect(pending, 'the brain never published the open cmd:sign while the vault was down').toBeGreaterThanOrEqual(1);

    // Restart the vault → its boot PENDING-recovery must re-process the stranded cmd:sign and land the copy.
    await restartCoffre();
    const copy = await h.waitForCopy(POOL_STABLE, 60_000);
    expect(await h.accountExists(copy), 'the stranded cmd:sign was NOT recovered — a missed copy').toBe(true);
    // EXACTLY once: the recovery did not double-land (the executions table dedups; the open keypair is deterministic).
    expect((await h.copierPositions(POOL_STABLE)).length, 'recovery double-landed the copy').toBe(1);
  }, 180_000);
});
