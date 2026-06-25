import { describe, expect, it } from 'vitest';
import { PaperPositionLedger } from './paper-position';

const openArgs = (over: Partial<Parameters<PaperPositionLedger['openMirror']>[0]> = {}) => ({
  leaderPosition: 'P',
  pool: 'POOL',
  nonSolMint: 'MINT',
  nonSolSymbol: 'TOK',
  sizeSol: 1,
  openSignature: 'open-sig',
  blockTime: 1000,
  openedAtMs: 1000,
  ...over,
});

describe('PaperPositionLedger — state of the paper mirrors we hold', () => {
  it('openMirror records an open mirror with its size and its open signature', () => {
    const l = new PaperPositionLedger();
    const p = l.openMirror(openArgs({ sizeSol: 0.5 }));
    expect(p).toMatchObject({
      leaderPosition: 'P',
      pool: 'POOL',
      nonSolSymbol: 'TOK',
      sizeSol: 0.5,
      status: 'open',
      openSignature: 'open-sig',
      openedAtBlockTime: 1000,
      closeSignature: null,
      closedAtBlockTime: null,
    });
    expect(l.openPositions()).toHaveLength(1);
  });

  it('closeMirror closes the mirror we hold and returns the closed position', () => {
    const l = new PaperPositionLedger();
    l.openMirror(openArgs());
    const closed = l.closeMirror('P', 'close-sig', 2000);
    expect(closed).toMatchObject({ status: 'closed', closeSignature: 'close-sig', closedAtBlockTime: 2000 });
    expect(l.openPositions()).toHaveLength(0);
    expect(l.get('P')?.status).toBe('closed');
  });

  it('closeMirror on a position we DON’T hold → undefined (no-op)', () => {
    // WHY: a skipped open (non-SOL / below floor) creates no mirror → its close must trigger nothing.
    const l = new PaperPositionLedger();
    expect(l.closeMirror('inconnue', 'close-sig', 2000)).toBeUndefined();
  });

  it('double closeMirror → the 2nd is a no-op (undefined), no re-close', () => {
    // WHY: avoid logging a close twice (mirror-close idempotence).
    const l = new PaperPositionLedger();
    l.openMirror(openArgs());
    expect(l.closeMirror('P', 'c1', 2000)).toBeDefined();
    expect(l.closeMirror('P', 'c2', 3000)).toBeUndefined();
    expect(l.get('P')?.closeSignature).toBe('c1'); // the 1st close is authoritative
  });

  it('openMirror twice for the same open position → idempotent (returns the existing one, no duplicate)', () => {
    const l = new PaperPositionLedger();
    const a = l.openMirror(openArgs({ sizeSol: 1 }));
    const b = l.openMirror(openArgs({ sizeSol: 999 })); // 2nd open ignored
    expect(b).toBe(a);
    expect(l.get('P')?.sizeSol).toBe(1);
    expect(l.openPositions()).toHaveLength(1);
  });

  it('positions independent per leader position; openPositions returns only the open ones', () => {
    const l = new PaperPositionLedger();
    l.openMirror(openArgs({ leaderPosition: 'A' }));
    l.openMirror(openArgs({ leaderPosition: 'B' }));
    l.closeMirror('B', 'c', 2000);
    expect(l.openPositions().map((p) => p.leaderPosition)).toEqual(['A']);
    expect(l.get('B')?.status).toBe('closed');
  });

  it('get on an unknown key → undefined', () => {
    expect(new PaperPositionLedger().get('nope')).toBeUndefined();
  });
});
