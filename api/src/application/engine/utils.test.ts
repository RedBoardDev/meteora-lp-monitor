import { describe, expect, it } from 'vitest';
import { shouldRefreshRealized } from './utils';

// Mirrors the production schedule (engine/index.ts) so the WHY is encoded against real values:
// front-loaded offsets after a close — Helius indexes parsed txs in ~1-2s, so the bottleneck is the
// close→sell delay, not indexing.
const OFFSETS = [25_000, 60_000, 150_000];
const base = { offsetsMs: OFFSETS };

describe('shouldRefreshRealized — front-loaded post-close realized-PnL refresh', () => {
  it('never refreshes a wallet that has not closed anything (no stale value to converge)', () => {
    expect(
      shouldRefreshRealized({ now: 1_000_000, lastCloseAt: 0, lastRealizedRunAt: 0, ...base }),
    ).toBe(false);
  });

  it('does not fire before the first offset (avoids a useless pass while the sell is still pending)', () => {
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + OFFSETS[0]! - 1, // just before 25s — sell/indexing chain not settled yet
        lastCloseAt: close,
        lastRealizedRunAt: close, // close-time pass counts as offset 0
        ...base,
      }),
    ).toBe(false);
  });

  it('fires the FIRST refresh as soon as the first offset is reached (~25s, not minutes)', () => {
    // WHY the redesign: a fixed 2-min interval made the user stare at the stale -0.11 far too long;
    // indexing is ~1-2s, so converge fast.
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + OFFSETS[0]!,
        lastCloseAt: close,
        lastRealizedRunAt: close,
        ...base,
      }),
    ).toBe(true);
  });

  it('does not double-fire the same checkpoint (throttle: a pass already ran at this offset)', () => {
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + OFFSETS[0]! + 1_000, // 1s after the first pass ran
        lastCloseAt: close,
        lastRealizedRunAt: close + OFFSETS[0]!, // first checkpoint already consumed
        ...base,
      }),
    ).toBe(false);
  });

  it('fires the next checkpoint once its offset is reached', () => {
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + OFFSETS[1]!,
        lastCloseAt: close,
        lastRealizedRunAt: close + OFFSETS[0]!, // first done, second now due
        ...base,
      }),
    ).toBe(true);
  });

  it('stops after the last offset (bounded cost — no indefinite Helius re-fetch)', () => {
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + OFFSETS[2]! + 600_000, // long past the last checkpoint
        lastCloseAt: close,
        lastRealizedRunAt: close + OFFSETS[2]!, // all checkpoints consumed
        ...base,
      }),
    ).toBe(false);
  });

  it('catches up multiple missed checkpoints in one fire (snapshot cadence slower than offsets)', () => {
    // If the snapshot loop was busy, several offsets may have elapsed since the last pass — one fire is
    // enough to converge (computeForWallet uses the latest data regardless of how many we skipped).
    const close = 1_000_000;
    expect(
      shouldRefreshRealized({
        now: close + OFFSETS[2]!, // 150s in, but only the close-time pass has run
        lastCloseAt: close,
        lastRealizedRunAt: close,
        ...base,
      }),
    ).toBe(true);
  });
});
