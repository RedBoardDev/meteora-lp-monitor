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
  closed: false,
  pool: 'POOL',
  position: 'POS',
  nonSolMint: null,
  nonSolSymbol: null,
  ...over,
});

const route = (over: Partial<DetectedEvent>, tracked: boolean, infiniteAdd = true, claimFloorSol = 0): EventAction =>
  classifyEventAction(ev(over), tracked, { infiniteAdd, claimFloorSol });

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

describe('classifyEventAction — close routing keys off `e.closed`, not the log label (10KB truncation)', () => {
  // NO-MISS PILLAR: under log truncation the DLMM instruction name is lost → `instruction` degrades to
  // '(DLMM)' and `classifyInstruction` yields null. A close (which the decoder still sees via inner CPI, so
  // `e.closed === true`) MUST still route to 'close'. Relying on the label alone (the OLD code) would
  // mis-route these: a standalone close (0 amounts) → 'ignore', a Remove+Close → 'resync'. Both are forbidden.
  const UNCLASSIFIABLE = '(DLMM)'; // classifyInstruction('(DLMM)') === null (matches no known instruction)

  it('★ standalone close (closed:true, 0 amounts, unclassifiable label) on a TRACKED position → close (was ignore)', () => {
    // OLD kind-only code: kind=null, no deposit/withdraw/claim → falls through to 'ignore' → the close is MISSED.
    expect(route({ instruction: UNCLASSIFIABLE, closed: true }, true)).toBe('close');
  });

  it('★ close+withdraw (closed:true, withdrawSol>0, unclassifiable label) on a TRACKED position → close (was resync)', () => {
    // OLD kind-only code: kind=null → the withdraw branch wins → 'resync' → treated as a shrink, not a close.
    expect(route({ instruction: UNCLASSIFIABLE, closed: true, withdrawSol: 0.1 }, true)).toBe('close');
  });

  it('a partial remove (closed:false, withdrawSol>0, unclassifiable label) on a TRACKED position → resync (unchanged)', () => {
    // Not a close → the `e.closed` branch must NOT fire; a genuine withdraw still routes to resync.
    expect(route({ instruction: UNCLASSIFIABLE, closed: false, withdrawSol: 0.1 }, true)).toBe('resync');
  });

  it('a first deposit (closed:false, depositSol>0, unclassifiable label) on an UNTRACKED position → open (unchanged)', () => {
    expect(route({ instruction: UNCLASSIFIABLE, closed: false, depositSol: 0.1 }, false)).toBe('open');
  });

  it('a claim (positive claimSol) still routes to claim, never close (closed:false)', () => {
    expect(route({ instruction: UNCLASSIFIABLE, closed: false, claimSol: 0.01 }, true)).toBe('claim');
  });

  it('close-by-label still works when NOT truncated (kind==="close" path, closed defaulting) — no regression', () => {
    expect(route({ instruction: 'ClosePosition', withdrawSol: 0.1, closed: false }, true)).toBe('close');
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

describe('classifyEventAction — claim-floor gate (skip dust fee-claims)', () => {
  const claim = (sol: number) => ({ instruction: 'ClaimFee', claimSol: sol });

  it('a leader claim ≥ floor → claim', () => {
    expect(route(claim(0.05), true, true, 0.01)).toBe('claim');
  });

  it('a leader claim below floor → ignore (no dust-claim mirroring / tx spam)', () => {
    expect(route(claim(0.005), true, true, 0.01)).toBe('ignore');
  });

  it('floor 0 mirrors every claim (including a 0-SOL claim-by-instruction)', () => {
    expect(route(claim(0), true, true, 0)).toBe('claim');
  });
});

describe('classifyEventAction — rug-SL exit must NOT auto-reopen (the leader position stays open on-chain)', () => {
  const add = { instruction: 'AddLiquidityByStrategy2', depositSol: 0.1 };
  const cfg = { infiniteAdd: false, claimFloorSol: 0 };

  it('a leader ADD on an UNTRACKED-but-rug-exited position → ignore (we deliberately left; never re-buy the rug)', () => {
    // WHY: rug-SL closes OUR mirror but the leader position lives on; without this guard its next add (depositSol>0,
    // now untracked) would route to 'open' and re-enter the position we just crash-exited.
    expect(classifyEventAction(ev(add), false, cfg, true)).toBe('ignore');
  });

  it('the SAME add on an untracked position that was NOT rug-exited still opens (normal first copy)', () => {
    expect(classifyEventAction(ev(add), false, cfg, false)).toBe('open');
  });

  it('rug-exited does not interfere with a TRACKED position routing (close/resync unaffected)', () => {
    // The flag only gates the untracked-open path; a still-tracked mirror routes normally regardless.
    expect(classifyEventAction(ev({ instruction: 'ClosePosition', withdrawSol: 0.1 }), true, cfg, true)).toBe('close');
    expect(classifyEventAction(ev({ instruction: 'RemoveLiquidity', withdrawSol: 0.05 }), true, cfg, true)).toBe('resync');
  });
});
