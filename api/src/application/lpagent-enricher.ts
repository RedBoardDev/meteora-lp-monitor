import type { ClosedPosition } from '@meteora/shared';
import type { Logger } from 'pino';
import type { PositionRepository } from '@/domain/ports';
import type { LpAgentClosed, LpAgentGateway } from '@/infrastructure/lpagent/lpagent-gateway';
import type { EventBus } from './event-bus';

const LIVE_PRIORITY = 10;
const RECONCILE_PRIORITY = 0;
const INITIAL_DELAY_MS = 8_000; // let LPAgent index the close before the first lookup
const MAX_ATTEMPTS = 6; // each attempt is further spaced by the queue's ~12s slot
const RETRY_GAP_MS = 5_000;
const NOTIFY_MAX_AGE_MS = 900_000; // don't alert on closes older than this (reconcile/boot replay)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Closed-PnL is authoritative from LPAgent (residual valued at market). On a freshly detected
 * close we fetch LPAgent's value — retrying through its index lag — persist it, then fire the
 * notification with that value. The Meteora value (already stored by the engine) is the fallback
 * if LPAgent is disabled or never returns. A slow, low-priority pass backfills history.
 */
export class LpAgentEnricher {
  private readonly notified = new Set<string>();

  constructor(
    private readonly gateway: LpAgentGateway,
    private readonly repo: PositionRepository,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  /** Seed already-known closes so a restart never re-alerts them. */
  start(): void {
    for (const a of this.repo.closedAddresses()) this.notified.add(a);
  }

  /** A newly detected close. Deduped and bounded by age; notification waits for LPAgent. */
  onClose(closed: ClosedPosition): void {
    const addr = closed.positionAddress;
    if (this.notified.has(addr)) return;
    this.notified.add(addr);
    if (closed.closedAt != null && Date.now() - closed.closedAt > NOTIFY_MAX_AGE_MS) return; // history
    void this.resolveAndNotify(closed);
  }

  private async resolveAndNotify(closed: ClosedPosition): Promise<void> {
    const value = this.gateway.enabled ? await this.fetchWithRetry(closed) : null;
    if (value != null) {
      this.repo.setAuthoritativePnl(closed.positionAddress, value.pnlSol);
      this.bus.emit('closedChanged', { wallet: closed.wallet });
      this.bus.emit('closed', { ...closed, pnlSol: value.pnlSol, feesSol: value.feesSol });
    } else {
      this.bus.emit('closed', closed); // LPAgent off / never indexed → Meteora fallback value
    }
  }

  private async fetchWithRetry(closed: ClosedPosition): Promise<LpAgentClosed | null> {
    await sleep(INITIAL_DELAY_MS);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const { rows } = await this.gateway.fetchHistoricalPage(closed.wallet, 1, LIVE_PRIORITY);
        const hit = rows.find((r) => r.positionAddress === closed.positionAddress);
        if (hit) return hit;
      } catch (err) {
        this.logger.warn({ err, pos: closed.positionAddress }, 'LPAgent fetch failed (will retry)');
      }
      await sleep(RETRY_GAP_MS);
    }
    this.logger.warn(
      { pos: closed.positionAddress },
      'LPAgent never indexed close in time — keeping Meteora value',
    );
    return null;
  }

  /**
   * Low-priority history backfill: page an owner's closed history (newest first), writing LPAgent
   * PnL onto our rows. Bounded by `floorMs` (the HISTORY_SINCE / HISTORY_DAYS floor) — LPAgent
   * keeps far more history than our window, so we stop once a page's newest close predates the
   * floor, or once every local close is matched. Avoids paging thousands of irrelevant pages.
   */
  async reconcile(owner: string, floorMs: number): Promise<void> {
    if (!this.gateway.enabled) {
      this.logger.info({ owner }, 'LPAgent reconcile: skipped (no LPAGENT_API_KEY set)');
      return;
    }
    const remaining = new Set(this.repo.closedAddresses());
    const total = remaining.size;
    if (total === 0) {
      this.logger.info({ owner }, 'LPAgent reconcile: nothing to enrich (no closed positions)');
      return;
    }
    this.logger.info({ owner, total }, `LPAgent reconcile: starting — ${total} closes to enrich`);
    let page = 1;
    let totalPages = 1;
    let reachedFloor = false;
    do {
      try {
        const res = await this.gateway.fetchHistoricalPage(owner, page, RECONCILE_PRIORITY);
        totalPages = res.totalPages;
        let newestOnPage = 0;
        let matched = 0;
        for (const r of res.rows) {
          if (remaining.has(r.positionAddress)) {
            this.repo.setAuthoritativePnl(r.positionAddress, r.pnlSol);
            remaining.delete(r.positionAddress);
            matched++;
          }
          if (r.closedAt != null && r.closedAt > newestOnPage) newestOnPage = r.closedAt;
        }
        // Pages are newest-first: once even the newest close on a page predates the floor, the
        // rest of history is older too — stop.
        reachedFloor = newestOnPage > 0 && newestOnPage < floorMs;
        const done = total - remaining.size;
        const pct = Math.round((done / total) * 100);
        this.logger.info(
          { owner, page, done, total, pct },
          `LPAgent reconcile: ${done}/${total} enriched (${pct}%) — page ${page}`,
        );
        if (matched > 0) this.bus.emit('closedChanged', { wallet: owner });
      } catch (err) {
        this.logger.warn({ err, owner, page }, 'LPAgent reconcile: page failed, retrying later');
      }
      page++;
    } while (page <= totalPages && remaining.size > 0 && !reachedFloor);
    const done = total - remaining.size;
    this.logger.info(
      { owner, done, total, unmatched: remaining.size },
      `LPAgent reconcile: done — ${done}/${total} enriched${remaining.size > 0 ? `, ${remaining.size} not on LPAgent (kept Meteora value)` : ''}`,
    );
  }
}
