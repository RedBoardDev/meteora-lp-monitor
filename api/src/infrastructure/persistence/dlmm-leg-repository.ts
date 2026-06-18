import { eq, inArray } from 'drizzle-orm';
import type { DlmmLeg, IngestCursor, LoadedPoolMeta, StoredLeg } from '@/domain/dlmm';
import type { LegRepository } from '@/domain/ports';
import type { Database } from './database';
import { dlmmIngestCursor, dlmmLegs, dlmmPools } from './schema';

const toStored = (r: typeof dlmmLegs.$inferSelect): StoredLeg => ({
  signature: r.signature,
  position: r.position,
  lbPair: r.lbPair,
  kind: r.kind as StoredLeg['kind'],
  activeBinId: r.activeBinId,
  amountX: BigInt(r.amountX),
  amountY: BigInt(r.amountY),
  blockTime: r.blockTime,
});

/** Storage for the decoupled on-chain DLMM engine: decoded legs + per-wallet ingest cursor. */
export class DlmmLegRepository implements LegRepository {
  constructor(private readonly db: Database) {}

  /**
   * Idempotently store a batch of txs' legs: delete any existing rows for those signatures, then
   * insert the freshly decoded legs. Re-processing a tx is therefore an exact replace (no double
   * count), which makes the whole ingest safely re-runnable.
   */
  async replaceForSignatures(wallet: string, signatures: string[], legs: DlmmLeg[]): Promise<void> {
    if (signatures.length === 0) return;
    await this.db.transaction(async (tx) => {
      await tx.delete(dlmmLegs).where(inArray(dlmmLegs.signature, signatures));
      if (legs.length === 0) return;
      const rows = legs.map((l) => ({
        signature: l.signature,
        wallet,
        position: l.position,
        lbPair: l.lbPair,
        kind: l.kind,
        activeBinId: l.activeBinId,
        amountX: l.amountX.toString(),
        amountY: l.amountY.toString(),
        blockTime: l.blockTime,
      }));
      // chunk to stay under the Postgres bind-parameter limit (9 cols × rows).
      for (let i = 0; i < rows.length; i += 1000) {
        await tx.insert(dlmmLegs).values(rows.slice(i, i + 1000));
      }
    });
  }

  async legsByPosition(position: string): Promise<StoredLeg[]> {
    const rows = await this.db.select().from(dlmmLegs).where(eq(dlmmLegs.position, position));
    return rows.map(toStored);
  }

  async legsByWallet(wallet: string): Promise<StoredLeg[]> {
    const rows = await this.db.select().from(dlmmLegs).where(eq(dlmmLegs.wallet, wallet));
    return rows.map(toStored);
  }

  /** Legs for a SUBSET of positions (the open set) — so the cadence refresh loads a handful of rows,
   *  not the wallet's whole leg history. */
  async legsByPositions(positions: string[]): Promise<StoredLeg[]> {
    if (positions.length === 0) return [];
    const rows = await this.db.select().from(dlmmLegs).where(inArray(dlmmLegs.position, positions));
    return rows.map(toStored);
  }

  /** Cached metadata for a set of pools (immutable on-chain; populated lazily from the LbPair account). */
  async getPoolMetas(pools: string[]): Promise<Map<string, LoadedPoolMeta>> {
    const out = new Map<string, LoadedPoolMeta>();
    // chunk the IN-list to keep the query well under the Postgres bind-parameter limit.
    for (let i = 0; i < pools.length; i += 1000) {
      const rows = await this.db
        .select()
        .from(dlmmPools)
        .where(inArray(dlmmPools.poolAddress, pools.slice(i, i + 1000)));
      for (const r of rows)
        out.set(r.poolAddress, {
          binStep: r.binStep,
          solSide: r.solSide as 'X' | 'Y' | null,
          mintX: r.mintX,
          mintY: r.mintY,
        });
    }
    return out;
  }

  /** Persist a pool's decoded metadata (idempotent; immutable so a re-write is a no-op). */
  async putPoolMeta(pool: string, meta: LoadedPoolMeta): Promise<void> {
    await this.db
      .insert(dlmmPools)
      .values({
        poolAddress: pool,
        binStep: meta.binStep,
        solSide: meta.solSide,
        mintX: meta.mintX,
        mintY: meta.mintY,
      })
      .onConflictDoNothing();
  }

  async getCursor(wallet: string): Promise<IngestCursor | null> {
    const [row] = await this.db
      .select()
      .from(dlmmIngestCursor)
      .where(eq(dlmmIngestCursor.wallet, wallet));
    return row
      ? { oldestSig: row.oldestSig, newestSig: row.newestSig, complete: row.complete }
      : null;
  }

  async setCursor(wallet: string, cursor: IngestCursor): Promise<void> {
    await this.db
      .insert(dlmmIngestCursor)
      .values({
        wallet,
        oldestSig: cursor.oldestSig,
        newestSig: cursor.newestSig,
        complete: cursor.complete,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: dlmmIngestCursor.wallet,
        set: {
          oldestSig: cursor.oldestSig,
          newestSig: cursor.newestSig,
          complete: cursor.complete,
          updatedAt: Date.now(),
        },
      });
  }
}
