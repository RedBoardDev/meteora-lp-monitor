import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { SwapFlowRow } from '@/domain/dlmm';
import type { EnhancedTxGateway } from '@/domain/ports';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { SwapFlowRepository } from '@/infrastructure/persistence/swap-flow-repository';
import { SwapFlowIngest } from './swap-flow-ingest';

const noopLogger = { info: () => {}, warn: () => {} } as unknown as Logger;

// Real repo over an in-memory Postgres (PGlite) — NO network — so the (wallet,signature,mint) PK dedup
// that makes re-ingesting a tx a no-op is exercised for real, not mocked away.
async function newRepo(): Promise<SwapFlowRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new SwapFlowRepository(db as unknown as Database);
}

const swap = (signature: string, side: SwapFlowRow['side'], ts = 1000): SwapFlowRow => ({
  wallet: 'w',
  signature,
  ts,
  mint: 'MINT',
  tokenAmount: 1,
  solAmount: 1,
  side,
});

type PageOpts = {
  untilSig?: string | null;
  startBefore?: string | null;
  onPage: (rows: SwapFlowRow[]) => Promise<void>;
};

type PageResult = {
  rows: SwapFlowRow[];
  complete: boolean;
  hitKnownTop?: boolean;
  newestSig: string | null;
  oldestSig: string | null;
  /** Enhanced HTTP pages the gateway actually fetched (0 = nothing new ⇒ the anti-re-seed signal). */
  pagesFetched: number;
  /** Persist the page, then throw — models a crash AFTER onPage but BEFORE the cursor is advanced. */
  crash?: boolean;
};

/**
 * Fake EnhancedTxGateway driven by a per-call script. Mirrors the real pageSwaps contract: hand the
 * page to onPage (so the real repo persists it), then report `added` + boundaries. `pages` accumulates
 * the Enhanced pages fetched so a test can assert ZERO were fetched (anti-re-seed).
 */
function fakeGateway(scripts: Array<(o: PageOpts) => PageResult>) {
  let call = 0;
  const pages = { fetched: 0 };
  const pageSwaps = vi.fn(async (_w: string, o: PageOpts) => {
    const r = (scripts[call++] ?? scripts[scripts.length - 1]!)(o);
    pages.fetched += r.pagesFetched;
    await o.onPage(r.rows); // persist first — like the real pager, which writes each page before returning
    if (r.crash) throw new Error('simulated crash before setCursor');
    return {
      added: r.rows.length,
      complete: r.complete,
      hitKnownTop: r.hitKnownTop ?? false,
      newestSig: r.newestSig,
      oldestSig: r.oldestSig,
    };
  });
  return {
    pages,
    gw: { enabled: true, pageSwaps } as unknown as EnhancedTxGateway & {
      pageSwaps: ReturnType<typeof vi.fn>;
    },
  };
}

const sigs = async (repo: SwapFlowRepository) =>
  (await repo.byWallet('w')).map((r) => r.signature).sort();

describe('SwapFlowIngest — incremental SWAP persistence (anti-re-seed of the realized history)', () => {
  it('seed: no cursor → pages full history, persists every swap, marks cursor complete', async () => {
    const repo = await newRepo();
    const { gw, pages } = fakeGateway([
      () => ({
        rows: [swap('s1', 'sell', 2000), swap('s2', 'buy', 1000)],
        complete: true,
        newestSig: 's1',
        oldestSig: 's2',
        pagesFetched: 1,
      }),
    ]);
    const res = await new SwapFlowIngest(gw, repo, noopLogger).ingest('w');

    // seed mode = full backfill (untilSig null, no resume offset).
    expect(gw.pageSwaps).toHaveBeenCalledWith('w', {
      untilSig: null,
      startBefore: null,
      onPage: expect.any(Function),
    });
    expect(await sigs(repo)).toEqual(['s1', 's2']); // every decoded swap persisted
    expect(await repo.getCursor('w')).toEqual({ newestSig: 's1', oldestSig: 's2', complete: true });
    expect(res).toEqual({ added: 2, complete: true });
    expect(pages.fetched).toBe(1);
  });

  it('top-up: complete cursor → fetches only sigs newer than untilSig (stops at the known top)', async () => {
    const repo = await newRepo();
    await repo.upsertMany([swap('old-top', 'sell')]);
    await repo.setCursor('w', { newestSig: 'old-top', oldestSig: 'genesis', complete: true });
    // The gateway stops at the known top, so it returns ONLY the genuinely new leg — never re-serves old-top.
    const { gw } = fakeGateway([
      () => ({
        rows: [swap('new1', 'buy')],
        complete: false,
        hitKnownTop: true,
        newestSig: 'new1',
        oldestSig: 'old-top',
        pagesFetched: 1,
      }),
    ]);
    await new SwapFlowIngest(gw, repo, noopLogger).ingest('w');

    expect(gw.pageSwaps).toHaveBeenCalledWith('w', {
      untilSig: 'old-top', // top-up boundary = the previously-ingested top
      startBefore: null,
      onPage: expect.any(Function),
    });
    expect(await sigs(repo)).toEqual(['new1', 'old-top']); // only the newer sig was added
    expect(await repo.getCursor('w')).toEqual({
      newestSig: 'new1', // advances to the fresh top
      oldestSig: 'genesis', // genesis preserved, not clobbered by the top-up
      complete: true,
    });
  });

  it('crash after persisting a page but before the cursor advances → re-page re-upserts idempotently (no duplicate rows)', async () => {
    const repo = await newRepo();
    // call 1 persists the page then crashes (cursor stays null); call 2 re-seeds the SAME rows.
    const { gw } = fakeGateway([
      () => ({
        rows: [swap('s1', 'sell', 2000), swap('s2', 'buy', 1000)],
        complete: true,
        newestSig: 's1',
        oldestSig: 's2',
        pagesFetched: 1,
        crash: true,
      }),
      () => ({
        rows: [swap('s1', 'sell', 2000), swap('s2', 'buy', 1000)],
        complete: true,
        newestSig: 's1',
        oldestSig: 's2',
        pagesFetched: 1,
      }),
    ]);
    const ingest = new SwapFlowIngest(gw, repo, noopLogger);

    await expect(ingest.ingest('w')).rejects.toThrow(/crash/); // crash mid-run
    expect(await sigs(repo)).toEqual(['s1', 's2']); // the persisted page survives the crash
    expect(await repo.getCursor('w')).toBeNull(); // cursor never advanced

    await ingest.ingest('w'); // restart re-pages from the top and re-upserts the same txs
    expect(await sigs(repo)).toEqual(['s1', 's2']); // PK dedup ⇒ still exactly 2 rows, no duplicates
    expect(await repo.getCursor('w')).toEqual({ newestSig: 's1', oldestSig: 's2', complete: true });
  });

  it('anti-re-seed: a complete cursor with no new sigs performs ZERO Enhanced pages (never re-seeds)', async () => {
    const repo = await newRepo();
    await repo.upsertMany([swap('top', 'sell'), swap('genesis', 'buy')]);
    await repo.setCursor('w', { newestSig: 'top', oldestSig: 'genesis', complete: true });
    // Nothing new past the known top ⇒ the gateway fetches NO history pages and returns no legs.
    const { gw, pages } = fakeGateway([
      () => ({
        rows: [],
        complete: false,
        hitKnownTop: true,
        newestSig: 'top',
        oldestSig: 'top',
        pagesFetched: 0,
      }),
    ]);
    const res = await new SwapFlowIngest(gw, repo, noopLogger).ingest('w');

    // top-up mode (untilSig set), NOT a re-seed (which would be untilSig: null) — the whole point.
    expect(gw.pageSwaps).toHaveBeenCalledWith('w', {
      untilSig: 'top',
      startBefore: null,
      onPage: expect.any(Function),
    });
    expect(pages.fetched).toBe(0); // ZERO Enhanced pages — the history is never re-paged
    expect(res).toEqual({ added: 0, complete: true });
    expect(await sigs(repo)).toEqual(['genesis', 'top']); // unchanged
    expect(await repo.getCursor('w')).toEqual({
      newestSig: 'top',
      oldestSig: 'genesis',
      complete: true,
    });
  });

  it('does nothing when the Enhanced API is disabled (no api key)', async () => {
    const repo = await newRepo();
    const gw = { enabled: false, pageSwaps: vi.fn() } as unknown as EnhancedTxGateway & {
      pageSwaps: ReturnType<typeof vi.fn>;
    };
    const res = await new SwapFlowIngest(gw, repo, noopLogger).ingest('w');
    expect(gw.pageSwaps).not.toHaveBeenCalled();
    expect(await repo.byWallet('w')).toEqual([]);
    expect(res).toEqual({ added: 0, complete: false });
  });
});
