import { type Connection, type ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';
import type { DlmmLeg, SwapFlowRow } from '@/domain/dlmm';
import type { DlmmIngest as DlmmIngestPort, LegRepository } from '@/domain/ports';
import { sleep } from '@/util/sleep';
import { withCodePath } from '../code-path';
import { extractSwapRows } from '../parsed-tx-adapter';
import { decodeDlmmLegs } from './dlmm-event-decoder';

const SIG_PAGE = 1000; // getSignaturesForAddress hard cap
const TX_BATCH = 50; // getParsedTransactions batch size — Helius rejects 100 (413 Payload Too Large)
const BATCH_CONCURRENCY = 1; // serial batch requests — no burst, stays under the key's rate limit
const BATCH_PAUSE_MS = 600; // pause between requests so a full-history backfill doesn't trigger 429s
// Bound the backfill to a recent window (days) to keep volume under a limited key's rate limit. 0 =
// full history. Settable via env so the window can be widened incrementally ("petit à petit").
const SINCE_DAYS = Number(process.env.INGEST_SINCE_DAYS) || 0;

/** True when an RPC error is a FREE-tier "batch requests not allowed" rejection (Helius code -32403 /
 *  403 "Batch requests are only available for paid plans") — the signal to fall back to single calls. */
function isBatchUnsupported(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes('Batch requests are only available') || m.includes('-32403');
}

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
    // Ingest path: tag so the getSignaturesForAddress + getParsedTransactions spend is attributed.
    return withCodePath('ingest', () => this.ingestInner(wallet, opts));
  }

  private async ingestInner(
    wallet: string,
    opts: { onProgress?: (txs: number) => void; maxPages?: number } = {},
  ): Promise<{ legs: number; txs: number; complete: boolean }> {
    const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
    let pages = 0;
    const cursor = await this.repo.getCursor(wallet);
    const owner = new PublicKey(wallet);
    const sinceSec = SINCE_DAYS > 0 ? Date.now() / 1000 - SINCE_DAYS * 86_400 : 0;

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
        ({ legs, txs } = await this.decodeBatch(wallet, sigs));
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

      // Bounded window: stop once we've paged past the cutoff (NOT genesis — leave complete=false so a
      // later run with a wider window can extend). blockTime is seconds; null on very old sigs → ignore.
      if (sinceSec > 0) {
        const oldestBt = page[page.length - 1]!.blockTime;
        if (oldestBt != null && oldestBt < sinceSec) break;
      }

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
    let lastErr: unknown;
    for (let i = 0; i < 10; i++) {
      try {
        return await this.conn.getSignaturesForAddress(owner, { limit: SIG_PAGE, before });
      } catch (err) {
        lastErr = err;
        this.logger.debug({ err, i }, 'getSignaturesForAddress retry');
        await sleep(Math.min(15000, 800 * (i + 1)));
      }
    }
    // CRITICAL: THROW, never return [] — an empty page is read as genesis and would FALSELY mark the
    // backfill complete mid-history (this is what truncated the new wallets at ~21 days). Throwing
    // aborts the page without advancing the cursor, so a re-run resumes from where it failed.
    throw lastErr ?? new Error('getSignaturesForAddress failed after retries');
  }

  /**
   * Fetch + decode signatures into legs via BATCH getParsedTransactions (TX_BATCH=50/request), several
   * requests in parallel — fast on a paid plan (batch JSON-RPC). Falls back to single calls per
   * chunk only if a batch request keeps failing (e.g. a 403 on a free key).
   */
  private async decodeBatch(
    wallet: string,
    sigs: string[],
  ): Promise<{ legs: DlmmLeg[]; txs: number }> {
    const legs: DlmmLeg[] = [];
    const shadowSwaps: SwapFlowRow[] = [];
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
          // SHADOW PARITY (unified raw-fetch): derive swap legs from the SAME parsed tx we already fetched
          // (~0 extra RPC), so we can confirm they match the Enhanced-API swap_flows BEFORE cutting the
          // 100cr/page Enhanced path. Read-only (logged, NOT persisted). Isolated — a throw here must never
          // break the no-miss leg ingest.
          try {
            shadowSwaps.push(...extractSwapRows(tx, wallet));
          } catch (err) {
            this.logger.debug({ err }, 'shadow swap extract failed (non-fatal)');
          }
        }
      }
      if (i + BATCH_CONCURRENCY < chunks.length) await sleep(BATCH_PAUSE_MS);
    }
    if (shadowSwaps.length > 0) {
      this.logger.info(
        { wallet, count: shadowSwaps.length, rows: shadowSwaps },
        'shadow swap extract (parity vs Enhanced swap_flows)',
      );
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
        // FREE-TIER fallback: getParsedTransactions sends a BATCH JSON-RPC, which free plans reject
        // ("Batch requests are only available for paid plans"). Fall back to ONE getParsedTransaction per
        // sig (single calls are allowed on free) — slower (the shared limiter throttles it) but functional,
        // so the DLMM leg ingest no longer aborts the page (= no missed legs) on a free key.
        if (isBatchUnsupported(err)) return this.parsedTransactionsSingly(sigs);
        this.logger.debug({ err, i }, 'getParsedTransactions retry');
        await sleep(Math.min(8000, 500 * (i + 1)));
      }
    }
    // exhausted retries → signal failure (the caller aborts the page rather than deleting legs).
    throw lastErr ?? new Error('getParsedTransactions failed');
  }

  /** Free-tier fallback: fetch each sig with a SINGLE getParsedTransaction (not a batch). Sequential so the
   *  shared rate-limiter paces it; a per-sig hard failure throws so the caller aborts the page (never deletes
   *  real legs). Returns the same `(tx | null)[]` shape the batch call would, so the decoder is unchanged. */
  private async parsedTransactionsSingly(
    sigs: string[],
  ): Promise<(ParsedTransactionWithMeta | null)[]> {
    const out: (ParsedTransactionWithMeta | null)[] = [];
    for (const sig of sigs) {
      let lastErr: unknown;
      let got: ParsedTransactionWithMeta | null | undefined;
      for (let i = 0; i < 4 && got === undefined; i++) {
        try {
          got = await this.conn.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
        } catch (err) {
          lastErr = err;
          await sleep(Math.min(8000, 500 * (i + 1)));
        }
      }
      if (got === undefined) throw lastErr ?? new Error('getParsedTransaction failed (single)');
      out.push(got);
    }
    return out;
  }
}
