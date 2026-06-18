import type { Logger } from 'pino';
import type { LoadedPoolMeta, StoredLeg } from '@/domain/dlmm';
import { positionEconomics } from '@/domain/dlmm-pnl';
import type { LegRepository, PoolMetaReader } from '@/domain/ports';

export interface PositionPnl {
  position: string;
  pool: string;
  /** mark-to-pool realized PnL in SOL (LPAgent-style), reconstructed fully on-chain. 0 if !solDenominated. */
  pnlSol: number;
  /** Σ deposit legs in SOL — the cost basis (0 if !solDenominated). */
  depositSol: number;
  /** Σ withdraw legs in SOL (0 if !solDenominated). */
  withdrawSol: number;
  /** Σ claim legs in SOL — realized fees (0 if !solDenominated). */
  claimedFeesSol: number;
  legs: number;
  /** the non-SOL token mint (for display/sync into the positions table). */
  tokenMint: string;
  /** false for a non-SOL-quote pool: SOL economics are 0 and the position is surfaced flagged, never dropped. */
  solDenominated: boolean;
  /** epoch ms of the first on-chain event (open). */
  openedAt: number;
  /** epoch ms of the last on-chain leg. The real close iff the live snapshot no longer holds this position. */
  closedAt: number;
  /** closedAt − openedAt, in seconds. */
  durationSeconds: number;
}

/**
 * Computes per-position mark-to-pool PnL from the ingested on-chain legs — the "Positions" view,
 * fully decoupled from Meteora and covering all history (incl. the positions Meteora purges).
 * Pool metadata (binStep/SOL side) is loaded once per pool and cached.
 */
export class DlmmPositionPnl {
  private readonly poolCache = new Map<string, LoadedPoolMeta | null>();

  constructor(
    private readonly repo: LegRepository,
    private readonly poolReader: PoolMetaReader,
    private readonly logger: Logger,
  ) {}

  private async poolMeta(pool: string): Promise<LoadedPoolMeta | null> {
    const hit = this.poolCache.get(pool);
    if (hit !== undefined) return hit;
    let meta: LoadedPoolMeta | null = null;
    try {
      meta = await this.poolReader.loadPoolMeta(pool);
    } catch (err) {
      this.logger.debug({ err, pool }, 'loadPoolMeta failed');
    }
    this.poolCache.set(pool, meta);
    // Persist immutable metadata so the next boot batch-reads it instead of re-fetching from chain.
    if (meta) await this.repo.putPoolMeta(pool, meta).catch(() => undefined);
    return meta;
  }

  async pnlByPosition(wallet: string): Promise<PositionPnl[]> {
    return this.project(await this.repo.legsByWallet(wallet), wallet);
  }

  /** Project a SUBSET of positions (the live open set) — the cheap cadence-refresh path that loads only
   *  those positions' legs, never the wallet's whole history. */
  async pnlForPositions(positions: string[]): Promise<PositionPnl[]> {
    return this.project(await this.repo.legsByPositions(positions));
  }

  /** Group legs by position and value each (mark-to-pool economics + non-SOL flag). Pool metadata is
   *  warmed from the persistent cache in one query so a reboot doesn't re-read every LbPair from chain. */
  private async project(legs: StoredLeg[], wallet = ''): Promise<PositionPnl[]> {
    const byPos = new Map<string, StoredLeg[]>();
    for (const l of legs) {
      const arr = byPos.get(l.position);
      if (arr) arr.push(l);
      else byPos.set(l.position, [l]);
    }
    const pools = [...new Set([...byPos.values()].map((plegs) => plegs[0]!.lbPair))];
    for (const [pool, meta] of await this.repo.getPoolMetas(pools)) this.poolCache.set(pool, meta);

    const out: PositionPnl[] = [];
    let failed = 0;
    for (const [position, plegs] of byPos) {
      const pool = plegs[0]!.lbPair;
      const meta = await this.poolMeta(pool);
      if (!meta) {
        // Genuine load failure (missing/undecodable LbPair account) — surfaced loudly below, never silent.
        failed++;
        continue;
      }
      const times = plegs.map((l) => l.blockTime ?? 0).filter((t) => t > 0);
      const openedAt = times.length ? Math.min(...times) * 1000 : 0;
      const closedAt = times.length ? Math.max(...times) * 1000 : 0;
      const durationSeconds = openedAt && closedAt ? Math.round((closedAt - openedAt) / 1000) : 0;
      if (!meta.solSide) {
        // Non-SOL-quote pool: a SOL valuation needs a quote/SOL price series we don't reconstruct here, so we
        // surface the position FLAGGED with zeroed SOL economics — it must never vanish (zero-loss mandate).
        out.push({
          position,
          pool,
          pnlSol: 0,
          depositSol: 0,
          withdrawSol: 0,
          claimedFeesSol: 0,
          legs: plegs.length,
          tokenMint: meta.mintX,
          solDenominated: false,
          openedAt,
          closedAt,
          durationSeconds,
        });
        continue;
      }
      const econ = positionEconomics(plegs, { binStep: meta.binStep, solSide: meta.solSide });
      out.push({
        position,
        pool,
        pnlSol: econ.pnlSol,
        depositSol: econ.depositSol,
        withdrawSol: econ.withdrawSol,
        claimedFeesSol: econ.claimedFeesSol,
        legs: plegs.length,
        tokenMint: meta.solSide === 'Y' ? meta.mintX : meta.mintY,
        solDenominated: true,
        openedAt,
        closedAt,
        durationSeconds,
      });
    }
    if (failed)
      this.logger.warn({ wallet, failed }, 'projection: pools failed to load — positions skipped');
    return out;
  }
}
