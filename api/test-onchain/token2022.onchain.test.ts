import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBotStarted } from './bot-controller';
import { POOL_VOLATILE, connection } from './env';
import { Harness } from './harness';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const STRANDED_TOKEN_RAW = 100_000n; // a copier balance ≥ this in a NEW mint = a stranded buy (vs pre-existing dust)

// REAL Token-2022 + SAFE no-partial coverage. POOL_VOLATILE is SOL / an illiquid Token-2022 "pump" token. A leader
// open there always carries an active-bin TOKEN leg → the bot classifies it TWO-SIDED. That token has no Jupiter
// route (the quote returns 400), so the copy CANNOT acquire the token leg. The SAFE guarantee (user mandate): the
// bot replicates BOTH legs or opens NOTHING — it must NEVER open a half (one-sided) position that doesn't match a
// two-sided leader. So here it must SKIP the open cleanly: no copied position, no partial, no stranded bought
// token, no dormant state. (A faithful POSITIVE two-sided Token-2022 copy would need a LIQUID Token-2022 pool,
// which we don't have; the classic-SPL two-sided path is covered by the two-sided / two-sided-shapes groups.)
describe.runIf(process.env.ONCHAIN_READY === 'true')('on-chain · Token-2022 / unbuyable token — SAFE skip (never a partial position)', () => {
  let h: Harness;
  beforeAll(async () => {
    await ensureBotStarted();
    h = new Harness(connection());
  });
  afterEach(() => h.resetState(POOL_VOLATILE));

  it('two-sided leader whose token has NO Jupiter route → bot SKIPS the open (no copy, no partial, no stranded token)', async () => {
    const mintsBefore = new Set((await h.copierTokens()).map((t) => t.mint)); // pre-existing balances (e.g. USDC dust) to ignore
    await h.leaderOpen({ pool: POOL_VOLATILE, strategy: 'spot', sol: 0.08 });
    await sleep(35_000); // the skip is immediate (quote 400); ample time for any (wrong) partial copy to land

    // SAFE #1 — NO copied position on the volatile pool. A regression that opened a HALF (one-sided) copy of the
    // two-sided leader, or stalled with a partial, would leave ≥1 position here → FAILS.
    expect((await h.copierPositions(POOL_VOLATILE)).length, 'bot opened a PARTIAL position for an unbuyable two-sided leader').toBe(0);

    // SAFE #2 — NO stranded token: the skip happens BEFORE any buy, so the copier acquired no NEW token mint. (We
    // diff against the pre-existing mints so the recurring USDC dust is ignored.)
    const acquired = (await h.copierTokens()).filter((t) => !mintsBefore.has(t.mint) && t.amountRaw >= STRANDED_TOKEN_RAW);
    expect(acquired, 'bot acquired a token for an open it skipped — a stranded buy from a failed two-sided open').toEqual([]);
  }, 180_000);
});
