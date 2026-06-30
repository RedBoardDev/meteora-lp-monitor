/**
 * Copy-bot · observability — renderer invariants (SPEC §3). These tests encode the WHY:
 *  - SOL-ONLY: a snapshot proves the user feed never leaks a USD figure or a fabricated amount (locked decision 2);
 *  - the D-2/D-6 honesty labels ("configured", "intended") survive rendering — we never claim a live balance or a
 *    realized delta we do not have;
 *  - an internal code yields `null` (it must NOT reach the user feed, ever — the loop-guard invariant);
 *  - `pairLabel` degrades gracefully to a truncated mint when the token symbol is unknown (no crash, no blank).
 */
import { describe, expect, it } from 'vitest';
import type { CopyCode } from './codes';
import type { CopyEvent } from './event';
import { pairLabel, toUserMessage } from './render-user';

const BASE_CTX = { userId: 'SYSTEM', wallet: 'CopyWa11et', process: 'brain' as const };

/** Build a minimal `CopyEvent` for `code`, overriding only the fields a given template reads. Pure test fixture. */
function event(code: CopyCode, over: Partial<CopyEvent> = {}): CopyEvent {
  return {
    code,
    severity: 'info',
    category: 'LIFECYCLE',
    audience: 'feed',
    pinned: false,
    ts: 1_700_000_000_000,
    eventTs: 1_700_000_000_000,
    ctx: BASE_CTX,
    stage: 'open',
    outcome: 'confirmed',
    adminDetail: { nonSolSymbol: 'WIF' },
    ...over,
  };
}

describe('render-user · pairLabel (SPEC §3.2)', () => {
  it('uses the non-SOL symbol when known', () => {
    expect(pairLabel(event('lifecycle.open_confirmed'))).toBe('WIF/SOL');
  });

  it('falls back to a 4-char mint truncation when the symbol is unknown', () => {
    // WHY: tokens without a resolved symbol must still render a stable pair label, never blank or "undefined/SOL".
    const e = event('lifecycle.open_confirmed', { adminDetail: { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' } });
    expect(pairLabel(e)).toBe('EKpQ/SOL');
  });

  it('uses a literal placeholder when neither symbol nor mint is present', () => {
    expect(pairLabel(event('lifecycle.open_confirmed', { adminDetail: {} }))).toBe('?/SOL');
  });
});

describe('render-user · internal codes never reach the feed (SPEC §3.2 + §6 loop guard)', () => {
  it('returns null for an internal code', () => {
    // WHY: rendering an internal code to the user would violate the audience boundary (e.g. self-failures must
    // never user-notify through the broken path). `null` is the contract the adapter relies on to skip the feed.
    expect(toUserMessage(event('detect.observed', { audience: 'internal', category: 'DETECT' }))).toBeNull();
    expect(toUserMessage(event('sign.land_failed', { audience: 'internal', category: 'SIGN' }))).toBeNull();
  });
});

describe('render-user · SOL-only feed templates (SPEC §3.2)', () => {
  // One representative event per §3.2 template. Snapshots lock the SOL-only wording AND the honesty labels.
  it('open', () => {
    const m = toUserMessage(event('lifecycle.open_confirmed', { leaderSizeSol: 12, ourSizeSol: 0.85, adminDetail: { nonSolSymbol: 'WIF', openCount: 3 } }));
    expect(m).toMatchSnapshot();
  });

  it('close (intended size, D-6 labelled)', () => {
    const m = toUserMessage(event('lifecycle.close_confirmed', { stage: 'close', ourSizeSol: 0.85, signature: 'aaaaaaaaaaaa11111111zzzzzzzzzzzz', adminDetail: { nonSolSymbol: 'WIF' } }));
    expect(m).toMatchSnapshot();
  });

  it('partial-remove', () => {
    const m = toUserMessage(event('lifecycle.remove_partial', { stage: 'reshape', adminDetail: { nonSolSymbol: 'WIF', removedPct: 35 } }));
    expect(m).toMatchSnapshot();
  });

  it('add (intended size, first add, D-6 labelled)', () => {
    const m = toUserMessage(event('lifecycle.add_confirmed', { stage: 'reshape', ourSizeSol: 0.4, adminDetail: { nonSolSymbol: 'WIF', firstAdd: true } }));
    expect(m).toMatchSnapshot();
  });

  it('add — infinite-add off variant', () => {
    const m = toUserMessage(event('cap.infinite_add_skipped', { category: 'CAP', stage: 'reshape', outcome: 'blocked', adminDetail: { nonSolSymbol: 'WIF' } }));
    expect(m).toMatchSnapshot();
  });

  it('swap (intended SOL out, D-6 labelled)', () => {
    const m = toUserMessage(event('swap.executed', { category: 'SWAP', stage: 'sell', ourSizeSol: 0.31, signature: 'bbbbbbbbbbbb22222222yyyyyyyyyyyy', adminDetail: { nonSolSymbol: 'WIF', swapInAmount: 124_500 } }));
    expect(m).toMatchSnapshot();
  });

  it('insufficient-balance (CONFIGURED value, D-2 labelled)', () => {
    const m = toUserMessage(
      event('balance.insufficient', { category: 'BALANCE', severity: 'error', pinned: true, stage: 'open', outcome: 'skipped', adminDetail: { nonSolSymbol: 'WIF', configuredSol: 0.42, requiredSol: 0.85 } }),
    );
    expect(m).toMatchSnapshot();
  });

  it('skipped-filter (transparency)', () => {
    const m = toUserMessage(event('filter.below_min_market_cap', { category: 'FILTER', stage: 'open', outcome: 'skipped', reason: 'below_min_market_cap', adminDetail: { nonSolSymbol: 'WIF' } }));
    expect(m).toMatchSnapshot();
  });

  it('skipped-cap', () => {
    const m = toUserMessage(event('cap.max_open_positions', { category: 'CAP', severity: 'warn', stage: 'open', outcome: 'blocked', reason: 'max_open_positions', adminDetail: { nonSolSymbol: 'WIF' } }));
    expect(m).toMatchSnapshot();
  });

  it('failsafe-activated', () => {
    const m = toUserMessage(
      event('failsafe.activated', { category: 'FAILSAFE', severity: 'warn', pinned: true, stage: 'failsafe', outcome: 'confirmed', reason: 'leader_closed', signature: 'cccccccccccc33333333xxxxxxxxxxxx', adminDetail: { nonSolSymbol: 'WIF' } }),
    );
    expect(m).toMatchSnapshot();
  });

  it('failsafe-failed (close manually link)', () => {
    const m = toUserMessage(
      event('failsafe.failed', { category: 'FAILSAFE', severity: 'error', pinned: true, stage: 'failsafe', outcome: 'failed', reason: 'failed', adminDetail: { nonSolSymbol: 'WIF', meteoraUrl: 'https://app.meteora.ag/dlmm/POOL' } }),
    );
    expect(m).toMatchSnapshot();
  });

  it('swap-failed (jup manual link)', () => {
    const m = toUserMessage(
      event('swap.failed_after_retries', { category: 'SWAP', severity: 'error', pinned: true, stage: 'sell', outcome: 'failed', reason: 'failed_after_retries', adminDetail: { nonSolSymbol: 'WIF' } }),
    );
    expect(m).toMatchSnapshot();
  });

  it('does not leak USD or a currency symbol anywhere in the rendered parts', () => {
    // WHY: locked decision 2 — SOL-only. A regression that interpolated a `$` figure would violate the contract.
    const m = toUserMessage(event('lifecycle.open_confirmed', { leaderSizeSol: 12, ourSizeSol: 0.85, adminDetail: { nonSolSymbol: 'WIF', openCount: 3 } }));
    const joined = [m?.emoji, ...(m?.lineParts ?? []), ...(m?.links ?? []).map((l) => l.label)].join(' ');
    expect(joined).not.toContain('$');
    expect(joined).not.toMatch(/USD/i);
  });
});
