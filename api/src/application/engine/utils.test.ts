import { describe, expect, it } from 'vitest';
import { shouldRefreshRealized } from './utils';

// Mirrors the production tunables (engine/index.ts) so the WHY is encoded against real values.
const WINDOW_MS = 600_000; // 10 min indexing-lag window after a close
const INTERVAL_MS = 120_000; // ≥ 2 min between refresh passes
const base = { windowMs: WINDOW_MS, intervalMs: INTERVAL_MS };

describe('shouldRefreshRealized — bounded post-close realized-PnL refresh', () => {
  it('never refreshes a wallet that has not closed anything (no stale value to converge)', () => {
    // WHY: the refresh only exists to converge a freshly-closed position's residual value. With no
    // close, re-fetching Helius on every snapshot tick would be pure waste.
    expect(
      shouldRefreshRealized({ now: 1_000_000, lastCloseAt: 0, lastRealizedRunAt: 0, ...base }),
    ).toBe(false);
  });

  it('refreshes once the interval has elapsed within the post-close window', () => {
    // WHY: this is the whole point — keep recomputing so the residual's REAL sale value (once Helius
    // indexes the swap) replaces the stale pool-spot mark without waiting for the next close.
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + INTERVAL_MS, // exactly one interval since the close-time pass
        lastCloseAt: close,
        lastRealizedRunAt: close,
        ...base,
      }),
    ).toBe(true);
  });

  it('throttles to one pass per interval (no Helius re-fetch every tick)', () => {
    // WHY: snapshots tick far faster than the interval; without throttling a viewed wallet would hammer
    // the Enhanced API for the entire window.
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + INTERVAL_MS - 1, // just under one interval since the last pass
        lastCloseAt: close,
        lastRealizedRunAt: close,
        ...base,
      }),
    ).toBe(false);
  });

  it('stops refreshing once the window has elapsed (bounded cost — indexing assumed settled)', () => {
    // WHY: the lag is seconds-to-minutes; past the window we must stop or a quiet-but-viewed wallet
    // re-fetches Helius forever.
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + WINDOW_MS + 1, // just past the window
        lastCloseAt: close,
        lastRealizedRunAt: 0, // interval long elapsed, yet still must not fire
        ...base,
      }),
    ).toBe(false);
  });

  it('still fires on the last tick inside the window when the interval has elapsed', () => {
    // Boundary: now - lastCloseAt == windowMs is INSIDE the window (strict >), so the interval gate
    // decides — guards against an off-by-one that would drop the final convergence pass.
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + WINDOW_MS,
        lastCloseAt: close,
        lastRealizedRunAt: close,
        ...base,
      }),
    ).toBe(true);
  });
});
