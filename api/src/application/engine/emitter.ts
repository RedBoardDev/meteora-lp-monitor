import type { LiveEvent, OpenPosition, WalletState } from '@meteora/shared';
import type { RpcSubscriber } from '@/domain/ports';
import type { EventBus } from '@/application/event-bus';
import { buildWalletState } from '@/application/wallet-state';
import { currentIdle } from './balance';
import type { WalletRuntime } from './runtime';

export class StateEmitter {
  private seq = 0;

  constructor(
    private readonly wallets: Map<string, WalletRuntime>,
    private readonly subscriber: RpcSubscriber,
    private readonly bus: EventBus,
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
    this.bus.emit('state', buildWalletState(address, [...rt.open.values()], currentIdle(rt)));
  }

  emitHealth(effectiveRps: number): void {
    this.bus.emit('health', {
      ok: this.subscriber.isConnected(),
      wsConnected: this.subscriber.isConnected(),
      meteoraOk: [...this.wallets.values()].every((w) => w.lastPollOk || w.lastPollAt === 0),
      effectiveRps,
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

  getState(scope: string): WalletState {
    if (scope === 'all') return this.aggregateState();
    const rt = this.wallets.get(scope);
    return buildWalletState(scope, rt ? [...rt.open.values()] : [], rt ? currentIdle(rt) : 0);
  }

  private aggregateState(): WalletState {
    const all: OpenPosition[] = [];
    let idle = 0;
    for (const rt of this.wallets.values()) {
      all.push(...rt.open.values());
      idle += currentIdle(rt);
    }
    return buildWalletState('all', all, idle);
  }
}
