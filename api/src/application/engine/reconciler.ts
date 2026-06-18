import type { Logger } from 'pino';
import type { EventBus } from '@/application/event-bus';
import type { PoolRef, PositionRepository, PositionsGateway } from '@/domain/ports';
import type { WalletRuntime } from './runtime';
import { chunked } from './utils';

const RECENT_CLOSED_DAYS = 2;

export type ReconcileCallbacks = {
  doRefresh: (rt: WalletRuntime) => Promise<boolean>;
  doBalance: (rt: WalletRuntime) => void;
};

export class Reconciler {
  constructor(
    private readonly gateway: PositionsGateway,
    private readonly repo: PositionRepository,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  /** Full, idempotent reconciliation: catch anything opened AND closed while we were down. */
  async reconcile(rt: WalletRuntime, historyDays: number, cb: ReconcileCallbacks): Promise<void> {
    try {
      const closedPools = await this.gateway.listClosedPools(rt.address, historyDays);
      const closedLists = await chunked(closedPools, (p) =>
        this.gateway.fetchClosedPositions(rt.address, p).catch(() => []),
      );
      const closed = closedLists.flat();
      if (closed.length) {
        await this.repo.upsertClosed(closed);
        // Notify clients watching this wallet so the closed-history view refetches once the
        // initial backfill lands (otherwise it stays empty until a manual refresh).
        this.bus.emit('closedChanged', { wallet: rt.address });
      }

      await cb.doRefresh(rt);
      cb.doBalance(rt);

      rt.reconciled = true;
      this.logger.info({ address: rt.address, closed: closed.length }, 'reconciliation complete');
    } catch (err) {
      this.logger.error(
        { err, address: rt.address },
        'reconciliation failed — will retry on next poll',
      );
    }
  }

  async captureClosed(address: string, pools: PoolRef[]): Promise<void> {
    try {
      const lists = await chunked(pools, (p) =>
        this.gateway.fetchClosedPositions(address, p).catch(() => []),
      );
      const closed = lists.flat();
      if (!closed.length) return;
      await this.repo.upsertClosed(closed);
      // Show the close in history immediately; the on-chain DLMM engine sets the authoritative PnL.
      this.bus.emit('closedChanged', { wallet: address });
    } catch (err) {
      this.logger.warn({ err, address }, 'captureClosed failed (poll will retry)');
    }
  }

  /** Periodic safety net: catch positions opened and closed between two polls. */
  async resyncClosed(rt: WalletRuntime): Promise<void> {
    rt.lastClosedSyncAt = Date.now();
    try {
      const pools = await this.gateway.listClosedPools(rt.address, RECENT_CLOSED_DAYS);
      const lists = await chunked(pools, (p) =>
        this.gateway.fetchClosedPositions(rt.address, p).catch(() => []),
      );
      const closed = lists.flat();
      if (closed.length) {
        await this.repo.upsertClosed(closed);
      }

      // Resolve positions stuck in 'pending_close' — catches closes older than the window.
      const pendingPools = await this.repo.pendingClosePools(rt.address);
      if (pendingPools.length > 0) {
        this.logger.warn(
          { address: rt.address, pendingClose: pendingPools.length },
          'resolving pending_close',
        );
        const stuck = await chunked(pendingPools, (p) =>
          this.gateway.fetchClosedPositions(rt.address, p).catch(() => []),
        );
        const stuckClosed = stuck.flat();
        if (stuckClosed.length) {
          await this.repo.upsertClosed(stuckClosed);
        }
      }
    } catch (err) {
      this.logger.warn({ err, address: rt.address }, 'closed resync failed (will retry)');
    }
  }
}
