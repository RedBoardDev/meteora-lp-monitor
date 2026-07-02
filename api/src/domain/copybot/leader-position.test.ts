import { describe, expect, it } from 'vitest';
import type { DetectedEvent } from './events';
import { LeaderPositionTracker } from './leader-position';

// Detected-event constructor (the tracker operates on DetectedEvent, not raw tx → readable fixtures).
function ev(p: {
  sig: string;
  instr: string;
  deposit?: number;
  withdraw?: number;
  claim?: number;
  position?: string;
  pool?: string;
  mint?: string | null;
  symbol?: string | null;
  blockTime?: number;
}): DetectedEvent {
  return {
    signature: p.sig,
    blockTime: p.blockTime ?? 1000,
    instruction: p.instr,
    depositSol: p.deposit ?? 0,
    withdrawSol: p.withdraw ?? 0,
    claimSol: p.claim ?? 0,
    closed: false,
    pool: p.pool ?? 'POOL',
    position: p.position ?? 'POS',
    nonSolMint: p.mint === undefined ? 'MINT' : p.mint,
    nonSolSymbol: p.symbol ?? null,
  };
}

describe('LeaderPositionTracker — per-position lifecycle aggregation', () => {
  it('OPEN (1st capital-bearing event) → opens, openSize = deposit, openedAt set', () => {
    const t = new LeaderPositionTracker();
    // capital-open via AddLiquidity (handles the InitializePosition→AddLiquidity split: openSize = 1st deposit,
    // whatever the instruction class).
    const p = t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5, blockTime: 1000 }));
    expect(p).toMatchObject({
      status: 'open',
      openSizeSol: 5,
      openSizeKnown: true,
      depositedSol: 5,
      netSizeSol: 5,
      openedAt: 1000,
    });
  });

  it('OPEN then ADD → depositedSol grows but openSize stays the 1st deposit (stable sizing input)', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(ev({ sig: '2', instr: 'AddLiquidityByStrategy2', deposit: 3 }));
    // WHY: the sizing input = the OPEN size, not the current size; an add must not rewrite it.
    expect(p).toMatchObject({ openSizeSol: 5, depositedSol: 8, netSizeSol: 8, status: 'open' });
  });

  it('PARTIAL withdrawal → the position stays OPEN (a partial is not a close)', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(ev({ sig: '2', instr: 'RemoveLiquidityByRange2', withdraw: 2 }));
    // WHY: pillar — mistaking a partial for a close would make us think the leader has exited.
    expect(p).toMatchObject({ status: 'open', withdrawnSol: 2, netSizeSol: 3 });
    expect(t.openPositions()).toHaveLength(1);
  });

  it('CLOSE → status closed + closedAt, withdrawal and fees counted', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(ev({ sig: '2', instr: 'ClosePosition2', withdraw: 4, claim: 0.5, blockTime: 2000 }));
    // WHY: the close is the mirror-close trigger; it must mark the position closed unambiguously.
    expect(p?.status).toBe('closed');
    expect(p?.closedAt).toBe(2000);
    expect(p?.withdrawnSol).toBeCloseTo(4, 9);
    expect(p?.claimedSol).toBeCloseTo(0.5, 9);
    expect(t.openPositions()).toHaveLength(0);
  });

  it('CLAIM → claimedSol grows, but neither status nor netSize change (fees are not capital)', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    const p = t.apply(ev({ sig: '2', instr: 'ClaimFee2', claim: 0.3 }));
    expect(p).toMatchObject({ status: 'open', netSizeSol: 5 });
    expect(p?.claimedSol).toBeCloseTo(0.3, 9);
  });

  it('cold start: a withdrawal for a position whose open was never seen → created, openSizeKnown=false', () => {
    const t = new LeaderPositionTracker();
    // WHY: the cold replay only sees the last 25 sigs → we often join mid-life; we must
    // never crash or mis-key, and we flag that the fraction base is unknown (OQ #3).
    const p = t.apply(ev({ sig: '1', instr: 'RemoveLiquidityByRange2', withdraw: 2 }));
    expect(p).toMatchObject({ status: 'open', openSizeKnown: false, openSizeSol: 0, withdrawnSol: 2, netSizeSol: -2 });
  });

  it('CLOSE for an unknown position → created then closed (we never miss a close, even joined mid-life)', () => {
    const t = new LeaderPositionTracker();
    const p = t.apply(ev({ sig: '1', instr: 'ClosePosition2', withdraw: 3 }));
    expect(p).toMatchObject({ status: 'closed', openSizeKnown: false });
  });

  it('idempotent per signature: re-applying the same event does not double-count', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 })); // duplicate (replay/live overlap)
    expect(t.get('POS')).toMatchObject({ depositedSol: 5, eventCount: 1 });
  });

  it('positions independent per pubkey; openPositions() returns only the open ones', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5, position: 'A' }));
    t.apply(ev({ sig: '2', instr: 'AddLiquidityByStrategy2', deposit: 4, position: 'B' }));
    t.apply(ev({ sig: '3', instr: 'ClosePosition2', withdraw: 4, position: 'B' }));
    expect(t.openPositions().map((p) => p.position)).toEqual(['A']);
    expect(t.all()).toHaveLength(2);
  });

  it('metadata: the last non-empty value wins; an empty field does not overwrite a known one', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5, symbol: null })); // mint known, symbol unknown
    // a later event brings the symbol; a null mint must NOT erase the already-known mint.
    const p = t.apply(ev({ sig: '2', instr: 'ClaimFee2', claim: 0.1, symbol: 'TOK', mint: null }));
    expect(p?.nonSolSymbol).toBe('TOK'); // symbol filled in after the fact
    expect(p?.nonSolMint).toBe('MINT'); // known mint preserved (null does not overwrite)
  });

  it('a 2nd close event (position already closed) does not rewrite status/closedAt', () => {
    const t = new LeaderPositionTracker();
    t.apply(ev({ sig: '1', instr: 'AddLiquidityByStrategy2', deposit: 5 }));
    t.apply(ev({ sig: '2', instr: 'ClosePosition2', withdraw: 4, blockTime: 2000 }));
    const p = t.apply(ev({ sig: '3', instr: 'ClosePosition2', withdraw: 1, blockTime: 3000 }));
    expect(p?.status).toBe('closed');
    expect(p?.closedAt).toBe(2000); // the 1st close is authoritative (guard status === 'open')
  });

  it('event without a position ("") → ignored (tx with no leg, e.g. pure InitializePosition, no capital)', () => {
    const t = new LeaderPositionTracker();
    expect(t.apply(ev({ sig: '1', instr: 'InitializePositionPda', position: '' }))).toBeUndefined();
    expect(t.all()).toHaveLength(0);
  });
});
