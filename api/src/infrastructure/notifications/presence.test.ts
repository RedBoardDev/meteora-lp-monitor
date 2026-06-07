import { describe, expect, it } from 'vitest';
import { PresenceTracker } from './presence';

describe('PresenceTracker', () => {
  it('is inactive until a client reports active', () => {
    const p = new PresenceTracker(30_000);
    expect(p.isAnyClientActive()).toBe(false);
    p.heartbeat('mac', true);
    expect(p.isAnyClientActive()).toBe(true);
  });

  it('explicit inactive flips immediately (sleep/lock/background)', () => {
    const p = new PresenceTracker(30_000);
    p.heartbeat('ios', true);
    expect(p.isAnyClientActive()).toBe(true);
    p.heartbeat('ios', false);
    expect(p.isAnyClientActive()).toBe(false);
  });

  it('any device counts as active (one asleep, one foreground)', () => {
    const p = new PresenceTracker(30_000);
    p.heartbeat('mac', false);
    p.heartbeat('ios', true);
    expect(p.isAnyClientActive()).toBe(true);
  });

  it('ages out after the timeout when heartbeats stop', () => {
    const p = new PresenceTracker(0); // everything is immediately stale
    p.heartbeat('mac', true);
    expect(p.isAnyClientActive()).toBe(false);
  });

  it('activeDevices lists only currently-active devices (drives native-vs-Bark routing)', () => {
    const p = new PresenceTracker(30_000);
    p.heartbeat('mac', false); // e.g. Mac with notifications muted → reports inactive
    p.heartbeat('ios', true);
    expect(p.activeDevices()).toEqual(['ios']);
    p.heartbeat('ios', false); // iOS app closed too → nothing active → routing falls to Bark
    expect(p.activeDevices()).toEqual([]);
  });
});
