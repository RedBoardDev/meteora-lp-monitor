import { type ClosedPosition, type OpenPosition, SOL_MINT } from '@meteora/shared';
import type { Logger } from 'pino';
import type { OnchainValued, OnchainWalletSnapshot } from '@/domain/dlmm';
import type { PositionRepository, TokenMetadataGateway } from '@/domain/ports';
import type { PositionPnl } from './dlmm-position-pnl';
import { buildPositionRows, snapshotToLive, type TokenMetaResolver } from './position-sync';

/** The leg-derived projection source (DlmmPositionPnl, narrowed for testability). */
export interface LegProjectionSource {
  pnlByPosition(wallet: string): Promise<PositionPnl[]>;
  pnlForPositions(positions: string[]): Promise<PositionPnl[]>;
}

type SyncRepo = Pick<
  PositionRepository,
  'replaceOpenForWallet' | 'upsertClosed' | 'getOpen' | 'getStrategies'
>;

const fallbackSymbol = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

/**
 * Reconciles the `positions` table for a wallet entirely from chain — the cutover off Meteora.
 * Two paths so the read/write cost matches what actually changed:
 *   - `sync` (after an INGEST): full reproject of open + closed from the wallet's whole leg history.
 *   - `refreshOpen` (the snapshot CADENCE): only the open positions' live values — loads a handful of
 *     legs and rewrites just the open set, never re-touching the (large, unchanged) closed history.
 * Both write through the EXISTING repository methods so the freeze / set-diff semantics are reused.
 */
export class PositionSync {
  constructor(
    private readonly legPnl: LegProjectionSource,
    private readonly metadata: TokenMetadataGateway,
    private readonly repo: SyncRepo,
    private readonly logger: Logger,
  ) {}

  async sync(
    wallet: string,
    snapshot: OnchainWalletSnapshot,
    valued: OnchainValued,
  ): Promise<{ open: number; closed: number }> {
    const projection = await this.legPnl.pnlByPosition(wallet);
    const { open, closed } = await this.buildRows(wallet, projection, snapshot, valued);
    // Open set first (a position that just closed leaves the open set here and lands in closed below).
    await this.repo.replaceOpenForWallet(wallet, open);
    if (closed.length) await this.repo.upsertClosed(closed);
    this.logger.info(
      { wallet, open: open.length, closed: closed.length },
      'positions reprojected from chain',
    );
    return { open: open.length, closed: closed.length };
  }

  /** Cadence-cheap refresh of just the OPEN positions' live values; never writes the closed history. */
  async refreshOpen(
    wallet: string,
    snapshot: OnchainWalletSnapshot,
    valued: OnchainValued,
  ): Promise<number> {
    const openAddrs = snapshot.positions.map((p) => p.positionAddress);
    const projection = openAddrs.length > 0 ? await this.legPnl.pnlForPositions(openAddrs) : [];
    const { open } = await this.buildRows(wallet, projection, snapshot, valued);
    await this.repo.replaceOpenForWallet(wallet, open);
    return open.length;
  }

  private async buildRows(
    wallet: string,
    projection: PositionPnl[],
    snapshot: OnchainWalletSnapshot,
    valued: OnchainValued,
  ): Promise<{ open: OpenPosition[]; closed: ClosedPosition[] }> {
    const live = snapshotToLive(snapshot.positions, valued);
    const mints = new Set<string>([SOL_MINT]);
    for (const p of projection) mints.add(p.tokenMint);
    const metaMap = await this.metadata.resolve([...mints]);
    const resolver: TokenMetaResolver = (mint) =>
      metaMap.get(mint) ?? { symbol: fallbackSymbol(mint) };
    const strategy = await this.repo.getStrategies();
    const prior = await this.repo.getOpen(wallet);
    const priorOorSince = new Map<string, number | null>();
    for (const o of prior) priorOorSince.set(o.positionAddress, o.outOfRangeSince ?? null);
    return buildPositionRows({
      wallet,
      projection,
      live,
      meta: resolver,
      strategy,
      priorOorSince,
      now: Date.now(),
    });
  }
}
