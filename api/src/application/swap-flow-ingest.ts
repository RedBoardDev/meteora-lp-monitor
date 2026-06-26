import type { Logger } from 'pino';
import type { EnhancedTxGateway, SwapFlowRepository } from '@/domain/ports';

/**
 * Ingests a wallet's decoded SWAP legs into `swap_flows`, cursor-driven exactly like {@link
 * WalletFlowIngest} (and the DLMM leg ingest). The expensive Helius Enhanced SWAP paging therefore runs
 * ONCE per wallet (at backfill) and is topped up incrementally afterwards — the realized-PnL FIFO walk
 * is then served by reading these persisted legs from the DB, so a restart/close NEVER re-pages the
 * whole SWAP history again (the incident this step fixes).
 *
 * Three modes, by cursor state:
 *  - no cursor        → fresh full backfill (newest → genesis).
 *  - cursor !complete → resume from where it stopped (oldestSig) onward to genesis.
 *  - cursor complete  → top-up: newest → the previously-ingested newest, picking up new swaps only. A
 *                       wallet with a complete cursor and no new sigs pages ~0 (anti-re-seed).
 */
export class SwapFlowIngest {
  constructor(
    private readonly enhanced: EnhancedTxGateway,
    private readonly repo: SwapFlowRepository,
    private readonly logger: Logger,
  ) {}

  async ingest(wallet: string): Promise<{ added: number; complete: boolean }> {
    if (!this.enhanced.enabled) return { added: 0, complete: false };
    const cursor = await this.repo.getCursor(wallet);
    const resuming = cursor != null && !cursor.complete;
    const toppingUp = cursor?.complete === true;

    // Persist each page as it arrives (idempotent on (wallet, signature, mint)); the cursor advances ONCE
    // at the end, so a crash mid-run keeps the stored legs and the next run re-pages from the top and
    // upserts over them harmlessly — exactly the wallet-flow ingest's restart-resilience model.
    const { added, complete, hitKnownTop, newestSig, oldestSig } = await this.enhanced.pageSwaps(
      wallet,
      {
        untilSig: toppingUp ? cursor.newestSig : null,
        startBefore: resuming ? cursor.oldestSig : null,
        onPage: (rows) => this.repo.upsertMany(rows),
      },
    );

    // `complete` (genesis reached) persists once set — a top-up never un-backfills the tail.
    const reachedComplete = complete || cursor?.complete === true;
    // A top-up may ONLY advance the stored top when it actually reconnected to the prior top
    // (hitKnownTop) or ran clean to genesis. A mid-page failure left a gap between the new top and the
    // old one, so keep the OLD top and let the next top-up re-page (and close) that gap — advancing
    // here would skip the gap forever (silent data loss).
    const topUpCaughtUp = hitKnownTop || complete;
    await this.repo.setCursor(wallet, {
      newestSig: resuming
        ? cursor.newestSig // resume never revisits the top
        : toppingUp
          ? topUpCaughtUp
            ? (newestSig ?? cursor.newestSig ?? null)
            : (cursor.newestSig ?? null) // gap left behind → keep the old top, retry next run
          : (newestSig ?? cursor?.newestSig ?? null), // fresh backfill: first page top is the true top
      // a top-up stops above genesis, so don't let it clobber the true oldest.
      oldestSig: toppingUp ? (cursor?.oldestSig ?? null) : (oldestSig ?? cursor?.oldestSig ?? null),
      complete: reachedComplete,
    });
    this.logger.info({ wallet, added, complete: reachedComplete }, 'swap flow ingest: done');
    return { added, complete: reachedComplete };
  }
}
