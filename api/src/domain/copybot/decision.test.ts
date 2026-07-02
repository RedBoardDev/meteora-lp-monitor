import { describe, expect, it } from 'vitest';
import { type EntryConfig, decideEntry } from './decision';
import type { DetectedEvent } from './events';
import { FILTERS_ALL_OFF, type FilterContext } from './filters';

const cfg = (over: Partial<EntryConfig> = {}): EntryConfig => ({
  tradeRatioPct: 50,
  maxTradeSizeSol: 1.0,
  minPositionSizeSol: 0.05,
  solReserveSol: 0.05,
  onInsufficient: 'skip',
  skipNonSolPaired: true,
  ...over,
});
const flush = { availableBalanceSol: 1000 };

function openEvent(over: Partial<DetectedEvent> = {}): DetectedEvent {
  return {
    signature: 'sig',
    blockTime: 1000,
    instruction: 'AddLiquidityByStrategy2',
    depositSol: 2,
    withdrawSol: 0,
    claimSol: 0,
    closed: false,
    pool: 'POOL',
    position: 'POS',
    nonSolMint: 'MINT', // SOL-paired (non-SOL side known)
    nonSolSymbol: 'TOK',
    ...over,
  };
}

describe('decideEntry — paper entry decision (skip non-SOL + sizing)', () => {
  it('normal SOL-paired open → mirrored at the sizing size (50%×2 = 1, cap 1)', () => {
    const d = decideEntry(openEvent(), cfg(), flush);
    expect(d).toMatchObject({ outcome: 'mirrored', leaderSizeSol: 2 });
    if (d.outcome === 'mirrored') expect(d.sizeSol).toBeCloseTo(1, 9);
  });

  it('non-SOL pool (nonSolMint null) + skipNonSolPaired ON → skip non_sol_paired BEFORE sizing', () => {
    // WHY: explicit non-goal — we never copy a non-SOL-paired position by default.
    expect(decideEntry(openEvent({ nonSolMint: null }), cfg(), flush)).toEqual({
      outcome: 'skipped',
      reason: 'non_sol_paired',
      leaderSizeSol: 2,
    });
  });

  it('non-SOL pool but skipNonSolPaired OFF → the gate no longer blocks, we move on to sizing', () => {
    const d = decideEntry(openEvent({ nonSolMint: null }), cfg({ skipNonSolPaired: false }), flush);
    expect(d.outcome).toBe('mirrored'); // no more non_sol_paired skip
  });

  it('open too small (target below the floor) → skip below_min_floor', () => {
    // ratio 100 × 0.04 = 0.04 < 0.05.
    expect(decideEntry(openEvent({ depositSol: 0.04 }), cfg({ tradeRatioPct: 100 }), flush)).toMatchObject({
      outcome: 'skipped',
      reason: 'below_min_floor',
    });
  });

  it('insufficient balance, skip mode → skip insufficient_balance', () => {
    expect(decideEntry(openEvent(), cfg(), { availableBalanceSol: 0.5 })).toMatchObject({
      outcome: 'skipped',
      reason: 'insufficient_balance',
    });
  });

  it('insufficient balance, reduceToFit mode → reduced to the available size', () => {
    const d = decideEntry(openEvent(), cfg({ onInsufficient: 'reduceToFit' }), { availableBalanceSol: 0.5 });
    expect(d.outcome).toBe('reduced');
    if (d.outcome === 'reduced') expect(d.sizeSol).toBeCloseTo(0.45, 9); // 0.5 − 0.05 reserve
  });

  describe('filter integration (P2.3)', () => {
    const fctx = (over: Partial<FilterContext> = {}): FilterContext => ({ openTokenMints: new Set(), ...over });

    it('filters provided but all OFF → does not block, we move on to sizing (mirrored)', () => {
      const d = decideEntry(openEvent(), cfg(), flush, { ctx: fctx(), config: FILTERS_ALL_OFF });
      expect(d.outcome).toBe('mirrored');
    });

    it('an enabled filter that rejects → skip with the filter reason (before sizing)', () => {
      const d = decideEntry(openEvent({ nonSolMint: 'MINT' }), cfg(), flush, {
        ctx: fctx(),
        config: { ...FILTERS_ALL_OFF, ignoredTokens: ['MINT'] },
      });
      expect(d).toMatchObject({ outcome: 'skipped', reason: 'ignored_token' });
    });

    it('the non-SOL gate comes BEFORE the filters (a non-SOL pool skips as non_sol_paired)', () => {
      // WHY: even with filters provided, non-SOL stays the 1st rejection.
      const d = decideEntry(openEvent({ nonSolMint: null }), cfg(), flush, {
        ctx: fctx(),
        config: { ...FILTERS_ALL_OFF, ignoredTokens: ['MINT'] },
      });
      expect(d).toMatchObject({ outcome: 'skipped', reason: 'non_sol_paired' });
    });

    it('a filter rejects BEFORE sizing (short-circuit: no sizing of a rejection)', () => {
      // huge balance → sizing would give mirrored, but singlePoolPerToken must short-circuit.
      const d = decideEntry(openEvent({ nonSolMint: 'MINT' }), cfg(), flush, {
        ctx: fctx({ openTokenMints: new Set(['MINT']) }),
        config: { ...FILTERS_ALL_OFF, singlePoolPerToken: true },
      });
      expect(d).toMatchObject({ outcome: 'skipped', reason: 'single_pool_per_token' });
    });
  });
});
