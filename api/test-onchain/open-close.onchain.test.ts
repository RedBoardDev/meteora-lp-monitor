import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_STABLE, connection } from './env';
import { Harness } from './harness';

// REAL on-chain tests: drive a leader open of each shape on the stable SOL/USDC pool, wait for the bot to copy,
// and assert the copy reproduces the leader's SOL-leg distribution (faithful) at half size (COPY_RATIO). These
// FAIL if the open/re-anchor/sizing regresses (e.g. the 0.806× sizing bug would trip the ratio assertion).
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · open/close — simple shapes (stable SOL/USDC)', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_STABLE));

  const assertFaithfulHalf = async (leaderPos: string): Promise<void> => {
    const copyPos = await h.waitForCopy(POOL_STABLE);
    const f = await h.fidelity(POOL_STABLE, leaderPos, copyPos);
    // The bot copies the SOL side (one-sided). Assert on the SOL LEG — distribution reproduced + half size. (Not
    // sameBinCount / econ ratio: a "spot" SOL/USDC open picks up a tiny active-bin token leg from arb that the
    // one-sided copy intentionally doesn't replicate → that's correct, not a regression.)
    // SOL-leg distribution reproduced. Threshold tolerates active-bin ARB: the leader (opened first) has its
    // active bin more converted SOL→token than the fresher copy, and on a SKEWED shape (bidask/curve/custom) that
    // bin's high weight amplifies the gap — worst-case ~11% on a high-arb run (measured). A real re-anchor
    // regression mis-places SOL across bins → 15-40% diff → still caught. <12 (aligned with the reshape tests)
    // keeps this 100% reliable without masking a regression. (One-sided copy: active-bin token not replicated.)
    expect(f.maxSolLegDiffPct).toBeLessThan(12);
    expect(f.solLegRatio).toBeGreaterThan(0.43); // ≈ COPY_RATIO 0.5 (arb on the older leader's SOL leg widens it a bit) — catches a sizing regression
    expect(f.solLegRatio).toBeLessThan(0.6);
  };

  it('spot open → copied faithfully at half size', async () => {
    await assertFaithfulHalf(await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 }));
  });

  it('bidask open → ascending ramp reproduced', async () => {
    await assertFaithfulHalf(await h.leaderOpen({ pool: POOL_STABLE, strategy: 'bidask', sol: 0.1 }));
  });

  it('curve open → descending shape reproduced', async () => {
    await assertFaithfulHalf(await h.leaderOpen({ pool: POOL_STABLE, strategy: 'curve', sol: 0.1 }));
  });

  it('custom spiked distribution → per-bin spikes reproduced', async () => {
    await assertFaithfulHalf(await h.leaderOpen({ pool: POOL_STABLE, dist: '1,1,8,1,1,1,5,1', sol: 0.1 }));
  });

  it('close — leader closes → the bot closes its copy (no dormant position)', async () => {
    await h.leaderOpen({ pool: POOL_STABLE, strategy: 'spot', sol: 0.1 });
    const copy = await h.waitForCopy(POOL_STABLE);
    await h.leaderClose(POOL_STABLE);
    await h.waitForCopyClosed(copy); // throws (test fails) if the bot leaves a dormant copy
    expect(await h.accountExists(copy)).toBe(false); // explicit no-dormant-position guarantee
  });
});
