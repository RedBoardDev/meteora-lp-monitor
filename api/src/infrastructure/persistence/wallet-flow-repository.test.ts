import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { WalletFlowRow } from '@/domain/dlmm';
import type { Database } from './database';
import * as schema from './schema';
import { WalletFlowRepository } from './wallet-flow-repository';

async function newRepo(): Promise<WalletFlowRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new WalletFlowRepository(db as unknown as Database);
}

async function newRepoWithDb(): Promise<{ repo: WalletFlowRepository; db: Database }> {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: './drizzle' });
  const db = pg as unknown as Database;
  return { repo: new WalletFlowRepository(db), db };
}

/** unix SECONDS at noon UTC of a given day (avoids any TZ edge at midnight). */
const ts = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d, 12) / 1000);

const flow = (
  signature: string,
  t: number,
  solFlow: number,
  isTrading: boolean,
): WalletFlowRow => ({
  signature,
  timestamp: t,
  type: isTrading ? 'SWAP' : 'TRANSFER',
  solFlow,
  isTrading,
});

describe('WalletFlowRepository — daily aggregation', () => {
  it('sums trading and external flows per UTC day, separately', async () => {
    const repo = await newRepo();
    await repo.upsertFlows('w1', [
      flow('a', ts(2026, 6, 1), 5, true),
      flow('b', ts(2026, 6, 1), -2, true),
      flow('c', ts(2026, 6, 2), 10, false), // external (CEX in) — not PnL
    ]);

    const daily = await repo.dailyFlows(['w1'], 0);
    expect(daily).toEqual([
      { date: '2026-06-01', trading: 3, external: 0 }, // 5 − 2
      { date: '2026-06-02', trading: 0, external: 10 },
    ]);
  });

  it('SUMS across multiple wallets — this is what makes wallet=all correct, not wallets[0]', async () => {
    const repo = await newRepo();
    await repo.upsertFlows('w1', [flow('a', ts(2026, 6, 1), 3, true)]);
    await repo.upsertFlows('w2', [flow('b', ts(2026, 6, 1), 4, true)]);

    const oneWallet = await repo.dailyFlows(['w1'], 0);
    expect(oneWallet).toEqual([{ date: '2026-06-01', trading: 3, external: 0 }]);

    const allWallets = await repo.dailyFlows(['w1', 'w2'], 0);
    expect(allWallets).toEqual([{ date: '2026-06-01', trading: 7, external: 0 }]); // 3 + 4, not 3
  });

  it('respects the sinceSec window floor', async () => {
    const repo = await newRepo();
    await repo.upsertFlows('w1', [
      flow('a', ts(2026, 6, 1), 1, true),
      flow('b', ts(2026, 6, 5), 2, true),
    ]);
    const recent = await repo.dailyFlows(['w1'], ts(2026, 6, 3));
    expect(recent).toEqual([{ date: '2026-06-05', trading: 2, external: 0 }]);
  });

  it('upsert is idempotent on (wallet, signature) — re-paging the same txs never double-counts', async () => {
    const repo = await newRepo();
    await repo.upsertFlows('w1', [flow('a', ts(2026, 6, 1), 5, true)]);
    await repo.upsertFlows('w1', [flow('a', ts(2026, 6, 1), 5, true)]); // same sig again
    const daily = await repo.dailyFlows(['w1'], 0);
    expect(daily).toEqual([{ date: '2026-06-01', trading: 5, external: 0 }]);
  });

  it('keeps the daily rollup EXACTLY equal to an authoritative rebuild from raw (incremental == truth)', async () => {
    const { repo, db } = await newRepoWithDb();
    await repo.upsertFlows('w1', [
      flow('a', ts(2026, 6, 1), 5, true),
      flow('b', ts(2026, 6, 1), -2, true),
      flow('c', ts(2026, 6, 2), 10, false),
    ]);
    await repo.upsertFlows('w2', [flow('d', ts(2026, 6, 1), 4, true)]);
    await repo.upsertFlows('w1', [flow('a', ts(2026, 6, 1), 5, true)]); // re-page (dup) — must not drift
    const incremental = await repo.dailyFlows(['w1', 'w2'], 0);

    // Wipe the rollup and rebuild it purely from the raw flows; the served curve must be identical.
    await db.delete(schema.walletFlowDaily);
    await repo.ensureDailyBackfilled();
    const rebuilt = await repo.dailyFlows(['w1', 'w2'], 0);

    expect(rebuilt).toEqual(incremental);
    expect(incremental).toEqual([
      { date: '2026-06-01', trading: 7, external: 0 }, // 5 − 2 (w1) + 4 (w2)
      { date: '2026-06-02', trading: 0, external: 10 },
    ]);
  });

  it('ensureDailyBackfilled rebuilds the FULL history even when the rollup is partially populated', async () => {
    // Regression: the old "skip if non-empty" guard left the back-history unbuilt when an incremental
    // upsert had already written today's row — the curve then showed only today. Boot must rebuild ALL.
    const { repo, db } = await newRepoWithDb();
    await repo.upsertFlows('w1', [
      flow('old', ts(2026, 6, 1), 5, true),
      flow('new', ts(2026, 6, 10), 3, true),
    ]);
    // Simulate the bug state: a rollup that's non-empty but missing the early history.
    await db.delete(schema.walletFlowDaily);
    await db.insert(schema.walletFlowDaily).values({
      wallet: 'w1',
      day: Math.floor(ts(2026, 6, 10) / 86_400),
      trading: 3,
      external: 0,
    });
    await repo.ensureDailyBackfilled(); // must NOT skip just because the rollup is non-empty
    expect(await repo.dailyFlows(['w1'], 0)).toEqual([
      { date: '2026-06-01', trading: 5, external: 0 }, // back-history restored, not just today
      { date: '2026-06-10', trading: 3, external: 0 },
    ]);
  });

  it('round-trips the ingest cursor', async () => {
    const repo = await newRepo();
    expect(await repo.getCursor('w1')).toBeNull();
    await repo.setCursor('w1', { oldestSig: 'old', newestSig: 'new', complete: false });
    expect(await repo.getCursor('w1')).toEqual({
      oldestSig: 'old',
      newestSig: 'new',
      complete: false,
    });
    await repo.setCursor('w1', { oldestSig: 'old', newestSig: 'newer', complete: true });
    expect(await repo.getCursor('w1')).toEqual({
      oldestSig: 'old',
      newestSig: 'newer',
      complete: true,
    });
  });
});
