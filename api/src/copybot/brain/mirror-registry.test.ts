import { describe, expect, it } from 'vitest';
import { type Mirror, MirrorRegistry } from './mirror-registry';

const m = (over: Partial<Omit<Mirror, 'status'>> = {}): Omit<Mirror, 'status'> => ({
  leaderPosition: 'L',
  ourPosition: 'O',
  pool: 'POOL',
  nonSolSymbol: 'TOK',
  sizeSol: 1,
  lowerBin: -45,
  upperBin: -42,
  openedAt: 1,
  ...over,
});

describe('MirrorRegistry', () => {
  it('open registers an open mirror (with OUR position + range)', () => {
    const r = new MirrorRegistry();
    expect(r.open(m())).toMatchObject({ leaderPosition: 'L', ourPosition: 'O', status: 'open', lowerBin: -45 });
    expect(r.hasOpen('L')).toBe(true);
  });

  it('open idempotent: 2nd open of the same leader position → returns the existing one', () => {
    const r = new MirrorRegistry();
    const a = r.open(m({ sizeSol: 1 }));
    const b = r.open(m({ sizeSol: 999 }));
    expect(b).toBe(a);
    expect(r.get('L')?.sizeSol).toBe(1);
  });

  it('close closes the held mirror + returns it; openPositions no longer lists it', () => {
    const r = new MirrorRegistry();
    r.open(m());
    expect(r.close('L')?.status).toBe('closed');
    expect(r.hasOpen('L')).toBe(false);
    expect(r.openPositions()).toHaveLength(0);
  });

  it('getByOurPosition: reverse lookup by our pubkey (any status), undefined if none', () => {
    const r = new MirrorRegistry();
    r.open(m({ leaderPosition: 'L', ourPosition: 'OUR1' }));
    expect(r.getByOurPosition('OUR1')?.leaderPosition).toBe('L');
    r.close('L');
    expect(r.getByOurPosition('OUR1')?.status).toBe('closed'); // still found after close
    expect(r.getByOurPosition('nope')).toBeUndefined();
  });

  it('close of a position we do not hold → undefined (no-op)', () => {
    expect(new MirrorRegistry().close('inconnue')).toBeUndefined();
  });

  it('double close → 2nd = no-op', () => {
    const r = new MirrorRegistry();
    r.open(m());
    expect(r.close('L')).toBeDefined();
    expect(r.close('L')).toBeUndefined();
  });

  it('independent positions; openPositions returns only the open ones', () => {
    const r = new MirrorRegistry();
    r.open(m({ leaderPosition: 'A' }));
    r.open(m({ leaderPosition: 'B' }));
    r.close('B');
    expect(r.openPositions().map((x) => x.leaderPosition)).toEqual(['A']);
  });
});
