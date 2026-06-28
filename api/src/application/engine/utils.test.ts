import { describe, expect, it } from 'vitest';
import {
  chunked,
  shouldRefreshOpenSnapshot,
  shouldRefreshRealized,
  symmetricDiffSize,
} from './utils';

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

describe('shouldRefreshOpenSnapshot — slow periodic EXACT read so unclaimed fees stay current', () => {
  const INTERVAL = 60_000; // mirrors SYNC_INTERVAL_MS (engine/index.ts)
  const ok = {
    hasOpen: true,
    reconciled: true,
    snapshotting: false,
    lastSyncAt: 0,
    now: INTERVAL,
    intervalMs: INTERVAL,
  };

  it('fires once an open-position wallet is interval-stale (drives the fee/size refresh)', () => {
    // WHY: the 10s price-mark only re-prices frozen amounts — without this exact read, a quiet open
    // position's unclaimed fees stay pinned at ≈0 from open until the next on-chain event.
    expect(shouldRefreshOpenSnapshot(ok)).toBe(true);
  });

  it('never fires for a wallet with NO open positions (the near-zero guarantee: idle = 0 RPC)', () => {
    expect(shouldRefreshOpenSnapshot({ ...ok, hasOpen: false })).toBe(false);
  });

  it('does not fire before reconciliation (never read before the first backfill seeds the open set)', () => {
    expect(shouldRefreshOpenSnapshot({ ...ok, reconciled: false })).toBe(false);
  });

  it('does not fire while a snapshot is already in flight (no stacking / re-entrancy)', () => {
    expect(shouldRefreshOpenSnapshot({ ...ok, snapshotting: true })).toBe(false);
  });

  it('throttles: does not fire again until a full interval since the last sync', () => {
    expect(shouldRefreshOpenSnapshot({ ...ok, now: INTERVAL - 1 })).toBe(false);
  });

  it('fires exactly at the interval boundary (same clock+threshold as the persist gate)', () => {
    expect(shouldRefreshOpenSnapshot({ ...ok, lastSyncAt: 1_000, now: 1_000 + INTERVAL })).toBe(true);
  });
});

describe('symmetricDiffSize — count of keys present in exactly one set', () => {
  it('counts additions AND removals (both directions)', () => {
    expect(symmetricDiffSize(new Set(['a', 'b']), new Set(['b', 'c']))).toBe(2); // a removed, c added
  });
  it('identical sets → 0 (no change → no re-trigger)', () => {
    expect(symmetricDiffSize(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(0);
  });
  it('one empty set → the size of the other (all added or all removed)', () => {
    expect(symmetricDiffSize(new Set<string>(), new Set(['a', 'b', 'c']))).toBe(3);
    expect(symmetricDiffSize(new Set(['x']), new Set<string>())).toBe(1);
  });
});

describe('chunked — bounded-concurrency batch processing (RPC politeness)', () => {
  it('processes EVERY item and preserves input order', async () => {
    const out = await chunked([1, 2, 3, 4, 5, 6, 7], async (n) => n * 2); // > one chunk (5) → spans batches
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]); // all 7, in order, across the chunk boundary
  });
  it('runs fn exactly once per item', async () => {
    const seen: number[] = [];
    await chunked([1, 2, 3], async (n) => {
      seen.push(n);
      return n;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
  it('an empty input never calls fn and returns []', async () => {
    let calls = 0;
    const out = await chunked([], async (n: number) => {
      calls++;
      return n;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
