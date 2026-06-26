import type { StrategyFamily } from '@binsight/shared';
import type { Logger } from 'pino';
import type { PositionRepository, StrategyResolver } from '@/domain/ports';
import { sleep } from '@/util/sleep';

const BACKFILL_PAUSE_MS = 400; // gentle pacing for the historical backfill (~2-3 positions/s of RPC)

/**
 * Resolves each position's strategy family (Spot/Curve/BidAsk) ONCE from its on-chain open tx, caches
 * it in memory and persists it (so it survives restarts and travels with the position into closed
 * history). `get()` is synchronous for the hot path: it returns the cached value and kicks off a
 * one-time background resolution for positions it hasn't seen.
 */
export class StrategyService {
  private readonly cache: Map<string, StrategyFamily>;
  private readonly attempted = new Set<string>();
  private backfilling = false;

  constructor(
    private readonly resolver: StrategyResolver,
    private readonly repo: PositionRepository,
    private readonly logger: Logger,
  ) {
    this.cache = new Map();
  }

  /** Warm the in-memory strategy cache from persisted families. Call once before serving. */
  async init(): Promise<void> {
    for (const [addr, family] of await this.repo.getStrategies()) this.cache.set(addr, family);
  }

  get(positionAddress: string): StrategyFamily | null {
    const cached = this.cache.get(positionAddress);
    if (cached) return cached;
    if (!this.attempted.has(positionAddress)) void this.resolve(positionAddress);
    return null;
  }

  /**
   * Resolve strategy for OPEN positions still missing it (the repo now returns open-only) — so the live
   * card/badge gets its Spot/Curve/BidAsk tag even when the burst one-shot live resolution lost to RPC
   * limits. Closed positions are NOT bulk-backfilled: re-paging tens of thousands of closed positions'
   * open txs (getParsedTransaction) burned millions of credits for a label on already-closed rows. A
   * position resolved while open keeps its strategy into closed history; old closed rows show no badge.
   * Bounded per run and paced so it never hammers the RPC; safe on a schedule.
   */
  async backfill(maxPerRun = 60): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      const candidates = await this.repo.addressesMissingStrategy(maxPerRun * 4);
      const todo = candidates
        .filter((a) => !this.cache.has(a) && !this.attempted.has(a))
        .slice(0, maxPerRun);
      for (const addr of todo) {
        await this.resolve(addr);
        await sleep(BACKFILL_PAUSE_MS);
      }
      if (todo.length > 0)
        this.logger.info({ resolved: todo.length }, 'strategy backfill pass done');
    } finally {
      this.backfilling = false;
    }
  }

  private async resolve(positionAddress: string): Promise<void> {
    this.attempted.add(positionAddress);
    try {
      const family = await this.resolver.resolve(positionAddress);
      if (family) {
        this.cache.set(positionAddress, family);
        await this.repo.setStrategy(positionAddress, family);
      }
    } catch (err) {
      this.attempted.delete(positionAddress); // transient failure — let a later poll retry
      this.logger.debug({ err, positionAddress }, 'strategy resolution failed (will retry)');
    }
  }
}
