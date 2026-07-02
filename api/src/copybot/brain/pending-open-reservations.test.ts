import { describe, expect, it } from 'vitest';
import { createPendingOpenReservations } from './pending-open-reservations';

const TTL = 90_000;

describe('PendingOpenReservations — TTL-bounded duplicate-open reservation', () => {
  it('reserve → isPending true; clear → isPending false', () => {
    let now = 1_000;
    const r = createPendingOpenReservations(TTL, () => now);
    expect(r.isPending('P')).toBe(false);
    r.reserve('P');
    expect(r.isPending('P')).toBe(true); // open in flight → a follow-up add is treated as tracked (no 2nd open)
    r.clear('P');
    expect(r.isPending('P')).toBe(false); // registry.open ran → reservation lifted
  });

  it('a stale reservation self-heals after the TTL (isPending false and the entry is dropped)', () => {
    let now = 0;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('P');
    now = TTL - 1;
    expect(r.isPending('P')).toBe(true); // still within the multi-tx open window
    expect(r.size()).toBe(1);
    now = TTL; // >= TTL → stale
    expect(r.isPending('P')).toBe(false); // self-heal: a leaked reservation never blocks re-open beyond the TTL
    expect(r.size()).toBe(0); // lazily deleted
  });

  it('reservations are per-position (one position pending never suppresses another)', () => {
    let now = 5;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('A');
    expect(r.isPending('A')).toBe(true);
    expect(r.isPending('B')).toBe(false);
  });

  it('re-reserving refreshes the timestamp (extends the window)', () => {
    let now = 0;
    const r = createPendingOpenReservations(TTL, () => now);
    r.reserve('P');
    now = TTL - 1;
    r.reserve('P'); // refresh at TTL-1
    now = TTL; // only 1ms past the refresh → still live
    expect(r.isPending('P')).toBe(true);
    now = TTL - 1 + TTL;
    expect(r.isPending('P')).toBe(false);
  });
});
