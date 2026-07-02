import type { ClosedPosition, OpenPosition } from '@binsight/shared';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, vi } from 'vitest';
import { repairClosedEconomicsFromLegs } from '@/application/repair-closed-economics';
import type { DlmmLeg } from '@/domain/dlmm';
import type { Database } from './database';
import { DlmmLegRepository } from './dlmm-leg-repository';
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

const openBase: Omit<OpenPosition, 'positionAddress'> = {
  wallet: 'w',
  poolAddress: 'p',
  tokenX: 'MEME',
  tokenY: 'SOL',
  tokenXMint: 'mint',
  strategy: null,
  sizeSol: 10,
  pnlSol: 0,
  pnlPctSol: 0,
  claimedFeesSol: 0,
  unclaimedFeesSol: 0,
  rangeStatus: 'in',
  minPrice: 0,
  maxPrice: 0,
  poolPrice: null,
  outOfRangeSince: null,
  openedAt: 5,
  updatedAt: 5,
};

// Fresh in-memory Postgres (PGlite) per test, with the real Drizzle migrations applied.
async function newDb(): Promise<Database> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db as unknown as Database;
}
async function newRepo(): Promise<PostgresPositionRepository> {
  return new PostgresPositionRepository(await newDb());
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

  it('setAuthoritativePnlMany writes market_pnl_sol for many positions in one statement (O04/R13)', async () => {
    const repo = await newRepo();
    const closedAt = Date.now() - 300_000; // past the settle/freeze window
    await repo.upsertClosed([
      { ...base, positionAddress: 'M1', closedAt, pnlSol: -0.01, pnlSource: 'pool' },
      { ...base, positionAddress: 'M2', closedAt, pnlSol: -0.02, pnlSource: 'pool' },
    ]);
    await repo.setAuthoritativePnlMany(
      new Map([
        ['M1', 1.5],
        ['M2', -3.25],
      ]),
    );
    const rows = (await repo.getClosed(['w'], { page: 1, pageSize: 10 })).rows;
    const byAddr = new Map(rows.map((r) => [r.positionAddress, r.pnlSol]));
    expect(byAddr.get('M1')).toBeCloseTo(1.5);
    expect(byAddr.get('M2')).toBeCloseTo(-3.25);
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

  it('addressesMissingStrategy lists unresolved positions (open ones first) and drops them once set', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([
      { ...base, positionAddress: 'M1', pnlSol: 0, pnlSource: 'pool' },
      { ...base, positionAddress: 'M2', pnlSol: 0, pnlSource: 'pool' },
    ]);
    // An OPEN position missing its strategy must be backfilled too — and prioritised, since it drives
    // the live card/badge. (Regression guard: the query used to be closed-only.)
    await repo.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'O1' }]);
    const missing = await repo.addressesMissingStrategy(10);
    expect(missing[0]).toBe('O1'); // open first
    expect(missing.slice(1).sort()).toEqual(['M1', 'M2']);
    await repo.setStrategy('O1', 'Spot');
    expect((await repo.addressesMissingStrategy(10)).sort()).toEqual(['M1', 'M2']);
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

  it('buckets todayPnl by UTC midnight, not the server-local day (regression: R08)', async () => {
    // Only observable on a non-UTC host: with server-LOCAL midnight, a close that is "yesterday" in
    // UTC but still after the local midnight of a behind-UTC zone wrongly folds into Today. Pin the
    // TZ + the clock so the assertion can actually fail if the boundary regresses to setHours().
    const repo = await newRepo();
    const origTz = process.env.TZ;
    process.env.TZ = 'America/New_York'; // UTC−4 in June
    vi.useFakeTimers({ toFake: ['Date'] }); // fake Date only — leave PGlite's real timers alone
    vi.setSystemTime(new Date('2025-06-15T03:00:00Z')); // 23:00 on Jun 14 local (NY)
    try {
      await repo.upsertClosed([
        // Jun 15 01:00 UTC — genuinely "today" (UTC).
        {
          ...base,
          positionAddress: 'TDY',
          pnlSol: 2,
          closedAt: Date.parse('2025-06-15T01:00:00Z'),
          pnlSource: 'pool',
        },
        // Jun 14 12:00 UTC — "yesterday" (UTC), but after local-NY midnight of Jun 14.
        {
          ...base,
          positionAddress: 'YST',
          pnlSol: 9,
          closedAt: Date.parse('2025-06-14T12:00:00Z'),
          pnlSource: 'pool',
        },
      ]);
      const s = await repo.statsAggregate(['w'], 0);
      expect(s.todayPnlSol).toBeCloseTo(2); // the local-midnight bug would yield 11 (folds YST in)
    } finally {
      vi.useRealTimers();
      if (origTz === undefined) delete process.env.TZ;
      else process.env.TZ = origTz;
    }
  });

  it('excludes break-even closes (PnL exactly 0) from winRate and the loss count (R20)', async () => {
    const repo = await newRepo();
    await repo.upsertClosed([
      { ...base, positionAddress: 'W1', pnlSol: 2, closedAt: DAY, pnlSource: 'pool' }, // win
      { ...base, positionAddress: 'L1', pnlSol: -1, closedAt: DAY, pnlSource: 'pool' }, // loss
      { ...base, positionAddress: 'B1', pnlSol: 0, closedAt: DAY, pnlSource: 'pool' }, // break-even
    ]);
    const s = await repo.statsAggregate(['w'], 0);
    expect(s.closedCount).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1); // break-even is NOT a loss (the old closedCount−wins would say 2)
    expect(s.winRate).toBeCloseTo(50); // 1 / (1 win + 1 loss); old code diluted it to 1/3 ≈ 33%
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

const SOL = 1_000_000_000; // lamports per SOL
const dlmmLeg = (over: Partial<DlmmLeg> & Pick<DlmmLeg, 'position' | 'kind'>): DlmmLeg => ({
  signature: 'sig',
  blockTime: 1,
  lbPair: 'POOL',
  activeBinId: 0, // binStep 10, binId 0 → price 1 → a SOL-Y leg values at its Y (SOL) amount
  amountX: 0n,
  amountY: 0n,
  ...over,
});

describe('PostgresPositionRepository — legs-recompute backfill (#113)', () => {
  it('repairClosedEconomicsMany rewrites the four columns even AFTER the settle-freeze, closed rows only', async () => {
    const repo = await newRepo();
    const closedAt = Date.now() - 300_000; // well past SETTLE_MS → upsertClosed would refuse to re-mark
    await repo.upsertClosed([
      { ...base, positionAddress: 'FZ', closedAt, depositSol: 0, withdrawSol: 0, pnlSol: 5, pnlSource: 'pool' },
    ]);
    await repo.setAuthoritativePnl('FZ', -0.42); // a market reprice that must be preserved
    await repo.replaceOpenForWallet('w', [{ ...openBase, positionAddress: 'OPEN', pnlSol: 7 }]);

    await repo.repairClosedEconomicsMany(
      new Map([
        ['FZ', { depositSol: 3, withdrawSol: 2, claimedFeesSol: 0.5, pnlSol: -0.5 }],
        ['OPEN', { depositSol: 9, withdrawSol: 9, claimedFeesSol: 9, pnlSol: 9 }], // must be ignored (open)
      ]),
    );

    const econ = await repo.closedEconomicsForWallet('w');
    expect(econ.get('FZ')).toEqual({ depositSol: 3, withdrawSol: 2, claimedFeesSol: 0.5, pnlSol: -0.5 });
    expect(econ.has('OPEN')).toBe(false); // open positions are not closed economics
    const closed = await repo.getClosedByAddress('FZ');
    expect(closed?.pnlSol).toBeCloseTo(-0.42); // market_pnl_sol (effective PnL) untouched by the repair
    // The open row's raw pnl must be unchanged by the map entry that targeted it.
    expect((await repo.getOpen('w')).find((p) => p.positionAddress === 'OPEN')?.pnlSol).toBeCloseTo(7);
  });

  it('end-to-end: a stale deposit_sol=0 closed row is corrected from its legs; a correct row is idempotent', async () => {
    const db = await newDb();
    const repo = new PostgresPositionRepository(db);
    const legRepo = new DlmmLegRepository(db);
    await legRepo.putPoolMeta('POOL', { binStep: 10, solSide: 'Y', mintX: 'MEME', mintY: 'So1' });

    // Frozen closed row written before the fix: deposit dropped to 0, pnl bogus-positive.
    const closedAt = Date.now() - 300_000;
    await repo.upsertClosed([
      { ...base, positionAddress: 'P', poolAddress: 'POOL', closedAt, depositSol: 0, withdrawSol: 0, pnlSol: 4, pnlSource: 'pool' },
    ]);
    // Its real on-chain SOL legs: deposit 3 SOL, withdraw 2 SOL, claim 0.5 SOL → pnl −0.5.
    await legRepo.replaceForSignatures('w', ['sig'], [
      dlmmLeg({ position: 'P', kind: 'deposit', amountY: BigInt(3 * SOL) }),
      dlmmLeg({ position: 'P', kind: 'withdraw', amountY: BigInt(2 * SOL) }),
      dlmmLeg({ position: 'P', kind: 'claim', amountY: BigInt(0.5 * SOL) }),
    ]);

    const r1 = await repairClosedEconomicsFromLegs('w', { legRepo, positionRepo: repo });
    expect(r1).toMatchObject({ scanned: 1, corrected: 1, skippedNoPoolMeta: 0, skippedNonSol: 0 });
    const econ = (await repo.closedEconomicsForWallet('w')).get('P')!;
    expect(econ.depositSol).toBeCloseTo(3);
    expect(econ.withdrawSol).toBeCloseTo(2);
    expect(econ.claimedFeesSol).toBeCloseTo(0.5);
    expect(econ.pnlSol).toBeCloseTo(-0.5);

    // Second pass: everything already exact → nothing rewritten (idempotent).
    const r2 = await repairClosedEconomicsFromLegs('w', { legRepo, positionRepo: repo });
    expect(r2.corrected).toBe(0);
  });
});
