import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../ttl-cache';
import type { DataSource } from '../filter';
import { resolveFilterContext } from './resolve';
import type { TokenSnapshot } from './source';

const SNAP: TokenSnapshot = {
  organicScore: 70,
  holders: 500,
  marketCapUsd: 2_000_000,
  volume24hUsd: 10_000,
  priceChange24hPercent: 5,
  firstPoolCreatedAtMs: 1_000,
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  topHoldersPercent: 10,
};

const provider = (snap: TokenSnapshot | null) => vi.fn(async () => snap);
const sources = (...s: DataSource[]) => new Set<DataSource>(s);
const newCache = () => new TtlCache<TokenSnapshot>(60_000);
const ONE_HOUR_LATER = 3_600_000 + 1_000; // nowMs so age = 1h given firstPoolCreatedAtMs=1_000

describe('resolveFilterContext — one fetch per needed source, cache-first, miss ⇒ omitted', () => {
  it('no jupiter-token source → no fetch, empty data', async () => {
    const jupiterToken = provider(SNAP);
    const data = await resolveFilterContext('MINT', sources('local'), { jupiterToken, snapshotCache: newCache() }, { nowMs: ONE_HOUR_LATER, timeoutMs: 1_000 });
    expect(data).toEqual({});
    expect(jupiterToken).not.toHaveBeenCalled();
  });

  it('jupiter-token source → fetches once and projects the snapshot', async () => {
    const data = await resolveFilterContext('MINT', sources('jupiter-token'), { jupiterToken: provider(SNAP), snapshotCache: newCache() }, { nowMs: ONE_HOUR_LATER, timeoutMs: 1_000 });
    expect(data.organicScore).toBe(70);
    expect(data.marketCapUsd).toBe(2_000_000);
    expect(data.tokenAgeHours).toBeCloseTo(1, 6);
  });

  it('null mint → empty, no fetch', async () => {
    const jupiterToken = provider(SNAP);
    expect(await resolveFilterContext(null, sources('jupiter-token'), { jupiterToken, snapshotCache: newCache() }, { nowMs: 0, timeoutMs: 1_000 })).toEqual({});
    expect(jupiterToken).not.toHaveBeenCalled();
  });

  it('provider returns null (miss) → empty data (enabled filters will skip)', async () => {
    expect(await resolveFilterContext('MINT', sources('jupiter-token'), { jupiterToken: provider(null), snapshotCache: newCache() }, { nowMs: 0, timeoutMs: 1_000 })).toEqual({});
  });

  it('cache-hit → the provider is NOT called again (pre-warm / batch reuse)', async () => {
    const cache = newCache();
    cache.set('MINT', SNAP, ONE_HOUR_LATER); // fresh as of the query time (within TTL)
    const jupiterToken = provider(SNAP);
    const data = await resolveFilterContext('MINT', sources('jupiter-token'), { jupiterToken, snapshotCache: cache }, { nowMs: ONE_HOUR_LATER, timeoutMs: 1_000 });
    expect(jupiterToken).not.toHaveBeenCalled();
    expect(data.organicScore).toBe(70);
  });

  it('a provider that REJECTS → empty data, never throws (errors must not crash the open path)', async () => {
    // WHY: a Jupiter blip must degrade to "filter data unavailable" (→ skip), never propagate an exception up the
    // open hot path. settleWithin swallows the rejection and resolves null.
    const boom = vi.fn(async () => { throw new Error('jupiter 500'); });
    const data = await resolveFilterContext('MINT', sources('jupiter-token'), { jupiterToken: boom, snapshotCache: newCache() }, { nowMs: 0, timeoutMs: 1_000 });
    expect(data).toEqual({});
    expect(boom).toHaveBeenCalledOnce();
  });

  it('a provider that hangs → null within budget (hard timeout, off the critical path)', async () => {
    vi.useFakeTimers();
    const hang = vi.fn(() => new Promise<TokenSnapshot>(() => {}));
    const promise = resolveFilterContext('MINT', sources('jupiter-token'), { jupiterToken: hang, snapshotCache: newCache() }, { nowMs: 0, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toEqual({});
    vi.useRealTimers();
  });
});
