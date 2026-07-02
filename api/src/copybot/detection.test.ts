import type { Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { makeDetectionDeps } from './detection';

// detection.ts is the I/O adapter feeding the no-miss LeaderDetector. The logic that MATTERS here is the no-miss
// completeness of signature ingestion: cold-start is bounded (no full-wallet replay); a poll does a COMPLETE
// contiguous sweep of everything newer than the cursor (paginating with `before`), drops only failed txs, and —
// crucially — THROWS rather than silently truncating if it can't reach the cursor within the page cap (fail-loud,
// so a missed leader event surfaces instead of hiding). These tests exercise that with a fake Connection.

const PK = { toBase58: () => 'LEADER' } as unknown as PublicKey;

/** Build deps with a fake Connection that serves `getSignaturesForAddress` from a scripted page function. */
function depsWithSignatures(pageFn: (opts: { limit?: number; until?: string; before?: string }) => Array<{ signature: string; err: unknown }>) {
  const getSignaturesForAddress = vi.fn(async (_pk: PublicKey, opts: { limit?: number; until?: string; before?: string }) => pageFn(opts));
  const conn = { getSignaturesForAddress } as unknown as Connection;
  const deps = makeDetectionDeps({
    conn,
    pk: PK,
    poolReader: {} as never,
    tokenMeta: {} as never,
    onEvent: () => undefined,
  });
  return { deps, getSignaturesForAddress };
}

describe('makeDetectionDeps.listSignaturesSince — no-miss signature ingestion', () => {
  it('cold start (no cursor) → a BOUNDED recent page, failed txs dropped (no full-wallet replay)', async () => {
    const { deps, getSignaturesForAddress } = depsWithSignatures((opts) => {
      expect(opts.until).toBeUndefined(); // cold start passes a limit, not a cursor
      expect(opts.limit).toBeGreaterThan(0); // bounded
      return [
        { signature: 'a', err: null },
        { signature: 'bad', err: { InstructionError: [] } }, // a failed tx must NOT be ingested
        { signature: 'b', err: null },
      ];
    });
    const out = await deps.listSignaturesSince(undefined);
    expect(out.map((s) => s.signature)).toEqual(['a', 'b']);
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1); // cold start = a single bounded page
  });

  it('poll → COMPLETE multi-page sweep newer than the cursor, advancing `before` until a short page', async () => {
    // Page 1 = a full 1000-sig page (forces a second fetch); page 2 = short → done. Proves it does not stop at the
    // first page (a single-page poll would MISS everything older in the same poll window).
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ signature: `p1-${i}`, err: null }));
    const calls: Array<{ until?: string; before?: string }> = [];
    const { deps, getSignaturesForAddress } = depsWithSignatures((opts) => {
      calls.push({ until: opts.until, before: opts.before });
      if (opts.before === undefined) return fullPage; // first page
      return [{ signature: 'p2-0', err: null }]; // second page (short) → loop ends
    });
    const out = await deps.listSignaturesSince('CURSOR');
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(2); // paginated past the first full page
    expect(calls[0]?.until).toBe('CURSOR'); // every page is bounded BELOW by the cursor (contiguous, no gap)
    expect(calls[1]?.until).toBe('CURSOR');
    expect(calls[1]?.before).toBe('p1-999'); // advanced by the last sig of page 1
    expect(out).toHaveLength(1001);
    expect(out.at(-1)?.signature).toBe('p2-0');
  });

  it('poll → drops failed txs across pages (only successful txs are copied)', async () => {
    const { deps } = depsWithSignatures(() => [
      { signature: 'ok1', err: null },
      { signature: 'fail', err: 'BlockhashNotFound' },
      { signature: 'ok2', err: null },
    ]); // single short page
    const out = await deps.listSignaturesSince('CURSOR');
    expect(out.map((s) => s.signature)).toEqual(['ok1', 'ok2']);
  });

  it('poll → THROWS (fail-loud) instead of silently truncating when the cursor is unreachable within the page cap', async () => {
    // Always return a FULL page → the cursor is never reached → the page cap trips. A no-miss guardrail must
    // surface this (retry next poll), never return a partial set that looks complete.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ signature: `s-${i}`, err: null }));
    let n = 0;
    const { deps } = depsWithSignatures(() => {
      n++;
      return fullPage.map((s) => ({ signature: `${s.signature}-${n}`, err: null })); // unique each page → before always advances
    });
    await expect(deps.listSignaturesSince('CURSOR')).rejects.toThrow(/page/i);
  });
});

describe('makeDetectionDeps.classify — null-tx refetch (WS outruns RPC availability)', () => {
  it('refetches ONLY still-null slots and stops early once everything resolves (no wasted refetch)', async () => {
    // First fetch: both null (WS beat the read replica). Refetch: both resolve to non-DLMM txs (no events, but the
    // null-refetch loop must run then stop). We assert the refetch happened and then stopped (≤ initial + 1).
    let call = 0;
    const getParsedTransactions = vi.fn(async (sigs: string[]) => {
      call++;
      return call === 1 ? sigs.map(() => null) : sigs.map(() => ({ blockTime: 1, meta: { innerInstructions: [] }, transaction: { signatures: ['x'], message: { instructions: [] } } }));
    });
    const conn = { getParsedTransactions } as unknown as Connection;
    const deps = makeDetectionDeps({ conn, pk: PK, poolReader: {} as never, tokenMeta: { resolve: async () => new Map() } as never, onEvent: () => undefined });
    const { events, unresolved } = await deps.classify(['s1', 's2']);
    expect(events.size).toBe(0); // non-DLMM txs → no events (we're testing the refetch mechanics, not event building)
    expect(unresolved.size).toBe(0); // both slots resolved on the refetch → nothing left unresolved
    expect(getParsedTransactions).toHaveBeenCalledTimes(2); // 1 initial + 1 refetch (then no nulls → stop)
    expect(getParsedTransactions.mock.calls[1]?.[0]).toEqual(['s1', 's2']); // refetched the previously-null slots
  });

  it('a slot STILL null after every retry is reported UNRESOLVED (never mislabeled as a resolved non-DLMM tx)', async () => {
    // WHY: unresolved ≠ non-DLMM. If a permanently-null tx (RPC not caught up) were dropped as "resolved non-DLMM",
    // the detector would commit the cursor past it and MISS the event forever. It MUST come back in `unresolved`.
    const getParsedTransactions = vi.fn(async (sigs: string[]) => sigs.map(() => null));
    const conn = { getParsedTransactions } as unknown as Connection;
    const deps = makeDetectionDeps({ conn, pk: PK, poolReader: {} as never, tokenMeta: { resolve: async () => new Map() } as never, onEvent: () => undefined });
    const { events, unresolved } = await deps.classify(['s1']);
    expect(events.size).toBe(0);
    expect([...unresolved]).toEqual(['s1']); // the null-forever sig surfaces as unresolved → detector holds the cursor
  });

  it('no refetch when the first fetch already resolves every slot', async () => {
    const getParsedTransactions = vi.fn(async (sigs: string[]) => sigs.map(() => ({ blockTime: 1, meta: { innerInstructions: [] }, transaction: { signatures: ['x'], message: { instructions: [] } } })));
    const conn = { getParsedTransactions } as unknown as Connection;
    const deps = makeDetectionDeps({ conn, pk: PK, poolReader: {} as never, tokenMeta: { resolve: async () => new Map() } as never, onEvent: () => undefined });
    const { unresolved } = await deps.classify(['s1']);
    expect(unresolved.size).toBe(0); // resolved on the first fetch → nothing unresolved
    expect(getParsedTransactions).toHaveBeenCalledTimes(1); // nothing null → no refetch
  });
});
