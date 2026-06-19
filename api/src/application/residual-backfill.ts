import type { ClosedPosition } from '@binsight/shared';
import type { Logger } from 'pino';
import type { EnhancedTxGateway, PositionRepository, PositionsGateway } from '@/domain/ports';
import type { EventBus } from './event-bus';
import { onchainRealizedPnl, realizedPnl, reconstructRealized } from './residual-realized';

/** Exact per-position SOL leg + net residual, decoded from on-chain DLMM events (positionHistory). */
export type PositionFlow = {
  solLegSol: number;
  residualAmount: number;
  residualMint: string;
} | null;

const DAY_MS = 86_400_000;
/** Parallel Enhanced calls for the purged on-chain reconstruction (each retries 429 internally). */
const RECONSTRUCT_CONCURRENCY = 6;

/**
 * Re-marks historical closed positions to their REAL realized PnL. Meteora marks a closed position's
 * leftover non-SOL residual at pool-spot, which OVERSTATES it (selling a large/illiquid bag moves the
 * price down — proven 5–17% on real exits). This backfill instead values each residual at the SOL the
 * wallet REALLY received dumping it on-chain (Helius Enhanced sells + FIFO lot accounting).
 *
 * Any portion NOT matched to a real sell — genuinely still held, or sold in a way we can't attribute
 * (batched multi-token swap, out-of-window, or the wallet independently trades the same token) — is
 * kept at Meteora's close-time pool-spot mark. Crucially it is NEVER marked at a current price: that
 * would re-introduce drift and, for tokens the wallet trades outside the position, fabricate gains
 * (a held bag isn't realized cash). So an unmatched residual just falls back to Meteora's value.
 *
 * Safety: if the sell history came back incomplete (rate-limit / cap), positions older than the
 * oldest fetched sell are LEFT ALONE rather than overwritten from partial data.
 */
export class ResidualBackfill {
  private running = false;

  constructor(
    private readonly gateway: PositionsGateway,
    private readonly enhanced: EnhancedTxGateway,
    private readonly positionFlow: (address: string) => Promise<PositionFlow>,
    private readonly repo: PositionRepository,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(wallet: string, daysBack: number): Promise<{ scanned: number; fixed: number }> {
    if (this.running) return { scanned: 0, fixed: 0 };
    if (!this.enhanced.enabled) {
      this.logger.warn(
        { wallet },
        'residual backfill: skipped (no Helius api-key for Enhanced API)',
      );
      return { scanned: 0, fixed: 0 };
    }
    this.running = true;
    let scanned = 0;
    let fixed = 0;
    let skipped = 0;
    try {
      // 1. Collect every closed position in the window (residual fields come from the Meteora datapi).
      const pools = await this.gateway.listClosedPools(wallet, daysBack);
      const closed: ClosedPosition[] = [];
      for (const pool of pools) {
        const cs = await this.gateway.fetchClosedPositions(wallet, pool).catch(() => []);
        closed.push(...cs);
      }
      const withResidual = closed.filter(
        (c) =>
          (c.residualMarkSol ?? 0) > 0 &&
          (c.residualAmount ?? 0) > 0 &&
          c.residualMint &&
          (c.closedAt ?? 0) > 0,
      );
      scanned = withResidual.length;
      if (withResidual.length === 0) {
        this.logger.info({ wallet }, 'residual backfill: no residual positions to re-mark');
        return { scanned, fixed };
      }

      // 2. Fetch the wallet's real token→SOL sells back to the oldest residual close.
      const oldestClose = Math.min(...withResidual.map((c) => c.closedAt ?? Date.now()));
      const { sells, complete, oldestTs } = await this.enhanced.fetchSells(
        wallet,
        oldestClose - DAY_MS,
      );
      const oldestFetchedMs = oldestTs * 1000;

      // 3. FIFO-attribute each residual to its real sells (no double-counting across positions).
      const realized = reconstructRealized(closed, sells);
      const byAddr = new Map(realized.map((r) => [r.positionAddress, r]));

      // 4. PnL = pnlSol − pool-spot mark + (real sold proceeds). The residual the wallet REALLY dumped
      //    (FIFO, 3-day window) is booked at its actual SOL; the remainder it never sold is booked at
      //    ZERO, not pool-spot. A residual unsold 3 days after close is held/worthless — marking it at
      //    Meteora's close-time pool-spot overstates dead tokens (the wallet view captures the real SOL
      //    if/when it's ever dumped). Realized PnL counts only cash that actually came back.
      for (const c of withResidual) {
        const r = byAddr.get(c.positionAddress);
        if (!r) continue;
        // Incomplete history: trust only positions newer than the oldest sell we actually fetched.
        if (!complete && (c.closedAt ?? 0) < oldestFetchedMs) {
          skipped++;
          continue;
        }
        await this.repo.setAuthoritativePnl(c.positionAddress, realizedPnl(c, r, 0));
        fixed++;
      }

      // 5. Meteora deposit-underreport bug: some positions show deposit≈0 with a real withdrawal, so
      //    Meteora's pnlSol is bogusly inflated (it's missing the cost). Recompute the SOL leg PURELY
      //    on-chain (positionHistory) + the residual real cash. Rare → bounded per-position RPC. This
      //    runs AFTER step 4 so it also overrides any residual-position that has the bug.
      // The SOL leg comes from positionHistory (independent of the sell history), so process these
      // even when the sell fetch was incomplete — the bogus pnlSol must not survive either way.
      let depFixed = 0;
      for (const c of closed) {
        if ((c.depositSol ?? 0) >= 0.01 || (c.withdrawSol ?? 0) <= 0.1) continue;
        const flow = await this.positionFlow(c.positionAddress);
        if (!flow) continue;
        // The SOL leg is exact and self-contained, so we always book it (the bogus pnlSol must not
        // survive). But the residual real-cash comes from the FIFO sell ledger, which is only
        // trustworthy when the sell fetch reached this close: under an incomplete fetch an older
        // position's proceeds are partial, so book the SOL leg ALONE rather than adding partial cash.
        const residTrusted = complete || (c.closedAt ?? 0) >= oldestFetchedMs;
        const residCash = residTrusted ? (byAddr.get(c.positionAddress)?.soldProceeds ?? 0) : 0;
        await this.repo.setAuthoritativePnl(c.positionAddress, flow.solLegSol + residCash);
        depFixed++;
      }

      if (fixed > 0 || depFixed > 0) this.bus.emit('closedChanged', { wallet });
      this.logger.info(
        { wallet, scanned, fixed, depFixed, skipped, sells: sells.length, complete },
        'residual backfill: complete (on-chain real cash)',
      );
    } catch (err) {
      this.logger.error({ err, wallet }, 'residual backfill failed');
    } finally {
      this.running = false;
    }
    return { scanned, fixed };
  }

  /**
   * Rebuild PnL for positions Meteora can't price (older than its ~7-month retention) PURELY from
   * on-chain data: each position's SOL legs (native + WSOL flow over its txs) + the real cash from
   * selling its net residual (FIFO over the wallet's actual sells). No Meteora input at all. Heavy
   * (one Enhanced API pass per position) — a one-off recovery of the purged tail. A still-held
   * remainder is valued at 0 (these are old, typically worthless tokens).
   */
  async reconstructPurged(
    wallet: string,
    opts: { all?: boolean } = {},
  ): Promise<{ scanned: number; fixed: number }> {
    if (this.running) return { scanned: 0, fixed: 0 };
    if (!this.enhanced.enabled) {
      this.logger.warn({ wallet }, 'purged reconstruction: skipped (no Helius api-key)');
      return { scanned: 0, fixed: 0 };
    }
    this.running = true;
    let scanned = 0;
    let fixed = 0;
    try {
      const candidates = await this.repo.onchainCandidates(wallet, opts);
      scanned = candidates.length;
      if (candidates.length === 0) return { scanned, fixed };

      const oldest = Math.min(...candidates.map((c) => c.closedAt));
      const { sells } = await this.enhanced.fetchSells(wallet, oldest - DAY_MS);

      // 1. Decode each position's EXACT SOL leg + net residual from its on-chain DLMM events
      //    (positionHistory — per-position amounts, immune to multi-position-open over-counting).
      //    RPC-bound → a small worker pool, with progress logging on a long run.
      // The SOL leg is EXACT and self-contained per position → write it to the DB IMMEDIATELY as each
      // position is decoded (incremental + crash-resilient: a network drop keeps everything already
      // written). Only the residual real-cash needs the global FIFO, applied as a refinement after.
      const flows = new Map<string, NonNullable<PositionFlow>>();
      const queue = [...candidates];
      let done = 0;
      let failed = 0;
      const worker = async (): Promise<void> => {
        for (let c = queue.pop(); c; c = queue.pop()) {
          try {
            const flow = await this.positionFlow(c.positionAddress);
            if (flow) {
              flows.set(c.positionAddress, flow);
              await this.repo.setAuthoritativePnl(c.positionAddress, flow.solLegSol); // residual added later
              fixed++;
            } else {
              failed++;
            }
          } catch (err) {
            // A single position's RPC failure (ECONNRESET / network blip) must NOT abort the whole
            // run — skip it (keeps its prior value) and keep going. Resumable on a re-run.
            failed++;
            this.logger.debug({ err, pos: c.positionAddress }, 'positionFlow failed — skipping');
          }
          if (++done % 100 === 0) {
            this.logger.info(
              { wallet, done, total: candidates.length, fixed, failed },
              'purged reconstruction: progress',
            );
          }
        }
      };
      await Promise.all(Array.from({ length: RECONSTRUCT_CONCURRENCY }, () => worker()));
      this.logger.info(
        { wallet, decoded: flows.size, failed },
        'purged reconstruction: legs written',
      );

      // FIFO-attribute the residual real cash (shared per-mint sell ledger), then REFINE the rows that
      // have a residual: final PnL = SOL leg + residual real cash (held remainder → 0 for old tokens).
      const pseudo: Pick<
        ClosedPosition,
        'positionAddress' | 'residualMint' | 'residualAmount' | 'residualMarkSol' | 'closedAt'
      >[] = [];
      for (const c of candidates) {
        const flow = flows.get(c.positionAddress);
        if (flow && flow.residualAmount > 0) {
          pseudo.push({
            positionAddress: c.positionAddress,
            residualMint: flow.residualMint,
            residualAmount: flow.residualAmount,
            residualMarkSol: 1, // dummy>0 to pass the reconstructRealized filter; not used on-chain
            closedAt: c.closedAt,
          });
        }
      }
      for (const r of reconstructRealized(pseudo, sells)) {
        const flow = flows.get(r.positionAddress);
        if (!flow) continue;
        await this.repo.setAuthoritativePnl(
          r.positionAddress,
          onchainRealizedPnl(flow.solLegSol, r, 0),
        );
      }
      if (fixed > 0) this.bus.emit('closedChanged', { wallet });
      this.logger.info(
        { wallet, scanned, fixed, failed },
        'purged reconstruction: complete (on-chain)',
      );
    } catch (err) {
      this.logger.error({ err, wallet }, 'purged reconstruction failed');
    } finally {
      this.running = false;
    }
    return { scanned, fixed };
  }
}
