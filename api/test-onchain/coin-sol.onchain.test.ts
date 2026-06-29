import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_COIN_SOL, connection } from './env';
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

// Coverage BEYOND the stable SOL/USDC pool (user-requested): a volatile COIN(pump.fun)/SOL pool — wide binStep
// (100 = 1%), low liquidity, fast-moving active bin. SOL-paired, so the bot copies it. We assert the SOL-leg
// fidelity (arb-tolerant, since a 1%-binStep coin moves fast) + the hard no-dormant-POSITION guarantee on close.
// The coin residual sweep is BEST-EFFORT only (an illiquid pump coin may have no Jupiter route → the bot correctly
// leaves sub-economic dust), so we do NOT assert a token-clean wallet here — only that the position is gone.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · volatile COIN(pump)/SOL pool — open/close beyond stable SOL/USDC', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_COIN_SOL));

  it('spot open on the volatile coin pool → TWO-SIDED copy (SOL leg ~half + Token-2022 token leg replicated)', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_COIN_SOL, strategy: 'spot', sol: 0.06 });
    const copy = await h.waitForCopy(POOL_COIN_SOL); // waits for a FUNDED position (the Token-2022 open lands in 2 tx: create then deposit)
    const f = await h.fidelity(POOL_COIN_SOL, leaderPos, copy);
    await h.logShapes(POOL_COIN_SOL, leaderPos, copy);
    // A 1%-binStep coin's active bin moves fast → the SOL leg is noisier than on the stable pool; use the
    // arb-tolerant band (same spirit as a reshape's maxSolLegDiff bound). COPY_RATIO = 0.5.
    expect(f.solLegRatio, `SOL leg not ~half on the coin pool (got ${f.solLegRatio})`).toBeGreaterThan(0.4);
    expect(f.solLegRatio, `SOL leg over half on the coin pool (got ${f.solLegRatio})`).toBeLessThan(0.62);
    // The DIRECT proof the Token-2022 token leg was bought + deposited via the v2 (create + addLiquidityByWeight2)
    // path: a one-sided copy would hold NO token → tokenLegRatio === 0. > 0 ⇒ the two-sided Token-2022 copy landed.
    expect(f.tokenLegRatio, `Token-2022 token leg not replicated (two-sided open failed, got ${f.tokenLegRatio})`).toBeGreaterThan(0);
    expect(f.sameBinCount, 'bin count mismatch — the re-anchored shape was not reproduced').toBe(true);
  }, 120_000);

  it('close on the coin pool → the copy POSITION is closed (no dormant position; coin-dust sweep is best-effort)', async () => {
    const leaderPos = await h.leaderOpen({ pool: POOL_COIN_SOL, strategy: 'spot', sol: 0.06 });
    const copy = await h.waitForCopy(POOL_COIN_SOL);
    // Robust against leader-control / enumerator lag on this illiquid pool: close, poll the leader account, retry once.
    await h.leaderClose(POOL_COIN_SOL);
    let leaderClosed = await pollUntil(() => h.accountExists(leaderPos).then((e) => !e), 20_000);
    if (!leaderClosed) {
      await h.leaderClose(POOL_COIN_SOL);
      leaderClosed = await pollUntil(() => h.accountExists(leaderPos).then((e) => !e), 20_000);
    }
    expect(leaderClosed, 'leader close did not land after retry — assertion would be vacuous').toBe(true);
    await h.waitForCopyClosed(copy); // the hard no-miss guarantee: the copy position is gone (throws if dormant)
    expect(await h.accountExists(copy), 'copy position still open after the leader closed — DORMANT position').toBe(false);
  }, 120_000);
});
