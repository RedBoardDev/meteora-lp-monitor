import type { ClosedPosition } from '@binsight/shared';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from './database';
import { PostgresPositionRepository } from './position-repository';
import * as schema from './schema';

const base: Omit<ClosedPosition, 'positionAddress' | 'pnlSol' | 'pnlSource'> = {
  wallet: 'w',
  poolAddress: 'p',
  tokenX: 'MEME',
  tokenY: 'SOL',
  tokenXMint: 'mint',
  strategy: null,
  pnlPctSol: 0,
  feesSol: 0,
  depositSol: 10,
  withdrawSol: 9,
  openedAt: 1,
  closedAt: 2,
  durationSeconds: 1,
};

// Fresh in-memory Postgres (PGlite) per test, with the real Drizzle migrations applied.
async function newRepo(): Promise<PostgresPositionRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new PostgresPositionRepository(db as unknown as Database);
}

const read = async (repo: PostgresPositionRepository) =>
  (await repo.getClosed(['w'], { page: 1, pageSize: 10 })).rows[0]!;

describe('PostgresPositionRepository — closed PnL', () => {
  it('keeps the market reprice (residual @ market) when a later pool-price resync re-upserts', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([
      { ...base, positionAddress: 'A', pnlSol: -0.19, pnlSource: 'market' },
    ]);
    expect((await read(repo)).pnlSol).toBeCloseTo(-0.19);
    await repo.upsertClosed([{ ...base, positionAddress: 'A', pnlSol: -0.01, pnlSource: 'pool' }]);
    expect((await read(repo)).pnlSol).toBeCloseTo(-0.19); // market value survives the pool-mark resync
    expect((await read(repo)).pnlSource).toBe('market');
  });

  it('falls back to the pool mark when never repriced', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([{ ...base, positionAddress: 'B', pnlSol: -0.028, pnlSource: 'pool' }]);
    expect((await read(repo)).pnlSol).toBeCloseTo(-0.028);
    expect((await read(repo)).pnlSource).toBe('pool');
  });

  it('derives pnlPctSol in percent points (not a fraction) so colour thresholds read it', async () => {
    const repo = await newRepo();
    // +0.0946 SOL on a 5 SOL deposit = +1.89%, which must clear a 0.5% green threshold.
    await repo.upsertClosed([
      { ...base, positionAddress: 'E', depositSol: 5, pnlSol: 0.0946, pnlSource: 'pool' },
    ]);
    expect((await read(repo)).pnlPctSol).toBeCloseTo(1.892, 2);
  });

  it('setAuthoritativePnl (LPAgent) overrides even after freeze, and survives a later resync', async () => {
    const repo = await newRepo();
    const closedAt = Date.now() - 300_000; // past the settle/freeze window
    await repo.upsertClosed([
      { ...base, positionAddress: 'F', closedAt, pnlSol: -0.01, pnlSource: 'pool' },
    ]);
    await repo.setAuthoritativePnl('F', -0.19174); // LPAgent's market-valued PnL
    expect((await read(repo)).pnlSol).toBeCloseTo(-0.19174);
    // The 90s pool-price resync must not clobber the LPAgent value.
    await repo.upsertClosed([
      { ...base, positionAddress: 'F', closedAt, pnlSol: -0.02, pnlSource: 'pool' },
    ]);
    expect((await read(repo)).pnlSol).toBeCloseTo(-0.19174);
  });
});

describe('PostgresPositionRepository — strategy', () => {
  it('persists strategy and exposes it via getStrategies and on closed reads', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([{ ...base, positionAddress: 'S', pnlSol: 0.1, pnlSource: 'pool' }]);
    expect((await repo.getStrategies()).size).toBe(0); // unresolved positions are not returned
    await repo.setStrategy('S', 'BidAsk');
    expect((await repo.getStrategies()).get('S')).toBe('BidAsk');
    expect((await read(repo)).strategy).toBe('BidAsk'); // travels onto the closed read
  });

  it('addressesMissingStrategy lists unresolved closed positions and drops them once set', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([
      { ...base, positionAddress: 'M1', pnlSol: 0, pnlSource: 'pool' },
      { ...base, positionAddress: 'M2', pnlSol: 0, pnlSource: 'pool' },
    ]);
    expect((await repo.addressesMissingStrategy(10)).sort()).toEqual(['M1', 'M2']);
    await repo.setStrategy('M1', 'Spot');
    expect(await repo.addressesMissingStrategy(10)).toEqual(['M2']);
  });
});

describe('PostgresPositionRepository — close PnL freeze', () => {
  it('still refines the figures while the close is settling (within the window)', async () => {
    const repo = await newRepo();
    const closedAt = Date.now(); // just closed — Meteora indexer may still be settling
    // Provisional capture right after close (the inflated value that wrongly alerted the user).
    await repo.upsertClosed([
      { ...base, positionAddress: 'C', closedAt, pnlSol: 0.06, pnlSource: 'pool' },
    ]);
    // A resync moments later carries the settled figure — must overwrite while still in-window.
    await repo.upsertClosed([
      { ...base, positionAddress: 'C', closedAt, pnlSol: -0.0146, pnlSource: 'pool' },
    ]);
    expect((await read(repo)).pnlSol).toBeCloseTo(-0.0146);
  });

  it('freezes the figures once the close has settled — a later resync cannot drift them', async () => {
    const repo = await newRepo();
    const closedAt = Date.now() - 200_000; // closed well beyond the settle window
    await repo.upsertClosed([
      { ...base, positionAddress: 'D', closedAt, pnlSol: -0.0146, pnlSource: 'pool' },
    ]);
    // The periodic resync re-marks an already-settled close — this must be ignored.
    await repo.upsertClosed([
      { ...base, positionAddress: 'D', closedAt, pnlSol: 0.06, feesSol: 0.06, pnlSource: 'pool' },
    ]);
    expect((await read(repo)).pnlSol).toBeCloseTo(-0.0146);
    expect((await read(repo)).feesSol).toBeCloseTo(0);
  });
});

describe('PostgresPositionRepository — large backfill', () => {
  it('chunks inserts so a multi-thousand-row history backfill (over the PG bind-param limit) lands', async () => {
    const repo = await newRepo();
    // 4000 rows × ~19 columns = ~76k bind params > Postgres' 65535 limit — a single insert would
    // fail (this is the bug that truncated a real wallet's history to one surviving small batch).
    const big = Array.from({ length: 4000 }, (_, i) => ({
      ...base,
      positionAddress: `BIG${i}`,
      pnlSol: 0,
      pnlSource: 'pool' as const,
    }));
    await repo.upsertClosed(big);
    const { total } = await repo.getClosed(['w'], { page: 1, pageSize: 1 });
    expect(total).toBe(4000);
  });
});

const DAY = 86_400_000;

describe('PostgresPositionRepository — statsAggregate (SQL, no row transfer)', () => {
  it('aggregates scalars + byPair in SQL', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([
      {
        ...base,
        positionAddress: 'A',
        pnlSol: 2,
        feesSol: 0.1,
        depositSol: 10,
        durationSeconds: 100,
        closedAt: DAY,
        tokenX: 'AAA',
        pnlSource: 'pool',
      },
      {
        ...base,
        positionAddress: 'B',
        pnlSol: -1,
        feesSol: 0.2,
        depositSol: 20,
        durationSeconds: 300,
        closedAt: 2 * DAY,
        tokenX: 'AAA',
        pnlSource: 'pool',
      },
      {
        ...base,
        positionAddress: 'C',
        pnlSol: 5,
        feesSol: 0,
        depositSol: 5,
        durationSeconds: 200,
        closedAt: 3 * DAY,
        tokenX: 'BBB',
        pnlSource: 'pool',
      },
    ]);
    const s = await repo.statsAggregate(['w'], 0);
    expect(s.closedCount).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo((2 / 3) * 100, 6);
    expect(s.totalPnlSol).toBeCloseTo(6);
    expect(s.totalFeesSol).toBeCloseTo(0.3);
    expect(s.totalVolumeSol).toBeCloseTo(35);
    expect(s.avgInvestedSol).toBeCloseTo(35 / 3);
    expect(s.expectedValueSol).toBeCloseTo(2);
    expect(s.avgDurationSeconds).toBeCloseTo(200);
    // best→worst by pnl: BBB/SOL (+5, 1) then AAA/SOL (+2−1=+1, 2)
    expect(s.byPair).toEqual([
      { pair: 'BBB/SOL', pnlSol: 5, count: 1 },
      { pair: 'AAA/SOL', pnlSol: 1, count: 2 },
    ]);
  });

  it('windows by sinceMs (closed_at >= since)', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([
      { ...base, positionAddress: 'X', pnlSol: 1, closedAt: DAY, pnlSource: 'pool' },
      { ...base, positionAddress: 'Y', pnlSol: 10, closedAt: 5 * DAY, pnlSource: 'pool' },
    ]);
    const s = await repo.statsAggregate(['w'], 5 * DAY);
    expect(s.closedCount).toBe(1);
    expect(s.totalPnlSol).toBeCloseTo(10);
  });

  it('is empty for no wallets and for a wallet with no closes', async () => {
    const repo = await newRepo();
    expect((await repo.statsAggregate([], 0)).closedCount).toBe(0);
    expect((await repo.statsAggregate(['w'], 0)).closedCount).toBe(0);
  });
});

describe('PostgresPositionRepository — profitBuckets (SQL GROUP BY)', () => {
  it('groups realized pnl by floored bucket, ascending', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([
      { ...base, positionAddress: 'A', pnlSol: 2, closedAt: DAY + 1, pnlSource: 'pool' },
      { ...base, positionAddress: 'B', pnlSol: 3, closedAt: DAY + 5, pnlSource: 'pool' },
      { ...base, positionAddress: 'C', pnlSol: -1, closedAt: 3 * DAY, pnlSource: 'pool' },
    ]);
    const buckets = await repo.profitBuckets(['w'], DAY);
    expect(buckets).toEqual([
      { t: DAY, realized: 5 },
      { t: 3 * DAY, realized: -1 },
    ]);
  });
});
