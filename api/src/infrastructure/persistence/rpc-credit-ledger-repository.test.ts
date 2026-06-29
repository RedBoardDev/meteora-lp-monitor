import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from './database';
import { RpcCreditLedgerRepository } from './rpc-credit-ledger-repository';
import * as schema from './schema';

const MS_PER_DAY = 86_400_000;

/** A repo on a fixed clock so the since() window is deterministic regardless of the real date. */
async function newRepoAt(now: number): Promise<RpcCreditLedgerRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new RpcCreditLedgerRepository(db as unknown as Database, () => now);
}

describe('RpcCreditLedgerRepository', () => {
  // WHY: the 60s flush carries only DELTAS, so two flushes of the same (day,method,wallet,codePath)
  // bucket must SUM (ON CONFLICT += ), not overwrite — otherwise the persisted spend would under-count.
  it('addDeltas accumulates on conflict (two batches of the same key sum)', async () => {
    const repo = await newRepoAt(0);
    await repo.addDeltas([
      { day: 0, method: 'getAccountInfo', wallet: 'A', codePath: 'ingest', calls: 2, credits: 2 },
    ]);
    await repo.addDeltas([
      { day: 0, method: 'getAccountInfo', wallet: 'A', codePath: 'ingest', calls: 3, credits: 3 },
    ]);
    expect(await repo.since(1)).toEqual([
      { day: 0, method: 'getAccountInfo', wallet: 'A', codePath: 'ingest', calls: 5, credits: 5 },
    ]);
  });

  // WHY: the bucket key is the full 4-tuple (the table PK); a different wallet/method/codePath is a
  // distinct bucket and must NOT merge — the panel attributes spend per subsystem and tenant.
  it('keeps distinct (day,method,wallet,codePath) buckets separate', async () => {
    const repo = await newRepoAt(0);
    await repo.addDeltas([
      { day: 0, method: 'getAccountInfo', wallet: 'A', codePath: 'ingest', calls: 1, credits: 1 },
      { day: 0, method: 'getAccountInfo', wallet: 'B', codePath: 'ingest', calls: 1, credits: 1 },
      { day: 0, method: 'enhancedTx', wallet: 'A', codePath: 'realized', calls: 1, credits: 100 },
    ]);
    expect(await repo.since(1)).toHaveLength(3);
  });

  // WHY: /debug/rpc shows only recent spend; since(daysBack) must include today AND the boundary day
  // (today-daysBack+1) yet exclude anything older — so the panel window is exact, not off-by-one.
  it('since(daysBack) windows on the most-recent N days inclusive of today', async () => {
    const today = 10; // a clock whose UTC-day index is 10
    const repo = await newRepoAt(today * MS_PER_DAY);
    const mk = (day: number) => ({
      day,
      method: 'm',
      wallet: '',
      codePath: 'p',
      calls: 1,
      credits: 1,
    });
    await repo.addDeltas([mk(today), mk(today - 6), mk(today - 7)]); // boundary in, one day older out
    const days = (await repo.since(7)).map((r) => r.day);
    expect(days).toEqual([today, today - 6]); // newest first; today-7 excluded
  });
});
