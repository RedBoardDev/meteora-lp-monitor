import type { WalletPnlCurve } from '@binsight/shared';
import type { WalletFlowRepository } from '@/domain/ports';
import { buildCashflowCurveFromDaily } from './wallet-cashflow';

const DAY_MS = 86_400_000;

export type { WalletPnlCurve };

/**
 * Serves the wallet PnL curve — the TRUE realized SOL the wallet gained/lost over time (captures the
 * rug/slippage losses position-level PnL misses). The expensive chain paging now happens ONCE per
 * wallet at ingest (engine backfill + incremental top-ups, persisted in `wallet_flows`); this service
 * is a thin read path: a single GROUP-BY-day SQL aggregation, instant and restart-proof.
 *
 * Multi-wallet (`wallet=all`) is a longer IN-list in the same aggregation — correct by construction,
 * unlike the old path that only ever served wallets[0].
 */
export class WalletPnlService {
  constructor(
    private readonly flowRepo: WalletFlowRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async curve(wallets: string[], daysBack: number): Promise<WalletPnlCurve> {
    if (wallets.length === 0) {
      return { days: [], totalTradingSol: 0, totalExternalSol: 0, complete: true };
    }
    const sinceSec = Math.floor((this.now() - daysBack * DAY_MS) / 1000);

    // `complete` = every requested wallet has finished its full-history flow ingest. A wallet still
    // backfilling (no cursor yet, or cursor.complete=false) makes the curve partial — surfaced so the
    // UI can keep showing its "indexing…" state instead of presenting a half-built curve as final.
    const cursors = await Promise.all(wallets.map((w) => this.flowRepo.getCursor(w)));
    const complete = cursors.every((c) => c?.complete === true);

    const daily = await this.flowRepo.dailyFlows(wallets, sinceSec);
    const { days, totalTradingSol, totalExternalSol } = buildCashflowCurveFromDaily(daily);
    return { days, totalTradingSol, totalExternalSol, complete };
  }
}
