import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { SwapFlowRow } from '@/domain/dlmm';
import type { Database } from './database';
import * as schema from './schema';
import { SwapFlowRepository } from './swap-flow-repository';

async function newRepo(): Promise<SwapFlowRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new SwapFlowRepository(db as unknown as Database);
}

const swap = (
  over: Partial<SwapFlowRow> & Pick<SwapFlowRow, 'signature' | 'side'>,
): SwapFlowRow => ({
  wallet: 'w',
  ts: 1000,
  mint: 'MINT',
  tokenAmount: 1,
  solAmount: 1,
  ...over,
});

describe('SwapFlowRepository', () => {
  // WHY: each row is an immutable FIFO input keyed by (wallet, signature, mint); re-ingesting the same
  // tx must be a no-op (ON CONFLICT DO NOTHING) so the realized-PnL walk can never double-count a leg.
  it('upsert is idempotent on (wallet, signature, mint) — re-ingest never duplicates', async () => {
    const repo = await newRepo();
    const row = swap({ signature: 'sigA', side: 'buy', tokenAmount: 5, solAmount: 2 });
    await repo.upsertMany([row]);
    await repo.upsertMany([row]); // same PK again → no second row
    expect(await repo.byWallet('w')).toEqual([row]);
  });

  // WHY: the FIFO walk consumes legs in time order, so byWallet must return them ts-ascending — NOT
  // insertion order (a backfill pages newest→oldest, so insertion order is the reverse of FIFO).
  it('byWallet returns rows ts-ordered (oldest → newest)', async () => {
    const repo = await newRepo();
    await repo.upsertMany([
      swap({ signature: 'late', side: 'sell', ts: 3000 }),
      swap({ signature: 'early', side: 'buy', ts: 1000 }),
      swap({ signature: 'mid', side: 'buy', ts: 2000 }),
    ]);
    expect((await repo.byWallet('w')).map((r) => r.signature)).toEqual(['early', 'mid', 'late']);
  });

  // WHY: one signature can swap several mints (a multi-leg tx); the mint is part of the key, so two
  // legs of the SAME tx are DISTINCT FIFO inputs and both must survive — losing one corrupts the walk.
  it('keeps distinct mints under the same signature', async () => {
    const repo = await newRepo();
    await repo.upsertMany([
      swap({ signature: 'sig', side: 'buy', mint: 'A' }),
      swap({ signature: 'sig', side: 'buy', mint: 'B' }),
    ]);
    expect((await repo.byWallet('w')).map((r) => r.mint).sort()).toEqual(['A', 'B']);
  });

  // WHY: rows are multi-tenant; byWallet must be scoped to the asked wallet and never bleed another's.
  it('byWallet is scoped to the wallet', async () => {
    const repo = await newRepo();
    await repo.upsertMany([swap({ wallet: 'w1', signature: 's1', side: 'buy' })]);
    await repo.upsertMany([swap({ wallet: 'w2', signature: 's2', side: 'sell' })]);
    expect((await repo.byWallet('w1')).map((r) => r.signature)).toEqual(['s1']);
  });

  // WHY: the cursor is the incremental-ingest resume state (page newest→genesis, top-up to newestSig);
  // it must round-trip so a restart resumes instead of re-paging the whole history.
  it('round-trips the swap-flow cursor', async () => {
    const repo = await newRepo();
    expect(await repo.getCursor('w')).toBeNull();
    await repo.setCursor('w', { oldestSig: 'old', newestSig: 'new', complete: false });
    expect(await repo.getCursor('w')).toEqual({
      oldestSig: 'old',
      newestSig: 'new',
      complete: false,
    });
    await repo.setCursor('w', { oldestSig: 'old', newestSig: 'newer', complete: true });
    expect(await repo.getCursor('w')).toEqual({
      oldestSig: 'old',
      newestSig: 'newer',
      complete: true,
    });
  });
});
