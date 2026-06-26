import { describe, expect, it } from 'vitest';
import { HEARTBEAT_STALE_MS, isOnline } from './status';

describe('status · isOnline', () => {
  const now = 1_000_000;

  it('a recent beat is online', () => {
    expect(isOnline(now - 5_000, now)).toBe(true);
  });

  it('a beat older than the stale window is offline (a crashed process goes dark on its own)', () => {
    // WHY: online MUST be derived from staleness, not a stored flag — a crashed process can never set itself false.
    expect(isOnline(now - (HEARTBEAT_STALE_MS + 1), now)).toBe(false);
  });

  it('the stale boundary is inclusive so the edge does not flap', () => {
    expect(isOnline(now - HEARTBEAT_STALE_MS, now)).toBe(true);
    expect(isOnline(now - HEARTBEAT_STALE_MS - 1, now)).toBe(false);
  });

  it('never-beat (null) is offline', () => {
    expect(isOnline(null, now)).toBe(false);
  });

  it('honors a custom stale window', () => {
    expect(isOnline(now - 2_000, now, 1_000)).toBe(false);
    expect(isOnline(now - 500, now, 1_000)).toBe(true);
  });
});
