import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DailyFlow, FlowCursor, WalletFlowRow } from '@/domain/dlmm';
import type { WalletFlowRepository as WalletFlowRepositoryPort } from '@/domain/ports';
import type { Database } from './database';
import { walletFlowCursor, walletFlowDaily, walletFlows } from './schema';

/**
 * Storage for the persisted wallet cash-flow that backs the wallet PnL curve. The expensive Helius
 * paging runs once at backfill and is topped up incrementally; serving the curve is then a pure SQL
 * GROUP-BY-day aggregation here — instant, restart-proof, and trivially multi-wallet (SUM across an
 * IN-list), which is what makes `wallet=all` correct and cheap.
 */
export class WalletFlowRepository implements WalletFlowRepositoryPort {
  constructor(private readonly db: Database) {}

  /** Idempotently store paged flows. PK (wallet, signature) ⇒ re-paging the same txs is a no-op. Each
   *  chunk also maintains the daily rollup atomically: the genuinely-new rows (RETURNING after ON
   *  CONFLICT DO NOTHING) are summed per UTC epoch-day and ADDED to wallet_flow_daily — so the rollup
   *  stays exactly equal to the raw per-day aggregate, and re-paging the same txs adds nothing. */
  async upsertFlows(wallet: string, flows: WalletFlowRow[]): Promise<void> {
    if (flows.length === 0) return;
    const rows = flows.map((f) => ({
      wallet,
      signature: f.signature,
      ts: f.timestamp,
      solFlow: f.solFlow,
      isTrading: f.isTrading,
      type: f.type,
    }));
    // chunk to stay well under the Postgres bind-parameter limit (6 cols × rows).
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(walletFlows)
          .values(chunk)
          .onConflictDoNothing()
          .returning({
            ts: walletFlows.ts,
            solFlow: walletFlows.solFlow,
            isTrading: walletFlows.isTrading,
          });
        if (inserted.length === 0) return; // all duplicates → rollup already accounts for them
        const byDay = new Map<number, { trading: number; external: number }>();
        for (const r of inserted) {
          const day = Math.floor(r.ts / 86_400); // UTC epoch-day
          const acc = byDay.get(day) ?? { trading: 0, external: 0 };
          if (r.isTrading) acc.trading += r.solFlow;
          else acc.external += r.solFlow;
          byDay.set(day, acc);
        }
        await tx
          .insert(walletFlowDaily)
          .values([...byDay].map(([day, v]) => ({ wallet, day, ...v })))
          .onConflictDoUpdate({
            target: [walletFlowDaily.wallet, walletFlowDaily.day],
            set: {
              trading: sql`${walletFlowDaily.trading} + excluded.trading`,
              external: sql`${walletFlowDaily.external} + excluded.external`,
            },
          });
      });
    }
  }

  /**
   * The daily flow series for one or more wallets since `sinceSec`, summed in SQL and grouped by UTC
   * day. `wallet=all` is just a longer IN-list — the aggregation is identical. Returns ascending days
   * that actually had activity; the caller gap-fills and cumulates into the continuous curve.
   */
  async dailyFlows(wallets: string[], sinceSec: number): Promise<DailyFlow[]> {
    if (wallets.length === 0) return [];
    // Read the pre-aggregated daily rollup (a handful of rows per wallet per day) instead of scanning
    // the raw flows. For wallet=all the GROUP BY day SUMs the per-wallet rows for that day. The window
    // floor is the epoch-day of sinceSec (the curve is daily-granular, so a whole-day floor is exact).
    const sinceDay = Math.floor(sinceSec / 86_400);
    const rows = await this.db
      .select({
        day: walletFlowDaily.day,
        trading: sql<string>`coalesce(sum(${walletFlowDaily.trading}), 0)`,
        external: sql<string>`coalesce(sum(${walletFlowDaily.external}), 0)`,
      })
      .from(walletFlowDaily)
      .where(and(inArray(walletFlowDaily.wallet, wallets), gte(walletFlowDaily.day, sinceDay)))
      .groupBy(walletFlowDaily.day)
      .orderBy(walletFlowDaily.day);
    return rows.map((r) => ({
      date: new Date(Number(r.day) * 86_400_000).toISOString().slice(0, 10),
      trading: Number(r.trading),
      external: Number(r.external),
    }));
  }

  /**
   * Authoritatively rebuild the daily rollup from the raw flows (overwrite). Idempotent repair / first
   * population — running it again recomputes identical values. Used by {@link ensureDailyBackfilled}
   * on boot and available for a manual resync if the incremental maintenance is ever suspected.
   */
  async rebuildDaily(): Promise<void> {
    await this.db.execute(sql`
      insert into wallet_flow_daily (wallet, day, trading, external)
      select wallet, (ts / 86400)::int as day,
             coalesce(sum(sol_flow) filter (where is_trading), 0),
             coalesce(sum(sol_flow) filter (where not is_trading), 0)
      from wallet_flows
      group by wallet, (ts / 86400)::int
      on conflict (wallet, day) do update
        set trading = excluded.trading, external = excluded.external
    `);
  }

  /** Resync the rollup from raw on boot — ALWAYS rebuilds (authoritative + idempotent), never the old
   *  "skip if non-empty" guard. That guard was fragile: a single incremental upsert (today's flow) made
   *  the rollup non-empty before the historical backfill ran, so the whole back-history was skipped and
   *  the curve showed only today. A boot is rare and the GROUP-BY is cheap, so just rebuild every time —
   *  runtime reads still hit the rollup; runtime writes (upsertFlows) keep it current between boots. */
  async ensureDailyBackfilled(): Promise<void> {
    await this.rebuildDaily();
  }

  /** The reconstructed on-chain cash balance for a wallet = the signed sum of every persisted flow
   *  (native + wSOL). The reconciliation invariant compares this ledger against the live on-chain idle. */
  async reconstructedSum(wallet: string): Promise<number> {
    const [row] = await this.db
      .select({ sum: sql<string>`coalesce(sum(${walletFlows.solFlow}), 0)` })
      .from(walletFlows)
      .where(eq(walletFlows.wallet, wallet));
    return Number(row?.sum ?? 0);
  }

  async getCursor(wallet: string): Promise<FlowCursor | null> {
    const [row] = await this.db
      .select()
      .from(walletFlowCursor)
      .where(eq(walletFlowCursor.wallet, wallet));
    return row
      ? { oldestSig: row.oldestSig, newestSig: row.newestSig, complete: row.complete }
      : null;
  }

  /** True iff EVERY wallet has a complete cursor — one COUNT query instead of N point-lookups. A wallet
   *  with no cursor row (still backfilling) isn't counted, so it correctly fails the all-complete test. */
  async allCursorsComplete(wallets: string[]): Promise<boolean> {
    if (wallets.length === 0) return true;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(walletFlowCursor)
      .where(and(inArray(walletFlowCursor.wallet, wallets), eq(walletFlowCursor.complete, true)));
    return Number(row?.n ?? 0) === wallets.length;
  }

  async setCursor(wallet: string, cursor: FlowCursor): Promise<void> {
    await this.db
      .insert(walletFlowCursor)
      .values({
        wallet,
        oldestSig: cursor.oldestSig,
        newestSig: cursor.newestSig,
        complete: cursor.complete,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: walletFlowCursor.wallet,
        set: {
          oldestSig: cursor.oldestSig,
          newestSig: cursor.newestSig,
          complete: cursor.complete,
          updatedAt: Date.now(),
        },
      });
  }
}
