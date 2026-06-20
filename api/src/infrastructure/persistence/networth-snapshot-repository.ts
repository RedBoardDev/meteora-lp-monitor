import { and, asc, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from './database';
import { networthSnapshots } from './schema';

/** One reconstructed Net Worth point: the wallet VALUE + the real PnL net of deposits/withdrawals. */
export interface NetworthReconstructedRow {
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** networth = cum_trading + cum_ext + deployed — the wallet VALUE at end of that day (≥0 in practice;
   *  reconciles with the live hero walletTotalSol within rounding). */
  networth: number;
  /** apports = cum_ext = cumulative net external SOL flow (deposits − withdrawals) up to end of that day. */
  apports: number;
  /** realPnl = cum_trading + deployed = networth − apports — the PERFORMANCE net of apports (CAN be negative). */
  realPnl: number;
}

/** A 15-minute UTC bucket index for an epoch-ms timestamp = floor(unix_seconds / 900). */
const bucketOf = (ts: number): number => Math.floor(ts / 1000 / 900);

/** One point of the persisted Net Worth curve (the TRUE on-chain wallet total + its split). */
export interface NetworthCurveRow {
  ts: number;
  walletTotalSol: number;
  tvlSol: number;
  idleSol: number;
}

/**
 * Forward-only storage for the TRUE wallet Net Worth (tvl + idle) sampled into 15-min UTC buckets.
 * `record` upserts on (wallet, bucket) so the last sample in a bucket wins — bounding the write rate
 * to ≤1 row per wallet per quarter-hour. `curve` is a pure SQL read (range scan on the PK), and for
 * a multi-wallet scope it SUMs across wallets per bucket (so `wallet=all` is a true aggregate).
 */
export class NetworthSnapshotRepository {
  constructor(private readonly db: Database) {}

  async record(wallet: string, p: NetworthCurveRow): Promise<void> {
    const bucket = bucketOf(p.ts);
    await this.db
      .insert(networthSnapshots)
      .values({
        wallet,
        bucket,
        ts: p.ts,
        walletTotalSol: p.walletTotalSol,
        tvlSol: p.tvlSol,
        idleSol: p.idleSol,
      })
      .onConflictDoUpdate({
        target: [networthSnapshots.wallet, networthSnapshots.bucket],
        set: {
          ts: p.ts,
          walletTotalSol: p.walletTotalSol,
          tvlSol: p.tvlSol,
          idleSol: p.idleSol,
        },
      });
  }

  /**
   * The Net Worth series for one or more wallets since `sinceSec`, ordered by bucket. Multiple wallets
   * are SUMmed per bucket (the aggregated "all" scope) — buckets are aligned, so the sum is the wallet
   * total of the watchlist at each sample window. `ts` is the max sample time in the bucket.
   */
  async curve(wallets: string[], sinceSec: number): Promise<NetworthCurveRow[]> {
    if (wallets.length === 0) return [];
    const sinceBucket = Math.floor(sinceSec / 900);
    const rows = await this.db
      .select({
        bucket: networthSnapshots.bucket,
        ts: sql<number>`max(${networthSnapshots.ts})`,
        walletTotalSol: sql<number>`sum(${networthSnapshots.walletTotalSol})`,
        tvlSol: sql<number>`sum(${networthSnapshots.tvlSol})`,
        idleSol: sql<number>`sum(${networthSnapshots.idleSol})`,
      })
      .from(networthSnapshots)
      .where(
        and(inArray(networthSnapshots.wallet, wallets), gte(networthSnapshots.bucket, sinceBucket)),
      )
      .groupBy(networthSnapshots.bucket)
      .orderBy(asc(networthSnapshots.bucket));
    return rows.map((r) => ({
      ts: Number(r.ts),
      walletTotalSol: Number(r.walletTotalSol),
      tvlSol: Number(r.tvlSol),
      idleSol: Number(r.idleSol),
    }));
  }

  /**
   * The REAL Net Worth + PnL curve, reconstructed per UTC day from the ledger (not the snapshots).
   *
   * Daily flows are split by `is_trading`: net_trading = Σ sol_flow WHERE is_trading (the realized
   * trading PnL increment); net_ext = Σ sol_flow WHERE NOT is_trading (deposits/withdrawals = "apports").
   * Three running sums per UTC day: cum_trading, cum_ext, and `deployed` (the open-position-at-cost sweep).
   *
   *  • networth(day) = cum_trading + cum_ext + deployed — the wallet VALUE (≥0 in practice; ≡ getBalance
   *                    + open TVL at cost). Falls to 0 if the wallet is emptied; never negative.
   *  • apports(day)  = cum_ext — cumulative net deposits.
   *  • realPnl(day)  = cum_trading + deployed = networth − apports — the PERFORMANCE net of apports. CAN
   *                    be negative (e.g. injected more than the wallet is currently worth).
   *
   * `deployed` = SOL-side deposit (from dlmm_legs, sol side per dlmm_pools.sol_side) of every position
   * OPEN at end of that day (open = opened_at ≤ end AND (closed_at IS NULL OR closed_at > end); lifecycle
   * in ms from positions.opened_at/closed_at).
   *
   * The window starts at the UTC date of `sinceSec` (floored to the day); `sinceSec = 0` ⇒ the earliest
   * wallet_flows day for these wallets (the wallet's first on-chain activity). Reconciles with the live
   * hero walletTotalSol within rounding.
   */
  async reconstructedCurve(
    wallets: string[],
    sinceSec: number,
  ): Promise<NetworthReconstructedRow[]> {
    if (wallets.length === 0) return [];
    // Bind the wallet list as a real Postgres text[] via string_to_array — drizzle's sql`` would
    // otherwise pass a JS array as a scalar param into any($n) → "malformed array literal".
    const walletsCsv = wallets.join(',');
    // sinceSec floored to a UTC epoch-day; 0 ⇒ from the wallet's first flow day. The running sums are
    // ALWAYS computed from the earliest day (so the cumulative is correct), then filtered to >= sinceDay.
    const sinceDay = sinceSec > 0 ? Math.floor(sinceSec / 86_400) : 0;
    // O(n) "sweep": cumulative cash = running sum of daily net flow; deployed = running sum of
    // (+deposit at a position's open day, -deposit at its close day). Replaces an O(n²) per-day
    // correlated-subquery scan (which took ~17s all-time) — this is ~130ms.
    const rows = await this.db.execute<{
      date: string;
      networth: string;
      apports: string;
      realpnl: string;
    }>(sql`
      with flow as (
        select floor(ts / 86400)::int as day,
          sum(sol_flow) filter (where is_trading) as net_trading,
          sum(sol_flow) filter (where not is_trading) as net_ext
        from wallet_flows
        where wallet = any(string_to_array(${walletsCsv}, ','))
        group by 1
      ),
      posdep as (
        select dl.position,
          sum(case when dp.sol_side = 'Y' and dl.kind = 'deposit' then dl.amount_y::numeric
                   when dp.sol_side = 'X' and dl.kind = 'deposit' then dl.amount_x::numeric
                   else 0 end) / 1e9 as dep
        from dlmm_legs dl
        join dlmm_pools dp on dp.pool_address = dl.lb_pair
        where dl.wallet = any(string_to_array(${walletsCsv}, ','))
        group by dl.position
      ),
      life as (
        select floor(p.opened_at / 1000 / 86400)::int as open_day,
          case when p.closed_at is null then null else floor(p.closed_at / 1000 / 86400)::int end as close_day,
          pd.dep
        from positions p
        join posdep pd on pd.position = p.position_address
        where p.wallet = any(string_to_array(${walletsCsv}, ',')) and p.opened_at is not null
      ),
      ev as (
        select open_day as day, sum(dep) as delta from life group by 1
        union all
        select close_day as day, -sum(dep) as delta from life where close_day is not null group by 1
      ),
      evd as (select day, sum(delta) as delta from ev group by 1),
      days as (
        select generate_series((select min(day) from flow), floor(extract(epoch from current_date) / 86400)::int) as day
      ),
      curve as (
        select days.day,
          sum(coalesce(f.net_trading, 0)) over o as cum_trading,
          sum(coalesce(f.net_ext, 0)) over o as cum_ext,
          sum(coalesce(e.delta, 0)) over o as deployed
        from days
        left join flow f on f.day = days.day
        left join evd e on e.day = days.day
        window o as (order by days.day)
      )
      select to_char(to_timestamp(day * 86400), 'YYYY-MM-DD') as date,
        cum_trading + cum_ext + deployed as networth,
        cum_ext as apports,
        cum_trading + deployed as realpnl
      from curve
      where day >= ${sinceDay}
      order by day
    `);
    return rows.map((r) => ({
      date: r.date,
      networth: Number(r.networth),
      apports: Number(r.apports),
      realPnl: Number(r.realpnl),
    }));
  }
}
