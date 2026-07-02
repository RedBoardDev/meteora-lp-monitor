import { describe, expect, it } from 'vitest';
import { CAPS_DEFAULTS } from './caps';
import type { EntryConfig } from './decision';
import type { DetectedEvent } from './events';
import { FILTERS_ALL_OFF } from './filters';
import type { LeaderPosition } from './leader-position';
import { type PaperEngineDeps, type PaperOutcome, paperDecisionRow, processPaperEvent } from './paper-engine';
import { PaperPositionLedger } from './paper-position';

const NOW = 1_000_000_000;

const CONFIG: EntryConfig = {
  tradeRatioPct: 50,
  maxTradeSizeSol: 1.0,
  minPositionSizeSol: 0.05,
  solReserveSol: 0.05,
  onInsufficient: 'skip',
  skipNonSolPaired: true,
};

function ev(over: Partial<DetectedEvent> = {}): DetectedEvent {
  return {
    signature: 'sig',
    blockTime: 1000,
    instruction: 'AddLiquidityByStrategy2',
    depositSol: 2,
    withdrawSol: 0,
    claimSol: 0,
    closed: false,
    pool: 'POOL',
    position: 'P',
    nonSolMint: 'MINT',
    nonSolSymbol: 'TOK',
    ...over,
  };
}

function leaderPos(over: Partial<LeaderPosition> = {}): LeaderPosition {
  return {
    position: 'P',
    pool: 'POOL',
    nonSolMint: 'MINT',
    nonSolSymbol: 'TOK',
    status: 'open',
    openSizeSol: 2,
    openSizeKnown: true,
    depositedSol: 2,
    withdrawnSol: 0,
    claimedSol: 0,
    netSizeSol: 2,
    openedAt: 1000,
    closedAt: null,
    lastSignature: 'sig',
    eventCount: 1,
    ...over,
  };
}

const deps = (over: Partial<PaperEngineDeps> = {}): PaperEngineDeps => ({
  isLive: true,
  ledger: new PaperPositionLedger(),
  config: CONFIG,
  filterConfig: FILTERS_ALL_OFF,
  caps: CAPS_DEFAULTS,
  followerBalanceSol: 1000,
  nowMs: NOW,
  ...over,
});

describe('processPaperEvent — paper decision (entry + mirror-close)', () => {
  it('replay (isLive=false) → null, no mirror opened (paper = live only)', () => {
    const d = deps({ isLive: false });
    expect(processPaperEvent(ev(), leaderPos(), d)).toBeNull();
    expect(d.ledger.openPositions()).toHaveLength(0);
  });

  it('event without a leader position (undefined) → null', () => {
    expect(processPaperEvent(ev({ position: '' }), undefined, deps())).toBeNull();
  });

  it('ENTRY mirrored → mirrored decision + mirror opened in the ledger at the sized amount', () => {
    const d = deps();
    const out = processPaperEvent(ev(), leaderPos(), d);
    expect(out).toMatchObject({ kind: 'entry', decision: { outcome: 'mirrored' } });
    expect(out?.kind === 'entry' && out.opened?.sizeSol).toBeCloseTo(1, 9);
    expect(d.ledger.get('P')).toMatchObject({ status: 'open', sizeSol: 1 });
  });

  it('ENTRY skipped (non-SOL pool) → skipped decision, NO mirror opened', () => {
    const d = deps();
    const out = processPaperEvent(ev({ nonSolMint: null }), leaderPos(), d);
    expect(out).toMatchObject({ kind: 'entry', decision: { outcome: 'skipped', reason: 'non_sol_paired' } });
    expect(out?.kind === 'entry' && out.opened).toBeNull();
    expect(d.ledger.get('P')).toBeUndefined(); // we don't open a mirror for a skip
  });

  it('ENTRY reduced (insufficient balance, reduceToFit) → mirror opened at the reduced size', () => {
    const d = deps({ config: { ...CONFIG, onInsufficient: 'reduceToFit' }, followerBalanceSol: 0.5 });
    const out = processPaperEvent(ev(), leaderPos(), d);
    expect(out).toMatchObject({ kind: 'entry', decision: { outcome: 'reduced' } });
    expect(d.ledger.get('P')?.sizeSol).toBeCloseTo(0.45, 9); // 0.5 − 0.05 reserve
  });

  it('ENTRY rejected by a filter (ignoredTokens) → skipped, no mirror opened', () => {
    const d = deps({ filterConfig: { ...FILTERS_ALL_OFF, ignoredTokens: ['MINT'] } });
    const out = processPaperEvent(ev(), leaderPos(), d);
    expect(out).toMatchObject({ kind: 'entry', decision: { outcome: 'skipped', reason: 'ignored_token' } });
    expect(out?.kind === 'entry' && out.opened).toBeNull();
    expect(d.ledger.get('P')).toBeUndefined();
  });

  it('singlePoolPerToken via the ledger: 2nd open of the same token rejected (1 live position per token)', () => {
    // WHY: the filter context comes from the real ledger → the 2nd entry sees the token is already held.
    const d = deps({ filterConfig: { ...FILTERS_ALL_OFF, singlePoolPerToken: true } });
    const first = processPaperEvent(ev({ signature: 's1', position: 'A' }), leaderPos({ position: 'A' }), d);
    expect(first).toMatchObject({ kind: 'entry', decision: { outcome: 'mirrored' } }); // 1st opened
    const second = processPaperEvent(ev({ signature: 's2', position: 'B' }), leaderPos({ position: 'B' }), d);
    expect(second).toMatchObject({ kind: 'entry', decision: { outcome: 'skipped', reason: 'single_pool_per_token' } });
    expect(d.ledger.get('B')).toBeUndefined(); // 2nd not opened
  });

  it('CAP global kill-switch → entry requalified as skip kill_switch_global, no mirror', () => {
    const d = deps({ caps: { ...CAPS_DEFAULTS, killSwitchGlobal: true } });
    const out = processPaperEvent(ev(), leaderPos(), d);
    expect(out).toMatchObject({ kind: 'entry', decision: { outcome: 'skipped', reason: 'kill_switch_global' } });
    expect(out?.kind === 'entry' && out.opened).toBeNull();
    expect(d.ledger.openPositions()).toHaveLength(0);
  });

  it('CAP maxOpenPositions: 2nd open at the cap → skip max_open_positions', () => {
    const d = deps({ caps: { ...CAPS_DEFAULTS, maxOpenPositions: 1 } });
    expect(processPaperEvent(ev({ signature: 's1', position: 'A' }), leaderPos({ position: 'A' }), d)).toMatchObject({
      decision: { outcome: 'mirrored' },
    });
    const second = processPaperEvent(ev({ signature: 's2', position: 'B' }), leaderPos({ position: 'B' }), d);
    expect(second).toMatchObject({ kind: 'entry', decision: { outcome: 'skipped', reason: 'max_open_positions' } });
    expect(d.ledger.get('B')).toBeUndefined();
  });

  it('non-SOL entry allowed (skipNonSolPaired OFF) → caps evaluated with tokenMint null', () => {
    // WHY: covers the "no token" branch of the per-token counting in the caps state.
    const d = deps({ config: { ...CONFIG, skipNonSolPaired: false } });
    expect(processPaperEvent(ev({ nonSolMint: null }), leaderPos(), d)).toMatchObject({
      kind: 'entry',
      decision: { outcome: 'mirrored' },
    });
  });

  it('CAP maxTotalExposureSol: size that exceeds the max exposure → skip max_total_exposure', () => {
    // sizing would give 1 SOL, but the exposure cap (0.5) forbids it.
    const d = deps({ caps: { ...CAPS_DEFAULTS, maxTotalExposureSol: 0.5 } });
    const out = processPaperEvent(ev(), leaderPos(), d);
    expect(out).toMatchObject({ kind: 'entry', decision: { outcome: 'skipped', reason: 'max_total_exposure' } });
  });

  it('ADD to an existing position (eventCount>1) → null (not an entry)', () => {
    expect(processPaperEvent(ev({ depositSol: 1 }), leaderPos({ eventCount: 2 }), deps())).toBeNull();
  });

  it('CLAIM → null (neither entry nor close)', () => {
    const e = ev({ instruction: 'ClaimFee2', depositSol: 0, claimSol: 0.3 });
    expect(processPaperEvent(e, leaderPos({ eventCount: 2 }), deps())).toBeNull();
  });

  it('PARTIAL withdrawal → null (a partial is not a close)', () => {
    const e = ev({ instruction: 'RemoveLiquidityByRange2', depositSol: 0, withdrawSol: 1 });
    expect(processPaperEvent(e, leaderPos({ eventCount: 2 }), deps())).toBeNull();
  });

  it('leader CLOSE of a position we hold → mirror_close + mirror closed', () => {
    const d = deps();
    processPaperEvent(ev(), leaderPos(), d); // we open the mirror first
    const closeEv = ev({ instruction: 'ClosePosition2', signature: 'close-sig', depositSol: 0, withdrawSol: 4, blockTime: 2000 });
    const out = processPaperEvent(closeEv, leaderPos({ eventCount: 2, status: 'closed' }), d);
    expect(out).toMatchObject({ kind: 'mirror_close' });
    expect(out?.kind === 'mirror_close' && out.closed.status).toBe('closed');
    expect(d.ledger.openPositions()).toHaveLength(0);
  });

  it('leader CLOSE of a position we DON’T hold (open skipped) → null', () => {
    const d = deps();
    const closeEv = ev({ instruction: 'ClosePosition2', position: 'X', withdrawSol: 4 });
    expect(processPaperEvent(closeEv, leaderPos({ position: 'X', eventCount: 2 }), d)).toBeNull();
  });

  it('CLOSE already mirror-closed → 2nd close = null (idempotent, no double-log)', () => {
    const d = deps();
    processPaperEvent(ev(), leaderPos(), d);
    const closeEv = ev({ instruction: 'ClosePosition2', signature: 'c', withdrawSol: 4 });
    expect(processPaperEvent(closeEv, leaderPos({ eventCount: 2 }), d)).toMatchObject({ kind: 'mirror_close' });
    expect(processPaperEvent(ev({ instruction: 'ClosePosition2', signature: 'c2', withdrawSol: 1 }), leaderPos({ eventCount: 3 }), d)).toBeNull();
  });
});

describe('paperDecisionRow — action → copy_decisions row mapping', () => {
  it('mirrored entry → open row with ourSizeSol and no skipReason', () => {
    const out = processPaperEvent(ev(), leaderPos(), deps()) as NonNullable<PaperOutcome>;
    expect(paperDecisionRow(ev(), out)).toEqual({
      signature: 'sig',
      pool: 'POOL',
      position: 'P',
      eventKind: 'open',
      outcome: 'mirrored',
      skipReason: null,
      leaderSizeSol: 2,
      ourSizeSol: 1,
      blockTime: 1000,
    });
  });

  it('skipped entry → open row with skipReason and ourSizeSol null', () => {
    const out = processPaperEvent(ev({ nonSolMint: null }), leaderPos(), deps()) as NonNullable<PaperOutcome>;
    const row = paperDecisionRow(ev({ nonSolMint: null }), out);
    expect(row).toMatchObject({ eventKind: 'open', outcome: 'skipped', skipReason: 'non_sol_paired', ourSizeSol: null });
  });

  it('sets pool/position to null if empty (defensive branch of the mapping)', () => {
    const closeOutcome = {
      kind: 'mirror_close',
      closed: {
        leaderPosition: 'P',
        pool: '',
        nonSolMint: null,
        nonSolSymbol: null,
        sizeSol: 1,
        status: 'closed',
        openSignature: 'o',
        openedAtMs: 1,
        openedAtBlockTime: 1,
        closeSignature: 'c',
        closedAtBlockTime: 2,
      },
    } as const;
    const row = paperDecisionRow(ev({ pool: '', position: '' }), closeOutcome);
    expect(row.pool).toBeNull();
    expect(row.position).toBeNull();
  });

  it('mirror_close → close row (leaderSizeSol = leader withdrawal, ourSizeSol = mirror size)', () => {
    const d = deps();
    processPaperEvent(ev(), leaderPos(), d);
    const closeEv = ev({ instruction: 'ClosePosition2', signature: 'close-sig', withdrawSol: 4, blockTime: 2000 });
    const out = processPaperEvent(closeEv, leaderPos({ eventCount: 2 }), d) as NonNullable<PaperOutcome>;
    expect(paperDecisionRow(closeEv, out)).toMatchObject({
      eventKind: 'close',
      outcome: 'mirrored',
      skipReason: null,
      leaderSizeSol: 4,
      ourSizeSol: 1,
      blockTime: 2000,
    });
  });
});
