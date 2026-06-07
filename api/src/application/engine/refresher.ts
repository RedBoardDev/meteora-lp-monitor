import type { OpenPosition } from '@meteora/shared';
import type { Logger } from 'pino';
import type { PoolRef, PositionRepository, PositionsGateway, PriceGateway } from '@/domain/ports';
import { isOutOfRange } from '@/domain/position';
import type { StateEmitter } from './emitter';
import type { WalletRuntime } from './runtime';
import { chunked, symmetricDiffSize } from './utils';

export type RefreshCallbacks = {
  onClosed: (address: string, pools: PoolRef[]) => void;
  onBalance: (address: string) => void;
};

export class PositionRefresher {
  constructor(
    private readonly gateway: PositionsGateway,
    private readonly prices: PriceGateway,
    private readonly repo: PositionRepository,
    private readonly emitter: StateEmitter,
    private readonly logger: Logger,
  ) {}

  async refresh(rt: WalletRuntime, trigger: string, cb: RefreshCallbacks): Promise<boolean> {
    if (rt.refreshing) return false;
    rt.refreshing = true;
    rt.lastPollAt = Date.now();
    const beforeKeys = new Set(rt.open.keys());
    const beforeOpen = rt.open;
    try {
      const pools = await this.gateway.listOpenPools(rt.address);
      rt.pools = pools;
      const lists = await chunked(pools, (p) =>
        this.gateway.fetchOpenPositions(rt.address, p).catch(() => []),
      );
      const now = Date.now();
      const next = new Map<string, OpenPosition>();
      for (const p of lists.flat()) {
        next.set(p.positionAddress, this.carryOorState(p, rt.open.get(p.positionAddress), now));
      }

      await this.repriceAtMarket([...next.values()]);
      this.detectTransitions(rt, beforeKeys, beforeOpen, next);

      rt.open = next;
      this.repo.replaceOpenForWallet(rt.address, [...next.values()]);

      const closedNow = [...beforeKeys].filter((k) => !next.has(k));
      if (closedNow.length > 0 || trigger.startsWith('ws:close')) {
        const poolsToScan = new Map(rt.pools.map((p) => [p.poolAddress, p] as const));
        for (const k of closedNow) {
          const prev = beforeOpen.get(k);
          if (prev) {
            // Capital is returning to idle; credit it now (RPC balance lags the withdrawal).
            rt.pendingDelta += prev.sizeSol;
            rt.pendingSince = Date.now();
            poolsToScan.set(prev.poolAddress, {
              poolAddress: prev.poolAddress,
              tokenX: prev.tokenX,
              tokenY: prev.tokenY,
              tokenXMint: prev.tokenXMint,
              tokenYMint: '',
            });
          }
        }
        cb.onClosed(rt.address, [...poolsToScan.values()]);
      }

      rt.lastPollOk = true;
      const changed = symmetricDiffSize(beforeKeys, new Set(next.keys())) > 0;
      if (changed) cb.onBalance(rt.address);
      this.emitter.emitState(rt.address);
      return changed || trigger === 'reconcile';
    } catch (err) {
      rt.lastPollOk = false;
      this.logger.warn({ err, address: rt.address, trigger }, 'refresh failed — keeping last good data');
      return false;
    } finally {
      rt.refreshing = false;
    }
  }

  private carryOorState(
    p: OpenPosition,
    prev: OpenPosition | undefined,
    now: number,
  ): OpenPosition {
    const out = isOutOfRange(p.rangeStatus);
    let since = prev?.outOfRangeSince ?? null;
    if (out && since == null) since = now;
    if (!out) since = null;
    return { ...p, outOfRangeSince: since, updatedAt: now };
  }

  private async repriceAtMarket(positions: OpenPosition[]): Promise<void> {
    const targets = positions.filter((p) => p.holdMint && (p.holdAmount ?? 0) > 0);
    if (targets.length === 0) return;
    const priceMap = await this.prices.getPricesSol(targets.map((p) => p.holdMint as string));
    for (const p of targets) {
      const price = priceMap.get(p.holdMint as string);
      if (price == null) continue;
      const deposit = p.sizeSol - p.pnlSol;
      const delta = (p.holdAmount as number) * price - (p.holdMarkSol ?? 0);
      p.sizeSol += delta;
      p.pnlSol += delta;
      p.pnlPctSol = deposit > 0 ? (p.pnlSol / deposit) * 100 : p.pnlPctSol;
    }
  }

  private detectTransitions(
    rt: WalletRuntime,
    beforeKeys: Set<string>,
    beforeOpen: Map<string, OpenPosition>,
    next: Map<string, OpenPosition>,
  ): void {
    for (const [addr, p] of next) {
      if (!beforeKeys.has(addr)) {
        // Capital just moved idle → this position; reflect it immediately so the wallet total
        // doesn't transiently double-count while the RPC balance catches up.
        rt.pendingDelta -= p.sizeSol;
        rt.pendingSince = Date.now();
        this.emitter.emitEvent('position_open', p.wallet, p, `${p.tokenX}/${p.tokenY} opened`, {
          sizeSol: p.sizeSol,
        });
      } else {
        const prev = beforeOpen.get(addr);
        if (prev && prev.rangeStatus !== p.rangeStatus) {
          if (isOutOfRange(p.rangeStatus)) {
            this.emitter.emitEvent(
              'oor_enter',
              p.wallet,
              p,
              `${p.tokenX}/${p.tokenY} out of range`,
              { side: p.rangeStatus === 'out_up' ? 'up' : 'down', price: p.poolPrice },
            );
          } else if (isOutOfRange(prev.rangeStatus)) {
            this.emitter.emitEvent('oor_return', p.wallet, p, `${p.tokenX}/${p.tokenY} back in range`, {});
          }
        }
      }
    }
  }
}
