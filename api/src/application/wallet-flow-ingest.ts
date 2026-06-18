import type { Logger } from 'pino';
import type { EnhancedTxGateway, WalletFlowRepository } from '@/domain/ports';

/**
 * Ingests a wallet's on-chain SOL cash-flow into `wallet_flows`, cursor-driven exactly like the DLMM
 * leg ingest. The expensive Helius Enhanced paging therefore runs ONCE per wallet (at backfill) and is
 * topped up incrementally afterwards — the wallet PnL curve is then served by a pure SQL aggregation,
 * never by re-paging the chain on the request path.
 *
 * Three modes, by cursor state:
 *  - no cursor        → fresh full backfill (newest → genesis).
 *  - cursor !complete → resume from where it stopped (oldestSig) onward to genesis.
 *  - cursor complete  → top-up: newest → the previously-ingested newest, picking up new txs (incl. the
 *                       post-close SWAP dumps the DLMM ingest can't see).
 */
export class WalletFlowIngest {
  constructor(
    private readonly enhanced: EnhancedTxGateway,
    private readonly repo: WalletFlowRepository,
    private readonly logger: Logger,
  ) {}

  async ingest(wallet: string): Promise<{ added: number; complete: boolean }> {
    if (!this.enhanced.enabled) return { added: 0, complete: false };
    const cursor = await this.repo.getCursor(wallet);
    const resuming = cursor != null && !cursor.complete;
    const toppingUp = cursor?.complete === true;

    // Persist each page as it arrives (idempotent on (wallet, signature)); the cursor is advanced ONCE
    // at the end, so a crash mid-run keeps the stored pages and the next run re-pages from the top and
    // upserts over them harmlessly — exactly the DLMM ingest's restart-resilience model.
    const { added, complete, newestSig, oldestSig } = await this.enhanced.pageFlows(wallet, {
      untilSig: toppingUp ? cursor.newestSig : null,
      startBefore: resuming ? cursor.oldestSig : null,
      onPage: (flows) => this.repo.upsertFlows(wallet, flows),
    });

    const reachedComplete = complete || cursor?.complete === true;
    await this.repo.setCursor(wallet, {
      // resume never revisits the top, so keep the newest recorded on the first backfill page.
      newestSig: resuming ? cursor.newestSig : (newestSig ?? cursor?.newestSig ?? null),
      // a top-up stops above genesis, so don't let it clobber the true oldest.
      oldestSig: toppingUp ? (cursor?.oldestSig ?? null) : (oldestSig ?? cursor?.oldestSig ?? null),
      complete: reachedComplete,
    });
    this.logger.info({ wallet, added, complete: reachedComplete }, 'wallet flow ingest: done');
    return { added, complete: reachedComplete };
  }
}
