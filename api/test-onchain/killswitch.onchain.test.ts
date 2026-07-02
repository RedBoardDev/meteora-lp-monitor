import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted, restartBrain, restartBrainWithEnv } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';
import { sleep } from './util';

const NO_COPY_WINDOW_MS = 30_000; // far past the ~2s copy latency — if no copy by now, the entry was blocked

// REAL kill-switch + caps safety (P2.6 / P5.3: "plafonds + kill-switch PROUVÉS capables d'arrêter les copies").
// The kill-switch must HALT new copies — AND, critically, must NOT trap us: exits/reconciliation keep running so
// an existing copy can always be closed. Proven on-chain by toggling COPYBOT_KILL_SWITCH on the running brain.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · safety envelope — kill-switch + caps halt NEW copies (exits always run)', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  // Always restore the DEFAULT brain (kill-switch OFF) for the next test, then clean up.
  afterEach(async () => {
    await restartBrain();
    await h.resetState(POOL_STABLE);
  });

  it('kill-switch ON → leader opens → the bot does NOT copy (entry blocked, seen + refused)', async () => {
    await restartBrainWithEnv({ COPYBOT_KILL_SWITCH: 'true' });
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    await sleep(NO_COPY_WINDOW_MS);

    // HARD proof: no copied position exists (the bot would have copied within ~2s if not blocked).
    expect((await h.copierPositions(POOL_STABLE)).length, 'kill-switch did NOT stop the copy — a position was opened').toBe(0);
    // Corroboration: the bot SAW the open and REFUSED it (a kill-switch block), rather than simply missing it.
    expect(h.brainLogIncludes('kill_switch_global'), 'no kill-switch block logged — the open may have been missed, not blocked').toBe(true);
  }, 120_000);

  it('kill-switch does NOT block EXITS — an existing copy still closes (no trap)', async () => {
    // Open a copy with the kill-switch OFF (normal brain).
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy = await h.waitForCopy(POOL_STABLE);
    expect(await h.accountExists(copy)).toBe(true);

    // Flip the kill-switch ON, then close the leader → the EXIT must still fire (exits are not gated by caps).
    await restartBrainWithEnv({ COPYBOT_KILL_SWITCH: 'true' });
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy); // throws if the kill-switch wrongly trapped us in the position
    expect(await h.accountExists(copy), 'kill-switch trapped us — the copy could not be closed').toBe(false);
  }, 180_000);

  it('maxOpenPositions cap → an open BEYOND the cap is NOT copied', async () => {
    // Small sizes (0.05 → copy 0.025 ≥ the 0.02 min): the leader holds TWO concurrent positions here, which must
    // both fit in the leader-test wallet's ~0.3 SOL (deposit + ~0.057 rent each).
    await restartBrainWithEnv({ COPYBOT_MAX_OPEN_POSITIONS: '1' });
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.05 });
    const copy1 = await h.waitForCopy(POOL_STABLE); // within the cap → copied
    expect(await h.accountExists(copy1)).toBe(true);

    // A SECOND leader position → over the cap of 1 → the bot must REFUSE to copy it.
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.05 });
    await sleep(NO_COPY_WINDOW_MS);
    expect((await h.copierPositions(POOL_STABLE)).length, 'maxOpenPositions cap did not stop the over-cap copy').toBe(1);
    expect(h.brainLogIncludes('max_open_positions'), 'no cap block logged for the over-cap open').toBe(true);
  }, 180_000);
});
