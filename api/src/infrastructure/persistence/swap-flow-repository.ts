import { eq } from 'drizzle-orm';
import type { FlowCursor, SwapFlowRow, SwapSide } from '@/domain/dlmm';
import type { SwapFlowRepository as SwapFlowRepositoryPort } from '@/domain/ports';
import type { Database } from './database';
import { swapFlowCursor, swapFlows } from './schema';

/** Max rows per insert chunk — keeps each statement well under the Postgres bind-parameter limit
 *  (7 cols × rows). Mirrors the chunking the wallet-flow / dlmm-leg repos use. */
const INSERT_CHUNK = 1000;

/**
 * Storage for the persisted realized-PnL FIFO inputs (swap legs decoded once from the unified ingest).
 * The FIFO walk reads `byWallet` from the DB + the new deltas instead of re-paging the Enhanced API, so
 * a restart costs ~0 credits; rows are immutable and the upsert is idempotent on (wallet, signature,
 * mint), which is what makes re-ingesting a tx a safe no-op.
 */
export class SwapFlowRepository implements SwapFlowRepositoryPort {
  constructor(private readonly db: Database) {}

  /** Idempotently store decoded swap legs. PK (wallet, signature, mint) ⇒ re-ingesting a tx is a no-op
   *  (ON CONFLICT DO NOTHING), so the realized-PnL walk can never double-count a buy/sell. */
  async upsertMany(rows: SwapFlowRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((r) => ({
      wallet: r.wallet,
      signature: r.signature,
      ts: r.ts,
      mint: r.mint,
      tokenAmount: r.tokenAmount,
      solAmount: r.solAmount,
      side: r.side,
    }));
    for (let i = 0; i < values.length; i += INSERT_CHUNK) {
      await this.db
        .insert(swapFlows)
        .values(values.slice(i, i + INSERT_CHUNK))
        .onConflictDoNothing();
    }
  }

  /** All persisted swap legs for a wallet, oldest→newest — the order the FIFO walk consumes them. */
  async byWallet(wallet: string): Promise<SwapFlowRow[]> {
    const rows = await this.db
      .select()
      .from(swapFlows)
      .where(eq(swapFlows.wallet, wallet))
      .orderBy(swapFlows.ts);
    return rows.map((r) => ({
      wallet: r.wallet,
      signature: r.signature,
      ts: r.ts,
      mint: r.mint,
      tokenAmount: r.tokenAmount,
      solAmount: r.solAmount,
      side: r.side as SwapSide,
    }));
  }

  async getCursor(wallet: string): Promise<FlowCursor | null> {
    const [row] = await this.db
      .select()
      .from(swapFlowCursor)
      .where(eq(swapFlowCursor.wallet, wallet));
    return row
      ? { oldestSig: row.oldestSig, newestSig: row.newestSig, complete: row.complete }
      : null;
  }

  async setCursor(wallet: string, cursor: FlowCursor): Promise<void> {
    await this.db
      .insert(swapFlowCursor)
      .values({
        wallet,
        oldestSig: cursor.oldestSig,
        newestSig: cursor.newestSig,
        complete: cursor.complete,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: swapFlowCursor.wallet,
        set: {
          oldestSig: cursor.oldestSig,
          newestSig: cursor.newestSig,
          complete: cursor.complete,
          updatedAt: Date.now(),
        },
      });
  }
}
