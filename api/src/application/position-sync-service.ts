import { type ClosedPosition, type OpenPosition, SOL_MINT } from '@binsight/shared';
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
  ): Promise<{
    open: number;
    closed: number;
    closedRows: ClosedPosition[];
    openPositions: OpenPosition[];
  }> {
    const projection = await this.legPnl.pnlByPosition(wallet);
    const { open, closed, priorOpenAddrs } = await this.buildRows(
      wallet,
      projection,
      snapshot,
      valued,
    );
    // Genuinely newly-closed = a closed row whose address was OPEN in the persisted set just before this
    // sync (an open→closed transition in the positions table). This diff is the notification trigger:
    //  - it can't spam the historical backfill — on a wallet's first sync the persisted open set is empty,
    //    so no historical close (none were ever persisted as open here) is flagged as newly-closed;
    //  - it can't duplicate — `replaceOpenForWallet` below drops the closed address from the persisted
    //    open set, so the SAME position is no longer in `priorOpenAddrs` on the next sync.
    const closedRows = closed.filter((c) => priorOpenAddrs.has(c.positionAddress));
    // Open set first (a position that just closed leaves the open set here and lands in closed below).
    await this.repo.replaceOpenForWallet(wallet, open);
    if (closed.length) await this.repo.upsertClosed(closed);
    this.logger.info(
      { wallet, open: open.length, closed: closed.length, newlyClosed: closedRows.length },
      'positions reprojected from chain',
    );
    return { open: open.length, closed: closed.length, closedRows, openPositions: open };
  }

  /** Cadence-cheap refresh of just the OPEN positions' live values; never writes the closed history. */
  async refreshOpen(
    wallet: string,
    snapshot: OnchainWalletSnapshot,
    valued: OnchainValued,
  ): Promise<OpenPosition[]> {
    const openAddrs = snapshot.positions.map((p) => p.positionAddress);
    const projection = openAddrs.length > 0 ? await this.legPnl.pnlForPositions(openAddrs) : [];
    const { open } = await this.buildRows(wallet, projection, snapshot, valued);
    await this.repo.replaceOpenForWallet(wallet, open);
    return open;
  }

  private async buildRows(
    wallet: string,
    projection: PositionPnl[],
    snapshot: OnchainWalletSnapshot,
    valued: OnchainValued,
  ): Promise<{ open: OpenPosition[]; closed: ClosedPosition[]; priorOpenAddrs: Set<string> }> {
    const live = snapshotToLive(snapshot.positions, valued);
    const mints = new Set<string>([SOL_MINT]);
    for (const p of projection) mints.add(p.tokenMint);
    const metaMap = await this.metadata.resolve([...mints]);
    const resolver: TokenMetaResolver = (mint) =>
      metaMap.get(mint) ?? { symbol: fallbackSymbol(mint) };
    const strategy = await this.repo.getStrategies(wallet); // scoped: only this wallet's positions
    // The persisted open set right before this sync — the source of truth for open→closed transitions
    // (in on-chain mode `rt.open` is frozen at registration and never refreshed, so it can't be used).
    const prior = await this.repo.getOpen(wallet);
    const priorOpenAddrs = new Set<string>();
    const priorOorSince = new Map<string, number | null>();
    for (const o of prior) {
      priorOpenAddrs.add(o.positionAddress);
      priorOorSince.set(o.positionAddress, o.outOfRangeSince ?? null);
    }
    const rows = buildPositionRows({
      wallet,
      projection,
      live,
      meta: resolver,
      strategy,
      priorOorSince,
      now: Date.now(),
    });
    return { ...rows, priorOpenAddrs };
  }
}
