import type {
  ClosedPosition,
  OpenPosition,
  RangeStatus,
  Stats,
  StrategyFamily,
} from '@binsight/shared';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { PoolRef, PositionRepository } from '@/domain/ports';
import { toFiniteNumber as n } from '@/util/number';
import type { Database } from './database';
import { positions as positionsTable } from './schema';

// A close stays mutable for this long after closed_at so the Meteora indexer can settle the
// withdrawal/fees figures; after that the financials are frozen and the periodic resync no
// longer re-marks them. Must stay LARGER than the engine's CLOSE_SETTLE_MS (which fires the
// notification): the notification is sent on a value still inside this window, so what the user
// is told matches the figure that ultimately freezes.
const SETTLE_MS = 150_000;

// Insert in batches so a large backfill (thousands of closed positions × ~19 columns) never exceeds
// Postgres's 65535 bind-parameter limit — a single oversized insert fails the whole reconcile.
const INSERT_CHUNK = 500;

// Positions view = the bin mark-at-close (pnl_sol), the LP-comparable per-position PnL. The FIFO
// real-cash reprice still lives in market_pnl_sol (fed to the realPnl chart) but is NOT the value
// shown here: this view must match LPAgent's per-position figure, which is the bin mark.
const PNL = sql<number>`${positionsTable.pnlSol}`;

type Row = typeof positionsTable.$inferSelect;

/** Postgres-backed position store (Drizzle). All writes are idempotent upserts by primary key. */
export class PostgresPositionRepository implements PositionRepository {
  constructor(private readonly db: Database) {}

  private openRow(p: OpenPosition, now = p.updatedAt) {
    return {
      positionAddress: p.positionAddress,
      wallet: p.wallet,
      poolAddress: p.poolAddress,
      tokenX: p.tokenX,
      tokenY: p.tokenY,
      tokenXMint: p.tokenXMint,
      tokenXIcon: p.tokenXIcon ?? null,
      tokenYIcon: p.tokenYIcon ?? null,
      status: 'open',
      pnlSol: p.pnlSol,
      pnlPctSol: p.pnlPctSol,
      sizeSol: p.sizeSol,
      claimedFeesSol: p.claimedFeesSol,
      unclaimedFeesSol: p.unclaimedFeesSol,
      minPrice: p.minPrice,
      maxPrice: p.maxPrice,
      poolPrice: p.poolPrice,
      rangeStatus: p.rangeStatus,
      oorSince: p.outOfRangeSince,
      openedAt: p.openedAt,
      updatedAt: now,
    };
  }

  async upsertClosed(positions: ClosedPosition[]): Promise<void> {
    if (positions.length === 0) return;
    const now = Date.now();
    const rows = positions.map((p) => ({
      positionAddress: p.positionAddress,
      wallet: p.wallet,
      poolAddress: p.poolAddress,
      tokenX: p.tokenX,
      tokenY: p.tokenY,
      tokenXMint: p.tokenXMint,
      tokenXIcon: p.tokenXIcon ?? null,
      tokenYIcon: p.tokenYIcon ?? null,
      status: 'closed',
      pnlSol: p.pnlSol,
      pnlPctSol: p.pnlPctSol,
      depositSol: p.depositSol,
      withdrawSol: p.withdrawSol,
      claimedFeesSol: p.feesSol,
      marketPnlSol: p.pnlSource === 'market' ? p.pnlSol : null,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      durationSeconds: p.durationSeconds,
      updatedAt: now,
    }));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK)
      await this.db
        .insert(positionsTable)
        .values(rows.slice(i, i + INSERT_CHUNK))
        .onConflictDoUpdate({
          target: positionsTable.positionAddress,
          set: {
            status: sql`'closed'`,
            tokenXMint: sql`excluded.token_x_mint`,
            tokenXIcon: sql`excluded.token_x_icon`,
            tokenYIcon: sql`excluded.token_y_icon`,
            pnlSol: sql`excluded.pnl_sol`,
            pnlPctSol: sql`excluded.pnl_pct_sol`,
            depositSol: sql`excluded.deposit_sol`,
            withdrawSol: sql`excluded.withdraw_sol`,
            claimedFeesSol: sql`excluded.claimed_fees_sol`,
            closedAt: sql`excluded.closed_at`,
            durationSeconds: sql`excluded.duration_seconds`,
            updatedAt: sql`excluded.updated_at`,
            // keep an existing market reprice; the periodic pool-price resync passes null here.
            marketPnlSol: sql`coalesce(excluded.market_pnl_sol, ${positionsTable.marketPnlSol})`,
          },
          // Freeze the realized figures once the close has settled: allow the first close write
          // (status still 'open'/'pending_close') and any re-mark within SETTLE_MS of closed_at.
          setWhere: sql`${positionsTable.status} <> 'closed' OR excluded.updated_at - coalesce(${positionsTable.closedAt}, 0) < ${SETTLE_MS}`,
        });
  }

  async replaceOpenForWallet(wallet: string, positions: OpenPosition[]): Promise<void> {
    const keep = positions.map((p) => p.positionAddress);
    await this.db.transaction(async (tx) => {
      if (positions.length > 0) {
        await tx
          .insert(positionsTable)
          .values(positions.map((p) => this.openRow(p)))
          .onConflictDoUpdate({
            target: positionsTable.positionAddress,
            set: {
              status: sql`'open'`,
              tokenXMint: sql`excluded.token_x_mint`,
              tokenXIcon: sql`excluded.token_x_icon`,
              tokenYIcon: sql`excluded.token_y_icon`,
              pnlSol: sql`excluded.pnl_sol`,
              pnlPctSol: sql`excluded.pnl_pct_sol`,
              sizeSol: sql`excluded.size_sol`,
              claimedFeesSol: sql`excluded.claimed_fees_sol`,
              unclaimedFeesSol: sql`excluded.unclaimed_fees_sol`,
              minPrice: sql`excluded.min_price`,
              maxPrice: sql`excluded.max_price`,
              poolPrice: sql`excluded.pool_price`,
              rangeStatus: sql`excluded.range_status`,
              oorSince: sql`excluded.oor_since`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }
      // Positions previously open for this wallet but no longer present: mark for reconciliation
      // (status stays until the close is confirmed & fetched). Set-based, single statement.
      await tx
        .update(positionsTable)
        .set({ status: 'pending_close', updatedAt: Date.now() })
        .where(
          and(
            eq(positionsTable.wallet, wallet),
            eq(positionsTable.status, 'open'),
            keep.length > 0 ? notInArray(positionsTable.positionAddress, keep) : undefined,
          ),
        );
    });
  }

  async getOpen(wallet: string): Promise<OpenPosition[]> {
    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.wallet, wallet), eq(positionsTable.status, 'open')))
      .orderBy(desc(positionsTable.pnlSol));
    return rows.map(rowToOpen);
  }

  async getClosed(
    wallets: string[],
    opts: {
      page: number;
      pageSize: number;
      q?: string;
      sort?: 'recent' | 'pnl' | 'fees' | 'duration';
      dir?: 'asc' | 'desc';
      result?: 'all' | 'win' | 'loss';
    },
  ): Promise<{ rows: ClosedPosition[]; total: number }> {
    if (wallets.length === 0) return { rows: [], total: 0 };
    const conds = [eq(positionsTable.status, 'closed'), inArray(positionsTable.wallet, wallets)];
    if (opts.q) {
      // Escape LIKE wildcards (% _ \) so a user's search string is matched literally, never as a pattern.
      const q = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
      const match = or(ilike(positionsTable.tokenX, q), ilike(positionsTable.tokenY, q));
      if (match) conds.push(match);
    }
    if (opts.result === 'win') conds.push(sql`${PNL} > 0`);
    else if (opts.result === 'loss') conds.push(sql`${PNL} < 0`);
    const where = and(...conds);

    const sortCol = {
      recent: positionsTable.closedAt,
      pnl: PNL,
      fees: positionsTable.claimedFeesSol,
      duration: positionsTable.durationSeconds,
    }[opts.sort ?? 'recent'];
    const order = opts.dir === 'asc' ? asc(sortCol) : desc(sortCol);

    const counted = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(positionsTable)
      .where(where);
    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(where)
      .orderBy(order)
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize);
    return { rows: rows.map(rowToClosed), total: Number(counted[0]?.c ?? 0) };
  }

  async pendingClosePools(wallet: string): Promise<PoolRef[]> {
    const rows = await this.db
      .selectDistinct({
        poolAddress: positionsTable.poolAddress,
        tokenX: positionsTable.tokenX,
        tokenY: positionsTable.tokenY,
        tokenXMint: positionsTable.tokenXMint,
        tokenXIcon: positionsTable.tokenXIcon,
        tokenYIcon: positionsTable.tokenYIcon,
      })
      .from(positionsTable)
      .where(and(eq(positionsTable.wallet, wallet), eq(positionsTable.status, 'pending_close')));
    return rows.map((r) => ({
      poolAddress: r.poolAddress,
      tokenX: r.tokenX ?? '?',
      tokenY: r.tokenY ?? 'SOL',
      tokenXMint: r.tokenXMint ?? '',
      tokenXIcon: r.tokenXIcon ?? undefined,
      tokenYIcon: r.tokenYIcon ?? undefined,
      tokenYMint: '', // not stored; residual reprice for X/SOL pools uses tokenXMint anyway
    }));
  }

  /**
   * Closed positions to rebuild PURELY on-chain. Default: only the ones Meteora can't price (pnl=0,
   * never enriched). `all: true` returns EVERY closed position — Meteora's datapi has corrupt values
   * (e.g. deposit=0 → bogus +PnL), so a full on-chain rebuild is the only fully-trustworthy source.
   */
  async onchainCandidates(
    wallet: string,
    opts: { all?: boolean } = {},
  ): Promise<{ positionAddress: string; mint: string; closedAt: number }[]> {
    const conds = [
      eq(positionsTable.wallet, wallet),
      eq(positionsTable.status, 'closed'),
      isNotNull(positionsTable.closedAt),
    ];
    if (!opts.all) {
      conds.push(isNull(positionsTable.marketPnlSol), eq(positionsTable.pnlSol, 0));
    }
    const rows = await this.db
      .select({
        a: positionsTable.positionAddress,
        m: positionsTable.tokenXMint,
        c: positionsTable.closedAt,
      })
      .from(positionsTable)
      .where(and(...conds));
    return rows
      .filter((r) => r.m && r.c != null)
      .map((r) => ({ positionAddress: r.a, mint: r.m as string, closedAt: r.c as number }));
  }

  async setAuthoritativePnl(positionAddress: string, pnlSol: number): Promise<void> {
    await this.db
      .update(positionsTable)
      .set({ marketPnlSol: pnlSol })
      .where(
        and(
          eq(positionsTable.positionAddress, positionAddress),
          eq(positionsTable.status, 'closed'),
        ),
      );
  }

  async getClosedByAddress(positionAddress: string): Promise<ClosedPosition | null> {
    const [r] = await this.db
      .select()
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.positionAddress, positionAddress),
          eq(positionsTable.status, 'closed'),
        ),
      )
      .limit(1);
    return r ? rowToClosed(r) : null;
  }

  async walletOfPosition(positionAddress: string): Promise<string | null> {
    const [r] = await this.db
      .select({ wallet: positionsTable.wallet })
      .from(positionsTable)
      .where(eq(positionsTable.positionAddress, positionAddress))
      .limit(1);
    return r ? r.wallet : null;
  }

  async setStrategy(positionAddress: string, family: StrategyFamily): Promise<void> {
    await this.db
      .update(positionsTable)
      .set({ strategy: family })
      .where(eq(positionsTable.positionAddress, positionAddress));
  }

  async getStrategies(): Promise<Map<string, StrategyFamily>> {
    const rows = await this.db
      .select({ a: positionsTable.positionAddress, s: positionsTable.strategy })
      .from(positionsTable)
      .where(sql`${positionsTable.strategy} is not null`);
    return new Map(rows.map((r) => [r.a, r.s as StrategyFamily]));
  }

  async addressesMissingStrategy(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ a: positionsTable.positionAddress })
      .from(positionsTable)
      .where(and(eq(positionsTable.status, 'closed'), isNull(positionsTable.strategy)))
      .orderBy(desc(positionsTable.closedAt))
      .limit(limit);
    return rows.map((r) => r.a);
  }

  async statsAggregate(wallets: string[], sinceMs: number): Promise<Omit<Stats, 'scope'>> {
    const empty: Omit<Stats, 'scope'> = {
      closedCount: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlSol: 0,
      todayPnlSol: 0,
      totalFeesSol: 0,
      totalVolumeSol: 0,
      avgInvestedSol: 0,
      avgMonthlyProfitSol: 0,
      expectedValueSol: 0,
      profitFactor: 0,
      avgDurationSeconds: 0,
      byPair: [],
    };
    if (wallets.length === 0) return empty;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayStartMs = startOfToday.getTime();
    const where = and(
      eq(positionsTable.status, 'closed'),
      inArray(positionsTable.wallet, wallets),
      sinceMs > 0 ? gte(positionsTable.closedAt, sinceMs) : undefined,
    );

    // One scalar-aggregate pass — Postgres computes; we transfer ~10 numbers, not the closed rows.
    const [agg] = await this.db
      .select({
        closedCount: sql<number>`count(*)::int`,
        wins: sql<number>`count(*) filter (where ${PNL} > 0)::int`,
        totalPnlSol: sql<number>`coalesce(sum(${PNL}), 0)::double precision`,
        todayPnlSol: sql<number>`coalesce(sum(${PNL}) filter (where ${positionsTable.closedAt} >= ${todayStartMs}), 0)::double precision`,
        totalFeesSol: sql<number>`coalesce(sum(${positionsTable.claimedFeesSol}), 0)::double precision`,
        totalVolumeSol: sql<number>`coalesce(sum(${positionsTable.depositSol}), 0)::double precision`,
        grossProfit: sql<number>`coalesce(sum(${PNL}) filter (where ${PNL} > 0), 0)::double precision`,
        grossLoss: sql<number>`coalesce(sum(${PNL}) filter (where ${PNL} < 0), 0)::double precision`,
        avgDurationSeconds: sql<number>`coalesce(avg(${positionsTable.durationSeconds}), 0)::double precision`,
        minClosedAt: sql<number | null>`min(${positionsTable.closedAt})`,
        maxClosedAt: sql<number | null>`max(${positionsTable.closedAt})`,
      })
      .from(positionsTable)
      .where(where);

    const closedCount = n(agg?.closedCount);
    if (!agg || closedCount === 0) return empty;
    const wins = n(agg.wins);
    const totalPnl = n(agg.totalPnlSol);
    const totalVolume = n(agg.totalVolumeSol);
    const span =
      agg.minClosedAt != null && agg.maxClosedAt != null && closedCount > 1
        ? n(agg.maxClosedAt) - n(agg.minClosedAt)
        : 0;
    const months = Math.max(1, span / (30 * 86_400_000));

    // by-pair breakdown — GROUP BY in SQL, so only the (few hundred) distinct pairs cross the wire.
    const pairRows = await this.db
      .select({
        tokenX: positionsTable.tokenX,
        tokenY: positionsTable.tokenY,
        pnlSol: sql<number>`coalesce(sum(${PNL}), 0)::double precision`,
        count: sql<number>`count(*)::int`,
      })
      .from(positionsTable)
      .where(where)
      .groupBy(positionsTable.tokenX, positionsTable.tokenY)
      .orderBy(desc(sql`coalesce(sum(${PNL}), 0)`));
    const allPairs = pairRows.map((r) => ({
      pair: `${r.tokenX}/${r.tokenY}`,
      pnlSol: n(r.pnlSol),
      count: n(r.count),
    }));
    // The UI shows only the best/worst handful; cap the payload to the extremes of the ranked list
    // (ordered best→worst) instead of shipping every distinct pair to every viewer.
    const byPair =
      allPairs.length > 40 ? [...allPairs.slice(0, 20), ...allPairs.slice(-20)] : allPairs;

    return {
      closedCount,
      wins,
      losses: closedCount - wins,
      winRate: (wins / closedCount) * 100,
      totalPnlSol: totalPnl,
      todayPnlSol: n(agg.todayPnlSol),
      totalFeesSol: n(agg.totalFeesSol),
      totalVolumeSol: totalVolume,
      avgInvestedSol: totalVolume / closedCount,
      avgMonthlyProfitSol: totalPnl / months,
      expectedValueSol: totalPnl / closedCount,
      // gross profit ÷ gross loss; 0 when there are no losing trades (shown as "—").
      profitFactor: n(agg.grossLoss) < 0 ? n(agg.grossProfit) / Math.abs(n(agg.grossLoss)) : 0,
      avgDurationSeconds: n(agg.avgDurationSeconds),
      byPair,
    };
  }

  async profitBuckets(
    wallets: string[],
    bucketMs: number,
  ): Promise<{ t: number; realized: number }[]> {
    if (wallets.length === 0) return [];
    // The bucket expression appears only in SELECT; GROUP BY/ORDER BY reference it by ordinal (1) so
    // Postgres doesn't see three separately-parameterised copies (which fails with "must appear in GROUP BY").
    const bucket = sql<number>`(floor(${positionsTable.closedAt}::double precision / ${bucketMs}) * ${bucketMs})::bigint`;
    const rows = await this.db
      .select({ t: bucket, realized: sql<number>`coalesce(sum(${PNL}), 0)::double precision` })
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.status, 'closed'),
          inArray(positionsTable.wallet, wallets),
          isNotNull(positionsTable.closedAt),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows.map((r) => ({ t: n(r.t), realized: n(r.realized) }));
  }
}

function rowToOpen(r: Row): OpenPosition {
  return {
    positionAddress: r.positionAddress,
    wallet: r.wallet,
    poolAddress: r.poolAddress,
    tokenX: String(r.tokenX),
    tokenY: String(r.tokenY),
    tokenXMint: r.tokenXMint ?? '',
    tokenXIcon: r.tokenXIcon ?? undefined,
    tokenYIcon: r.tokenYIcon ?? undefined,
    strategy: (r.strategy as StrategyFamily) ?? null,
    sizeSol: n(r.sizeSol),
    pnlSol: n(r.pnlSol),
    pnlPctSol: n(r.pnlPctSol),
    claimedFeesSol: n(r.claimedFeesSol),
    unclaimedFeesSol: n(r.unclaimedFeesSol),
    rangeStatus: (r.rangeStatus as RangeStatus) ?? 'unknown',
    minPrice: n(r.minPrice),
    maxPrice: n(r.maxPrice),
    poolPrice: r.poolPrice == null ? null : n(r.poolPrice),
    outOfRangeSince: r.oorSince == null ? null : n(r.oorSince),
    openedAt: r.openedAt == null ? null : n(r.openedAt),
    updatedAt: n(r.updatedAt),
  };
}

function rowToClosed(r: Row): ClosedPosition {
  // Positions view = the bin mark-at-close (pnl_sol), the LP-comparable per-position PnL. The FIFO
  // real-cash reprice (market_pnl_sol) still feeds the realPnl chart but is deliberately NOT shown
  // here, so this view matches LPAgent's per-position figure (the bin mark) to the cent.
  const pnlSol = n(r.pnlSol);
  const depositSol = n(r.depositSol);
  return {
    positionAddress: r.positionAddress,
    wallet: r.wallet,
    poolAddress: r.poolAddress,
    tokenX: String(r.tokenX),
    tokenY: String(r.tokenY),
    tokenXMint: r.tokenXMint ?? '',
    tokenXIcon: r.tokenXIcon ?? undefined,
    tokenYIcon: r.tokenYIcon ?? undefined,
    strategy: (r.strategy as StrategyFamily) ?? null,
    pnlSol,
    // Percent points (e.g. 1.89 == +1.89%) — same unit as Meteora's pnlSolPctChange and the open
    // side, so the UI's percent formatting and colour thresholds read it correctly.
    pnlPctSol: depositSol > 0 ? (pnlSol / depositSol) * 100 : n(r.pnlPctSol),
    feesSol: n(r.claimedFeesSol),
    depositSol,
    withdrawSol: n(r.withdrawSol),
    openedAt: r.openedAt == null ? null : n(r.openedAt),
    closedAt: r.closedAt == null ? null : n(r.closedAt),
    durationSeconds: r.durationSeconds == null ? null : n(r.durationSeconds),
    minPrice: r.minPrice == null ? undefined : n(r.minPrice),
    maxPrice: r.maxPrice == null ? undefined : n(r.maxPrice),
    // Always the bin mark from pnl_sol now (see above); 'pool' is the matching source label.
    pnlSource: 'pool',
  };
}
