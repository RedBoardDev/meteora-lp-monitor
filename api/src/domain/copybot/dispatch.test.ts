import { describe, expect, it } from 'vitest';
import { type EventAction, classifyEventAction } from './dispatch';
import type { DetectedEvent } from './events';

const ev = (over: Partial<DetectedEvent>): DetectedEvent => ({
  signature: 'sig',
  blockTime: 1,
  instruction: '',
  depositSol: 0,
  withdrawSol: 0,
  claimSol: 0,
  pool: 'POOL',
  position: 'POS',
  nonSolMint: null,
  nonSolSymbol: null,
  ...over,
});

const route = (over: Partial<DetectedEvent>, tracked: boolean, infiniteAdd = true): EventAction =>
  classifyEventAction(ev(over), tracked, infiniteAdd);

describe('classifyEventAction — event routing (robustness)', () => {
  it('first deposit on an UNTRACKED position → open', () => {
    expect(route({ instruction: 'InitializePosition', depositSol: 0.1 }, false)).toBe('open');
  });

  it('any event on an UNTRACKED position with no deposit → ignore (no stale copying)', () => {
    expect(route({ instruction: 'ClaimFee', claimSol: 0.01 }, false)).toBe('ignore');
    expect(route({ instruction: 'RemoveLiquidity', withdrawSol: 0.05 }, false)).toBe('ignore');
    expect(route({ instruction: 'ClosePosition', withdrawSol: 0.1 }, false)).toBe('ignore');
  });

  it('deposit on a TRACKED position → resync (grow)', () => {
    expect(route({ instruction: 'AddLiquidityByStrategy2', depositSol: 0.04 }, true)).toBe('resync');
  });

  it('close instruction on a TRACKED position → close (even though it also withdraws)', () => {
    // A close ALSO carries a withdraw; the close MUST win — checked before the withdraw branch.
    expect(route({ instruction: 'ClosePosition', withdrawSol: 0.1 }, true)).toBe('close');
  });

  it('partial withdrawal (remove, no close) on a TRACKED position → resync (shrink)', () => {
    expect(route({ instruction: 'RemoveLiquidity', withdrawSol: 0.05 }, true)).toBe('resync');
  });

  it('★ a fee CLAIM is NEVER routed to a close or resize — it is a claim', () => {
    // The critical no-false-close guarantee: a claim must not be mistaken for a close (would close our copy) nor a
    // withdraw (would shrink it). Claim is detected by the instruction OR a positive claimSol.
    expect(route({ instruction: 'ClaimFee', claimSol: 0.01 }, true)).toBe('claim');
    expect(route({ instruction: 'ClaimReward', claimSol: 0 }, true)).toBe('claim'); // classified by instruction even with 0 SOL
    expect(route({ instruction: 'SomethingElse', claimSol: 0.002 }, true)).toBe('claim'); // positive claimSol alone
  });

  it('a claim that ALSO reports a withdraw is still a claim ONLY if not a close (close+withdraw wins as close)', () => {
    // Defensive: if a tx both withdraws AND is a close, it is a close. A pure claim with an incidental withdraw>0
    // routes to resync (withdraw branch) — never silently dropped. Encodes the documented precedence.
    expect(route({ instruction: 'ClosePosition', withdrawSol: 0.1, claimSol: 0.01 }, true)).toBe('close');
    expect(route({ instruction: 'RemoveLiquidity', withdrawSol: 0.05, claimSol: 0.01 }, true)).toBe('resync');
  });

  it('a no-op event on a tracked position (no deposit/withdraw/claim, unknown instruction) → ignore', () => {
    expect(route({ instruction: 'Unknown' }, true)).toBe('ignore');
  });
});

describe('classifyEventAction — infinite-add gate (default OFF: only the first deposit, removes always followed)', () => {
  const add = { instruction: 'AddLiquidityByStrategy2', depositSol: 0.04 };

  it('infiniteAdd OFF: a pure leader ADD on a tracked position → ignore (we do not grow with the leader)', () => {
    expect(route(add, true, false)).toBe('ignore');
  });

  it('infiniteAdd ON: the same ADD → resync (grow with the leader)', () => {
    expect(route(add, true, true)).toBe('resync');
  });

  it('★ even with infiniteAdd OFF, a REMOVE is still followed → resync (shrink); a CLOSE still closes (no-dormant safety)', () => {
    // The gate must NEVER touch the exit path — missing a leader remove/close is the cardinal sin.
    expect(route({ instruction: 'RemoveLiquidity', withdrawSol: 0.05 }, true, false)).toBe('resync');
    expect(route({ instruction: 'ClosePosition', withdrawSol: 0.1 }, true, false)).toBe('close');
  });

  it('infiniteAdd OFF does not affect a first open on an untracked position', () => {
    expect(route({ instruction: 'InitializePosition', depositSol: 0.1 }, false, false)).toBe('open');
  });
});
