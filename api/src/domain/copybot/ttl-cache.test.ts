import { describe, expect, it } from 'vitest';
import { TtlCache } from './ttl-cache';

describe('TtlCache — cache with injected clock', () => {
  it('set then get BEFORE expiration → the value', () => {
    const c = new TtlCache<number>(100);
    c.set('k', 7, 0);
    expect(c.get('k', 50)).toBe(7);
  });

  it('get AT expiration (now == expiresAt) → undefined', () => {
    const c = new TtlCache<number>(100);
    c.set('k', 7, 0);
    expect(c.get('k', 100)).toBeUndefined();
  });

  it('get AFTER expiration → undefined (and the entry is purged)', () => {
    const c = new TtlCache<number>(100);
    c.set('k', 7, 0);
    expect(c.get('k', 150)).toBeUndefined();
    // after purge, even a "valid" clock returns nothing.
    expect(c.get('k', 151)).toBeUndefined();
  });

  it('unknown key → undefined', () => {
    expect(new TtlCache<number>(100).get('absent', 0)).toBeUndefined();
  });

  it('set overwrites the value AND pushes back the expiration', () => {
    const c = new TtlCache<number>(100);
    c.set('k', 1, 0);
    c.set('k', 2, 60); // new expiration = 160
    expect(c.get('k', 150)).toBe(2);
    expect(c.get('k', 160)).toBeUndefined();
  });
});
