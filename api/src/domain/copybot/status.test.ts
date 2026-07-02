import { describe, expect, it } from 'vitest';
import {
  type BrainStatusDetail,
  DETECTION_STALE_FAILURES,
  HEARTBEAT_STALE_MS,
  detectionHealthy,
  isOnline,
  shouldAlertDetectionStale,
} from './status';

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

  it('is unchanged by the detection-liveness fields — freshness alone drives online/offline', () => {
    // WHY: detection-stale is a SEPARATE signal; a stale detector must NOT flip the heartbeat online/offline
    // (that would double-count and could mask the real "process alive but blind" condition the alert exists for).
    expect(isOnline(now - 5_000, now)).toBe(true);
    expect(isOnline(now - (HEARTBEAT_STALE_MS + 1), now)).toBe(false);
  });
});

describe('status · BrainStatusDetail detection-liveness fields', () => {
  // WHY: the web reads this jsonb blob; the new fields must be present on a fresh snapshot AND the shape must stay
  // backward-compatible (optional) so an older persisted row without them still type-checks and renders.
  it('carries wsConnected / lastPollAt / lastReconcileAt / pollFailures / reconcileFailures', () => {
    const detail: BrainStatusDetail = {
      leader: 'L',
      openPositions: 0,
      exposureSol: 0,
      lastActionAt: null,
      lastLatencyMs: null,
      wsConnected: true,
      lastPollAt: 123,
      lastReconcileAt: 456,
      pollFailures: 0,
      reconcileFailures: 0,
    };
    expect(detail.wsConnected).toBe(true);
    expect(detail.lastPollAt).toBe(123);
    expect(detail.lastReconcileAt).toBe(456);
    expect(detail.pollFailures).toBe(0);
    expect(detail.reconcileFailures).toBe(0);
  });

  it('the new fields are optional (a legacy row without them is still a valid detail)', () => {
    const legacy: BrainStatusDetail = { leader: 'L', openPositions: 1, exposureSol: 2, lastActionAt: 1, lastLatencyMs: 2 };
    expect(legacy.wsConnected).toBeUndefined();
    expect(legacy.pollFailures).toBeUndefined();
  });
});

describe('status · detectionHealthy', () => {
  it('is healthy only when BOTH consecutive-failure counters are zero', () => {
    expect(detectionHealthy(0, 0)).toBe(true);
    expect(detectionHealthy(1, 0)).toBe(false);
    expect(detectionHealthy(0, 1)).toBe(false);
    expect(detectionHealthy(3, 3)).toBe(false);
  });
});

describe('status · shouldAlertDetectionStale', () => {
  const T = DETECTION_STALE_FAILURES;

  it('does NOT alert below the threshold', () => {
    // WHY: a single transient poll blip must not page the operator — only a persistent (N-in-a-row) outage does.
    expect(shouldAlertDetectionStale(T - 1, 0, false)).toBe(false);
    expect(shouldAlertDetectionStale(0, T - 1, false)).toBe(false);
  });

  it('alerts once EITHER loop reaches the threshold', () => {
    expect(shouldAlertDetectionStale(T, 0, false)).toBe(true); // poll blind
    expect(shouldAlertDetectionStale(0, T, false)).toBe(true); // reconcile blind (missed-close backstop down)
  });

  it('gates to ONCE per stale episode (already-alerted suppresses the repeat)', () => {
    // WHY: emitting the pinned alert every tick would flood the operator channel; the flag is the episode gate.
    expect(shouldAlertDetectionStale(T + 5, T + 5, true)).toBe(false);
  });

  it('re-arms after recovery: alerted flag cleared once healthy → a fresh outage alerts again', () => {
    // Episode 1: crosses threshold, alerts, flag set.
    expect(shouldAlertDetectionStale(T, 0, false)).toBe(true);
    // Recovery zeroes the counter → caller clears the flag via detectionHealthy.
    expect(detectionHealthy(0, 0)).toBe(true);
    // Episode 2: a new outage with the flag cleared alerts again (no missed episode).
    expect(shouldAlertDetectionStale(T, 0, false)).toBe(true);
  });

  it('honors a custom threshold', () => {
    expect(shouldAlertDetectionStale(2, 0, false, 2)).toBe(true);
    expect(shouldAlertDetectionStale(1, 0, false, 2)).toBe(false);
  });
});
