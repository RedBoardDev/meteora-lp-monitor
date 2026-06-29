import { eq } from 'drizzle-orm';
import type { Database } from './database';
import { walletStreamCursor } from './schema';

/** Durable transactionSubscribe checkpoint for one wallet: the last signature + slot ingested. A WS
 *  reconnect/replay resumes from `lastSlot` (fromSlot) and dedups by `lastSignature`, so no leader
 *  open/close is missed across a dropped socket or a crash. Null fields ⇒ no checkpoint yet. */
export interface WalletStreamCursor {
  lastSignature: string | null;
  lastSlot: number | null;
}

/** Storage for the per-wallet WS stream checkpoint that backs no-miss reconnect/replay. */
export class WalletStreamCursorRepository {
  constructor(private readonly db: Database) {}

  async get(wallet: string): Promise<WalletStreamCursor | null> {
    const [row] = await this.db
      .select()
      .from(walletStreamCursor)
      .where(eq(walletStreamCursor.wallet, wallet));
    return row ? { lastSignature: row.lastSignature, lastSlot: row.lastSlot } : null;
  }

  /** Advance the checkpoint (last write wins) — called per ingested signature, so it's durable across a
   *  crash. Idempotent on the wallet PK. */
  async set(wallet: string, cursor: WalletStreamCursor): Promise<void> {
    await this.db
      .insert(walletStreamCursor)
      .values({
        wallet,
        lastSignature: cursor.lastSignature,
        lastSlot: cursor.lastSlot,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: walletStreamCursor.wallet,
        set: {
          lastSignature: cursor.lastSignature,
          lastSlot: cursor.lastSlot,
          updatedAt: Date.now(),
        },
      });
  }
}
