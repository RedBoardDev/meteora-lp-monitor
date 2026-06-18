import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { DlmmLeg } from '@/domain/dlmm';
import type { Database } from './database';
import { DlmmLegRepository } from './dlmm-leg-repository';
import * as schema from './schema';

async function newRepo(): Promise<DlmmLegRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new DlmmLegRepository(db as unknown as Database);
}

const leg = (over: Partial<DlmmLeg> & Pick<DlmmLeg, 'signature' | 'kind'>): DlmmLeg => ({
  blockTime: 1000,
  position: 'POS1',
  lbPair: 'POOL1',
  activeBinId: -100,
  amountX: 0n,
  amountY: 0n,
  ...over,
});

describe('DlmmLegRepository', () => {
  it('stores legs and reads them back by position with bigint amounts intact', async () => {
    const repo = await newRepo();
    await repo.replaceForSignatures(
      'w',
      ['sigA'],
      [
        leg({ signature: 'sigA', kind: 'deposit', amountX: 205945537665n, amountY: 3376692725n }),
        leg({ signature: 'sigA', kind: 'claim', amountX: 0n, amountY: 46620648n }),
      ],
    );
    const legs = await repo.legsByPosition('POS1');
    expect(legs).toHaveLength(2);
    const dep = legs.find((l) => l.kind === 'deposit')!;
    expect(dep.amountX).toBe(205945537665n); // bigint survives the text round-trip
    expect(dep.amountY).toBe(3376692725n);
  });

  it('re-ingesting a signature REPLACES its legs (idempotent — no double count)', async () => {
    const repo = await newRepo();
    await repo.replaceForSignatures(
      'w',
      ['sigA'],
      [leg({ signature: 'sigA', kind: 'deposit', amountY: 1n })],
    );
    // same signature processed again → must not accumulate.
    await repo.replaceForSignatures(
      'w',
      ['sigA'],
      [leg({ signature: 'sigA', kind: 'deposit', amountY: 1n })],
    );
    expect(await repo.legsByPosition('POS1')).toHaveLength(1);
  });

  it('replace only touches the given signatures, leaving others intact', async () => {
    const repo = await newRepo();
    await repo.replaceForSignatures('w', ['sigA'], [leg({ signature: 'sigA', kind: 'deposit' })]);
    await repo.replaceForSignatures('w', ['sigB'], [leg({ signature: 'sigB', kind: 'withdraw' })]);
    await repo.replaceForSignatures('w', ['sigA'], []); // sigA had no legs this time (e.g. a swap)
    const legs = await repo.legsByWallet('w');
    expect(legs.map((l) => l.kind)).toEqual(['withdraw']); // sigA cleared, sigB kept
  });

  it('round-trips the ingest cursor (incremental resume state)', async () => {
    const repo = await newRepo();
    expect(await repo.getCursor('w')).toBeNull();
    await repo.setCursor('w', { oldestSig: 'old', newestSig: 'new', complete: false });
    expect(await repo.getCursor('w')).toEqual({
      oldestSig: 'old',
      newestSig: 'new',
      complete: false,
    });
    await repo.setCursor('w', { oldestSig: 'older', newestSig: 'new', complete: true });
    expect(await repo.getCursor('w')).toEqual({
      oldestSig: 'older',
      newestSig: 'new',
      complete: true,
    });
  });

  it('caches pool metadata immutably and reads back only known pools', async () => {
    const repo = await newRepo();
    expect(await repo.getPoolMetas(['POOL1'])).toEqual(new Map());
    await repo.putPoolMeta('POOL1', { binStep: 100, solSide: 'Y', mintX: 'MEME', mintY: 'SOL' });
    await repo.putPoolMeta('POOL2', { binStep: 25, solSide: null, mintX: 'A', mintY: 'B' });
    await repo.putPoolMeta('POOL1', { binStep: 999, solSide: 'X', mintX: 'X', mintY: 'X' }); // immutable → no-op
    const got = await repo.getPoolMetas(['POOL1', 'POOL2', 'UNKNOWN']);
    expect(got.size).toBe(2);
    expect(got.get('POOL1')).toEqual({ binStep: 100, solSide: 'Y', mintX: 'MEME', mintY: 'SOL' });
    expect(got.get('POOL2')).toEqual({ binStep: 25, solSide: null, mintX: 'A', mintY: 'B' }); // non-SOL kept
    expect(got.has('UNKNOWN')).toBe(false);
  });
});
