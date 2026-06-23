import type { ClosedPosition } from '@binsight/shared';
import type { Logger } from 'pino';
import type { EnhancedTxGateway, PositionRepository } from '@/domain/ports';
import type { EventBus } from './event-bus';
import { onchainRealizedPnl, reconstructRealized } from './residual-realized';

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
 * One-off, PURELY on-chain recovery of the purged tail: closed positions older than Meteora's ~7-month
 * datapi retention, which it can no longer price. `RealizedPnlEngine` is the single authoritative
 * writer of `market_pnl_sol` for every position it can reach (it recomputes the whole wallet's closed
 * set on each close); this backfill only rebuilds the positions the engine cannot, decoding each
 * position's exact SOL leg from its on-chain DLMM events + the real cash from selling its residual
 * (FIFO over the wallet's actual sells, held remainder booked at 0 — old tokens are worthless cash).
 *
 * It is NOT an automatic path: it runs only when an operator hits `/admin/reconstruct-purged`, and it
 * never marks a residual at a current price (that would fabricate gains for a held bag).
 */
export class ResidualBackfill {
  private running = false;

  constructor(
    private readonly enhanced: EnhancedTxGateway,
    private readonly positionFlow: (address: string) => Promise<PositionFlow>,
    private readonly repo: PositionRepository,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  get isRunning(): boolean {
    return this.running;
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
