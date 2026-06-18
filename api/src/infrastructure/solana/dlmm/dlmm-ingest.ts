import { type Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';
import type { DlmmLeg } from '@/domain/dlmm';
import type { DlmmIngest as DlmmIngestPort, LegRepository } from '@/domain/ports';
import { sleep } from '@/util/sleep';
import { decodeDlmmLegs } from './dlmm-event-decoder';

const SIG_PAGE = 1000; // getSignaturesForAddress hard cap
const TX_BATCH = 50; // getParsedTransactions batch size — Helius rejects 100 (413 Payload Too Large)
const BATCH_CONCURRENCY = 6; // parallel batch requests (≈300 txs in flight; well under 50 RPS)

/**
 * Ingests a wallet's FULL Meteora DLMM history from chain into Postgres — paged signatures →
 * getParsedTransactions → IDL-decoded legs. NO Meteora off-chain API, so it reaches genesis (recovers
 * the positions Meteora purges after ~7 months). Resumable + incremental via the per-wallet cursor.
 *
 * Three modes, by cursor state:
 *  - no cursor        → fresh backfill, newest → genesis.
 *  - cursor !complete → resume the backfill from where it stopped (oldestSig), onward to genesis.
 *  - cursor complete  → top-up: newest → until the previously-ingested newest, picking up new txs.
 *
 * `maxSupportedTransactionVersion: 0` is mandatory (most DLMM txs are v0; omitting it hard-fails the
 * whole fetch). Events are read from innerInstructions (Event CPI), immune to 10 KB log truncation.
 */
export class DlmmIngest implements DlmmIngestPort {
  constructor(
    private readonly conn: Connection,
    private readonly repo: LegRepository,
    private readonly logger: Logger,
  ) {}

  async ingest(
    wallet: string,
    opts: { onProgress?: (txs: number) => void; maxPages?: number } = {},
  ): Promise<{ legs: number; txs: number; complete: boolean }> {
    const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
    let pages = 0;
    const cursor = await this.repo.getCursor(wallet);
    const owner = new PublicKey(wallet);

    const resuming = cursor != null && !cursor.complete;
    const toppingUp = cursor?.complete === true;
    const stopSig = toppingUp ? cursor.newestSig : null;
    let before: string | undefined = resuming ? (cursor.oldestSig ?? undefined) : undefined;

    // newest signature of this wallet: captured on the first page of a fresh backfill / top-up; on a
    // resume we don't revisit the top, so keep what the cursor already recorded.
    let newestSig: string | null = resuming ? cursor.newestSig : null;
    let oldestSig: string | null = cursor?.oldestSig ?? null;
    let reachedGenesis = false;
    let totalLegs = 0;
    let totalTxs = 0;

    while (true) {
      const page = await this.signatures(owner, before);
      if (page.length === 0) {
        reachedGenesis = !toppingUp; // an empty page at the bottom = genesis; at the top = nothing new
        break;
      }
      if (newestSig === null) newestSig = page[0]!.signature;

      const sigs: string[] = [];
      let hitKnownTop = false;
      for (const s of page) {
        if (stopSig && s.signature === stopSig) {
          hitKnownTop = true;
          break;
        }
        if (s.err) continue; // failed tx — no state change to decode
        sigs.push(s.signature);
      }

      // CRITICAL: a FAILED fetch must NOT delete existing legs. decodeBatch throws if any tx batch
      // couldn't be fetched after retries; we then abort the page (no replaceForSignatures, no cursor
      // advance) so a re-run resumes cleanly — never replacing real legs with an empty set.
      let legs: DlmmLeg[];
      let txs: number;
      try {
        ({ legs, txs } = await this.decodeBatch(sigs));
      } catch (err) {
        this.logger.error(
          { err, wallet },
          'dlmm ingest: page fetch failed — aborting without delete',
        );
        break;
      }
      await this.repo.replaceForSignatures(wallet, sigs, legs);
      totalLegs += legs.length;
      totalTxs += txs;
      opts.onProgress?.(totalTxs);

      oldestSig = page[page.length - 1]!.signature;
      before = oldestSig;

      if (hitKnownTop) break;
      if (page.length < SIG_PAGE) {
        reachedGenesis = true;
        break;
      }
      if (++pages >= maxPages) break; // bounded run (verification / resume in slices)
    }

    const complete = reachedGenesis || cursor?.complete === true;
    await this.repo.setCursor(wallet, {
      newestSig: newestSig ?? cursor?.newestSig ?? null,
      oldestSig,
      complete,
    });
    this.logger.info({ wallet, legs: totalLegs, txs: totalTxs, complete }, 'dlmm ingest: done');
    return { legs: totalLegs, txs: totalTxs, complete };
  }

  /** One page of signatures, newest-first, with retry. */
  private async signatures(owner: PublicKey, before: string | undefined) {
    for (let i = 0; i < 8; i++) {
      try {
        return await this.conn.getSignaturesForAddress(owner, { limit: SIG_PAGE, before });
      } catch (err) {
        this.logger.debug({ err, i }, 'getSignaturesForAddress retry');
        await sleep(Math.min(8000, 600 * (i + 1)));
      }
    }
    return [];
  }

  /**
   * Fetch + decode signatures into legs via BATCH getParsedTransactions (TX_BATCH=50/request), several
   * requests in parallel — fast on a paid plan (batch JSON-RPC). Falls back to single calls per
   * chunk only if a batch request keeps failing (e.g. a 403 on a free key).
   */
  private async decodeBatch(sigs: string[]): Promise<{ legs: DlmmLeg[]; txs: number }> {
    const legs: DlmmLeg[] = [];
    let txs = 0;
    const chunks: string[][] = [];
    for (let i = 0; i < sigs.length; i += TX_BATCH) chunks.push(sigs.slice(i, i + TX_BATCH));
    for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
      const group = chunks.slice(i, i + BATCH_CONCURRENCY);
      const results = await Promise.all(group.map((c) => this.parsedTransactions(c)));
      for (const parsed of results) {
        for (const tx of parsed) {
          if (!tx) continue;
          txs++;
          legs.push(...decodeDlmmLegs(tx));
        }
      }
    }
    return { legs, txs };
  }

  private async parsedTransactions(sigs: string[]) {
    let lastErr: unknown;
    for (let i = 0; i < 6; i++) {
      try {
        return await this.conn.getParsedTransactions(sigs, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
      } catch (err) {
        lastErr = err;
        this.logger.debug({ err, i }, 'getParsedTransactions retry');
        await sleep(Math.min(8000, 500 * (i + 1)));
      }
    }
    // exhausted retries → signal failure (the caller aborts the page rather than deleting legs).
    throw lastErr ?? new Error('getParsedTransactions failed');
  }
}
