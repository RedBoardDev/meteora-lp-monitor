import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// REAL robustness tests — verify the bot's no-miss guarantees, not just the happy path.
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · robustness — no dormant non-SOL token', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  // A two-sided close returns BOTH legs → the copier holds a real (above-floor) token balance. The bot MUST
  // convert it back to SOL (close-sell + periodic sweep). This fails if the bot leaves a dormant token, OR if the
  // sweep takes longer than its cadence (≤ ~SWEEP_MS=60s + a margin). It also measures HOW LONG the sweep takes.
  it('after a two-sided close, the copier wallet is swept token→SOL (no dormant token, within ~75s)', async () => {
    const before = await h.copierMints(); // pre-existing session dust (illiquid Token-2022) to ignore
    await h.leaderOpen({ pool: POOL_STABLE, twosided: true, sol: 0.1, token: 4_000_000 });
    const copy = await h.waitForCopy(POOL_STABLE);
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy); // the close returns SOL + the token leg into the copier wallet

    const start = Date.now();
    let cleanMs = -1;
    while (Date.now() - start < 80_000) {
      if (await h.copierCleanOf(before)) {
        cleanMs = Date.now() - start;
        break;
      }
      await sleep(5000);
    }
    expect(cleanMs, 'copier still holds a non-SOL token after 80s — DORMANT TOKEN').toBeGreaterThanOrEqual(0);
    expect(cleanMs, 'sweep slower than its cadence').toBeLessThan(75_000);
    console.log(`💱 copier swept to SOL ${(cleanMs / 1000).toFixed(1)}s after the close`);
  }, 180_000);
});
