import { desc, gte, sql } from 'drizzle-orm';
import type { CreditFlushRow } from '@/infrastructure/solana/credit-meter';
import type { Database } from './database';
import { rpcCreditDaily } from './schema';

/** UTC-day bucket width — `day` = floor(ms / MS_PER_DAY), matching the CreditMeter's day key. */
const MS_PER_DAY = 86_400_000;
/** Max rows per upsert chunk — keeps each statement under the Postgres bind-parameter limit (6 cols). */
const INSERT_CHUNK = 1000;

/** One persisted ledger bucket, read back for the /debug/rpc last-7d view. */
export interface CreditLedgerRow {
  day: number;
  method: string;
  wallet: string;
  codePath: string;
  calls: number;
  credits: number;
}

/**
 * Durable RPC-credit telemetry: the CreditMeter's per-(day,method,wallet,codePath) deltas are flushed
 * here every 60s, so /debug/rpc keeps real spend history across restarts (the in-memory ledger resets on
 * boot). Writes are ADDITIVE (each flush carries only new deltas); reads window on the recent days.
 */
export class RpcCreditLedgerRepository {
  // Clock injected (like the CreditMeter) so the since() window is deterministic in tests.
  constructor(
    private readonly db: Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Append a batch of since-last-drain deltas. ON CONFLICT the bucket's calls/credits are INCREMENTED
   *  (not overwritten), so two flushes of the same key sum — this is deliberately NOT idempotent because
   *  each flush carries only the deltas accumulated since the previous one. */
  async addDeltas(rows: CreditFlushRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((r) => ({
      day: r.day,
      method: r.method,
      wallet: r.wallet,
      codePath: r.codePath,
      calls: r.calls,
      credits: r.credits,
    }));
    for (let i = 0; i < values.length; i += INSERT_CHUNK) {
      await this.db
        .insert(rpcCreditDaily)
        .values(values.slice(i, i + INSERT_CHUNK))
        .onConflictDoUpdate({
          target: [
            rpcCreditDaily.day,
            rpcCreditDaily.method,
            rpcCreditDaily.wallet,
            rpcCreditDaily.codePath,
          ],
          set: {
            calls: sql`${rpcCreditDaily.calls} + excluded.calls`,
            credits: sql`${rpcCreditDaily.credits} + excluded.credits`,
          },
        });
    }
  }

  /** The persisted rollup for the most-recent `daysBack` UTC days, inclusive of today (so since(7) spans
   *  [today-6 … today]). Newest day first — the order the /debug/rpc panel renders. */
  async since(daysBack: number): Promise<CreditLedgerRow[]> {
    const today = Math.floor(this.now() / MS_PER_DAY);
    const sinceDay = today - (Math.max(1, daysBack) - 1);
    const rows = await this.db
      .select()
      .from(rpcCreditDaily)
      .where(gte(rpcCreditDaily.day, sinceDay))
      .orderBy(desc(rpcCreditDaily.day));
    return rows.map((r) => ({
      day: r.day,
      method: r.method,
      wallet: r.wallet,
      codePath: r.codePath,
      calls: r.calls,
      credits: r.credits,
    }));
  }
}
