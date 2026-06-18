import type { LiveEvent, OpenPosition, WalletState } from '@meteora/shared';
import type { EventBus } from '@/application/event-bus';
import type { HealthMonitor } from '@/application/health-monitor';
import { buildWalletState, combineOnchain } from '@/application/wallet-state';
import type { OnchainValued } from '@/domain/dlmm';
import type { RpcSubscriber } from '@/domain/ports';
import type { WalletRuntime } from './runtime';

export class StateEmitter {
  private seq = 0;

  constructor(
    private readonly wallets: Map<string, WalletRuntime>,
    private readonly subscriber: RpcSubscriber,
    private readonly bus: EventBus,
    private readonly health: HealthMonitor,
  ) {}

  emitEvent(
    kind: LiveEvent['kind'],
    wallet: string | null,
    p: OpenPosition | null,
    title: string,
    data: LiveEvent['data'],
  ): void {
    this.bus.emit('event', {
      id: `${Date.now()}-${this.seq++}`,
      kind,
      wallet,
      positionAddress: p?.positionAddress ?? null,
      pair: p ? `${p.tokenX}/${p.tokenY}` : null,
      title,
      body: title,
      data,
      createdAt: Date.now(),
    });
  }

  emitState(address: string): void {
    const rt = this.wallets.get(address);
    if (!rt) return;
    this.bus.emit('state', buildWalletState(address, [...rt.open.values()], rt.onchain));
  }

  emitHealth(effectiveRps: number): void {
    const wsOk = this.subscriber.isConnected();
    this.health.set('ws', wsOk ? 'ok' : 'down', wsOk ? undefined : 'disconnected');
    this.bus.emit('health', {
      ok: this.health.ok,
      wsConnected: wsOk,
      meteoraOk: this.health.statusOf('meteora') !== 'down',
      effectiveRps,
      chainTipSlot: this.health.chainTipSlot,
      sources: this.health.list(),
      wallets: [...this.wallets.values()].map((w) => ({
        wallet: w.address,
        wsConnected: this.subscriber.isConnected(),
        lastPollAt: w.lastPollAt || null,
        lastPollOk: w.lastPollOk,
        pollIntervalMs: w.pollIntervalMs,
        syncing: !w.reconciled,
        syncProgress: w.reconciled ? 1 : null,
      })),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  /** Aggregate state across the given wallet addresses (the caller's watchlist), labelled `scope`. */
  getState(wallets: string[], scope: string): WalletState {
    const all: OpenPosition[] = [];
    const onchains: OnchainValued[] = [];
    for (const address of wallets) {
      const rt = this.wallets.get(address);
      if (!rt) continue;
      all.push(...rt.open.values());
      if (rt.onchain) onchains.push(rt.onchain);
    }
    return buildWalletState(scope, all, combineOnchain(onchains));
  }
}
