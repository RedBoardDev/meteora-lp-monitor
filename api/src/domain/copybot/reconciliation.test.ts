import { describe, expect, it } from 'vitest';
import type { PaperPosition } from './paper-position';
import { type LeaderPositionState, failsafeRow, leaderStateFromFetch, planFailsafeCloses, planReconcile } from './reconciliation';

function mirror(over: Partial<PaperPosition> = {}): PaperPosition {
  return {
    leaderPosition: 'P',
    pool: 'POOL',
    nonSolMint: 'MINT',
    nonSolSymbol: 'TOK',
    sizeSol: 1,
    status: 'open',
    openSignature: 'o',
    openedAtMs: 1,
    openedAtBlockTime: 1,
    closeSignature: null,
    closedAtBlockTime: null,
    ...over,
  };
}

describe('leaderStateFromFetch — on-chain state of the leader position', () => {
  it('account present, no error → open', () => {
    expect(leaderStateFromFetch(true, false)).toBe('open');
  });
  it('account absent, no error → closed (rent reclaimed on DLMM close)', () => {
    expect(leaderStateFromFetch(false, false)).toBe('closed');
  });
  it('RPC error → unknown, whatever the rest (we NEVER close on doubt)', () => {
    expect(leaderStateFromFetch(false, true)).toBe('unknown');
    expect(leaderStateFromFetch(true, true)).toBe('unknown');
  });
});

describe('planFailsafeCloses — sweep A (only closes the confirmed-closed)', () => {
  it('mirror whose leader position is confirmed closed → to close', () => {
    const m = mirror({ leaderPosition: 'A' });
    const state = new Map<string, LeaderPositionState>([['A', 'closed']]);
    expect(planFailsafeCloses([m], state)).toEqual([m]);
  });

  it('leader still open → leave it alone', () => {
    const state = new Map<string, LeaderPositionState>([['P', 'open']]);
    expect(planFailsafeCloses([mirror()], state)).toEqual([]);
  });

  it('unknown state (RPC error) → leave it alone (safety, the pillar)', () => {
    // WHY: closing a position wrongly would be serious — uncertainty never triggers a failsafe.
    const state = new Map<string, LeaderPositionState>([['P', 'unknown']]);
    expect(planFailsafeCloses([mirror()], state)).toEqual([]);
  });

  it('position absent from the map → leave it alone (treated as uncertain)', () => {
    expect(planFailsafeCloses([mirror()], new Map())).toEqual([]);
  });

  it('generic: works on the brain Mirror type (any object carrying leaderPosition)', () => {
    const mirrors = [
      { leaderPosition: 'A', ourPosition: 'oA', sizeSol: 1 },
      { leaderPosition: 'B', ourPosition: 'oB', sizeSol: 1 },
    ];
    const state = new Map<string, LeaderPositionState>([
      ['A', 'closed'],
      ['B', 'open'],
    ]);
    expect(planFailsafeCloses(mirrors, state)).toEqual([{ leaderPosition: 'A', ourPosition: 'oA', sizeSol: 1 }]);
  });

  it('mix: returns ONLY the confirmed-closed', () => {
    const a = mirror({ leaderPosition: 'A' });
    const b = mirror({ leaderPosition: 'B' });
    const c = mirror({ leaderPosition: 'C' });
    const state = new Map<string, LeaderPositionState>([
      ['A', 'closed'],
      ['B', 'open'],
      ['C', 'unknown'],
    ]);
    expect(planFailsafeCloses([a, b, c], state)).toEqual([a]);
  });
});

describe('planReconcile — airtight on-chain reconciliation (anti-dormant)', () => {
  it('our position DIRECTLY confirmed gone (ourClosed) → markClosed', () => {
    const plan = planReconcile({
      ourOnChain: new Set(),
      ourClosed: new Set(['o1']),
      tracked: [{ ourPosition: 'o1', leaderPosition: 'l1' }],
      leaderClosed: new Set(),
    });
    expect(plan.markClosed).toEqual(['o1']);
    expect(plan.reClose).toEqual([]);
  });

  it('REGRESSION: enumerator LAGS (absent from ourOnChain) but direct read says present (not in ourClosed) → NO close (active)', () => {
    // WHY: markClosed must depend on a DIRECT getAccountInfo(ourPosition)===null, never on the laggy
    // getAllLbPairPositionsByUser enumerator. A transient enumerator gap must never forget a LIVE mirror.
    const plan = planReconcile({
      ourOnChain: new Set(), // enumerator didn't list it (lag/glitch)
      ourClosed: new Set(), // but the per-account read says it's still there
      tracked: [{ ourPosition: 'o1', leaderPosition: 'l1' }],
      leaderClosed: new Set(),
    });
    expect(plan).toEqual({ markClosed: [], reClose: [], orphans: [] });
  });

  it('ours present + leader closed → reClose (retry the failed close)', () => {
    const plan = planReconcile({
      ourOnChain: new Set(['o1']),
      ourClosed: new Set(),
      tracked: [{ ourPosition: 'o1', leaderPosition: 'l1' }],
      leaderClosed: new Set(['l1']),
    });
    expect(plan.reClose).toEqual([{ ourPosition: 'o1', leaderPosition: 'l1' }]);
    expect(plan.markClosed).toEqual([]);
  });

  it('ours present + leader OPEN → nothing (active mirror)', () => {
    const plan = planReconcile({
      ourOnChain: new Set(['o1']),
      ourClosed: new Set(),
      tracked: [{ ourPosition: 'o1', leaderPosition: 'l1' }],
      leaderClosed: new Set(),
    });
    expect(plan).toEqual({ markClosed: [], reClose: [], orphans: [] });
  });

  it('on-chain (enumerator) position not tracked → orphan', () => {
    const plan = planReconcile({ ourOnChain: new Set(['oX']), ourClosed: new Set(), tracked: [], leaderClosed: new Set() });
    expect(plan.orphans).toEqual(['oX']);
  });

  it('mix: confirms a close (direct), retries a failed close, ignores an active one, flags an orphan', () => {
    const plan = planReconcile({
      ourOnChain: new Set(['oActive', 'oFailed', 'oOrphan']),
      ourClosed: new Set(['oClosed']), // directly confirmed gone
      tracked: [
        { ourPosition: 'oClosed', leaderPosition: 'lC' },
        { ourPosition: 'oActive', leaderPosition: 'lA' },
        { ourPosition: 'oFailed', leaderPosition: 'lF' },
      ],
      leaderClosed: new Set(['lC', 'lF']),
    });
    expect(plan.markClosed).toEqual(['oClosed']);
    expect(plan.reClose).toEqual([{ ourPosition: 'oFailed', leaderPosition: 'lF' }]);
    expect(plan.orphans).toEqual(['oOrphan']);
  });
});

describe('planReconcile — open-grace (anti false-close of a fresh open: the dormant-bug regression)', () => {
  const tracked = [{ ourPosition: 'oFresh', leaderPosition: 'lFresh' }];

  it('REGRESSION: fresh open whose account reads as gone right after landing → NO markClosed, NO orphan', () => {
    // WHY: a reconcile firing ~1s after an open read the not-yet-confirmed position as "gone" → markClosed →
    // forgot the mirror → DORMANT. The grace makes us conclude NOTHING (even over a direct null) until trustworthy.
    const plan = planReconcile({
      ourOnChain: new Set(),
      ourClosed: new Set(['oFresh']), // direct read may transiently be null right after the open
      tracked,
      leaderClosed: new Set(),
      recentlyOpened: new Set(['oFresh']),
    });
    expect(plan).toEqual({ markClosed: [], reClose: [], orphans: [] });
  });

  it('fresh open + even if the leader also reads as closed (both lagging) → still NO action', () => {
    const plan = planReconcile({
      ourOnChain: new Set(),
      ourClosed: new Set(['oFresh']),
      tracked,
      leaderClosed: new Set(['lFresh']),
      recentlyOpened: new Set(['oFresh']),
    });
    expect(plan).toEqual({ markClosed: [], reClose: [], orphans: [] });
  });

  it('fresh open already visible on-chain → NOT an orphan, no action', () => {
    const plan = planReconcile({
      ourOnChain: new Set(['oFresh']),
      ourClosed: new Set(),
      tracked,
      leaderClosed: new Set(),
      recentlyOpened: new Set(['oFresh']),
    });
    expect(plan).toEqual({ markClosed: [], reClose: [], orphans: [] });
  });

  it('NON-fresh mirror directly confirmed gone → still markClosed (grace protects only the recently opened)', () => {
    const plan = planReconcile({
      ourOnChain: new Set(),
      ourClosed: new Set(['oOld']),
      tracked: [{ ourPosition: 'oOld', leaderPosition: 'lOld' }],
      leaderClosed: new Set(),
      recentlyOpened: new Set(['oFresh']), // a DIFFERENT, fresh position
    });
    expect(plan.markClosed).toEqual(['oOld']);
  });
});

describe('planReconcile — rug-exit-pending re-close (a failed rug-SL close must be retried until gone)', () => {
  const tracked = [{ ourPosition: 'oRug', leaderPosition: 'lRug' }];

  it('MONEY-CRITICAL: rug-SL-closed mirror, ours STILL on-chain, leader NOT closed → reClose (retry the failed close)', () => {
    // WHY: rug-SL is OUR independent crash exit — the leader keeps holding, so `leaderClosed` never fires. Without
    // rugExitPending the mirror falls into "active" and a failed rug-SL close stays dormant in the rugging pool.
    // This test FAILS against the old signature/logic (no rugExitPending → reClose empty).
    const plan = planReconcile({
      ourOnChain: new Set(['oRug']),
      ourClosed: new Set(),
      tracked,
      leaderClosed: new Set(),
      rugExitPending: new Set(['oRug']),
    });
    expect(plan.reClose).toEqual([{ ourPosition: 'oRug', leaderPosition: 'lRug' }]);
    expect(plan.markClosed).toEqual([]);
  });

  it('same rug-exit-pending mirror once ours is CONFIRMED gone → markClosed, NOT reClose (gone wins over pending)', () => {
    const plan = planReconcile({
      ourOnChain: new Set(),
      ourClosed: new Set(['oRug']), // direct getAccountInfo null → close landed
      tracked,
      leaderClosed: new Set(),
      rugExitPending: new Set(['oRug']),
    });
    expect(plan.markClosed).toEqual(['oRug']);
    expect(plan.reClose).toEqual([]);
  });

  it('NOT rug-exit-pending, leader open, ours on-chain → neither (unchanged active-mirror behavior)', () => {
    const plan = planReconcile({
      ourOnChain: new Set(['oRug']),
      ourClosed: new Set(),
      tracked,
      leaderClosed: new Set(),
      rugExitPending: new Set(),
    });
    expect(plan).toEqual({ markClosed: [], reClose: [], orphans: [] });
  });

  it('rug-exit-pending but within open-grace → NO action (open-grace still wins, anti false-close of a fresh open)', () => {
    const plan = planReconcile({
      ourOnChain: new Set(['oRug']),
      ourClosed: new Set(),
      tracked,
      leaderClosed: new Set(),
      rugExitPending: new Set(['oRug']),
      recentlyOpened: new Set(['oRug']),
    });
    expect(plan).toEqual({ markClosed: [], reClose: [], orphans: [] });
  });
});

describe('failsafeRow — shadow-log row of a failsafe close', () => {
  it('idempotent synthetic signature + outcome failsafe_close + mirror size', () => {
    const m = mirror({ leaderPosition: 'XYZ', sizeSol: 0.7 });
    expect(failsafeRow(m)).toEqual({
      signature: 'failsafe:XYZ',
      pool: 'POOL',
      position: 'XYZ',
      eventKind: 'close',
      outcome: 'failsafe_close',
      skipReason: null,
      leaderSizeSol: 0,
      ourSizeSol: 0.7,
      blockTime: null,
    });
  });

  it('empty pool → null (defensive branch)', () => {
    expect(failsafeRow(mirror({ pool: '' })).pool).toBeNull();
  });
});
