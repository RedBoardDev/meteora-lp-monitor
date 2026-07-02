import type { Health, LiveEvent, OpenPosition, WalletState } from '@binsight/shared';
import type { EventBus } from '@/application/event-bus';
import type { HealthMonitor } from '@/application/health-monitor';
import { buildWalletState, combineOnchain } from '@/application/wallet-state';
import type { OnchainValued } from '@/domain/dlmm';
import type { RpcSubscriber } from '@/domain/ports';
import type { WalletRuntime } from './runtime';

export class StateEmitter {
  private seq = 0;
  // Change signature of the last health frame we broadcast (excludes the monotonic uptime). The engine
  // computes health every 1s tick; the WS layer re-sorts/filters/stringifies it per distinct watched-set
  // on EVERY emit → O(users × wallets) work. Skipping the emit when nothing a client renders changed
  // removes that idle-per-second churn while still emitting the instant a real field changes.
  private lastHealthSig: string | null = null;
  // Last effectiveRps seen by emitHealth — so a fresh WS client can be handed the CURRENT health on
  // connect (emit-on-change means it wouldn't otherwise get a frame until the next real change).
  private lastEffectiveRps = 0;

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

  /** Build the CURRENT health payload without emitting or touching the emit-on-change dedup state — the
   *  single source of truth for the frame shape. Used by emitHealth and by the WS layer to hand a fresh
   *  client the live health on connect. Defaults to the last effectiveRps seen by the 1s tick. */
  snapshotHealth(effectiveRps: number = this.lastEffectiveRps): Health {
    const wsOk = this.subscriber.isConnected();
    return {
      ok: this.health.ok,
      wsConnected: wsOk,
      meteoraOk: this.health.statusOf('meteora') !== 'down',
      effectiveRps,
      chainTipSlot: this.health.chainTipSlot,
      sources: this.health.list(),
      wallets: [...this.wallets.values()].map((w) => ({
        wallet: w.address,
        wsConnected: wsOk,
        lastPollAt: w.lastPollAt || null,
        lastPollOk: w.lastPollOk,
        pollIntervalMs: w.pollIntervalMs,
        syncing: !w.reconciled,
        syncProgress: w.reconciled ? 1 : null,
      })),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  emitHealth(effectiveRps: number): void {
    this.lastEffectiveRps = effectiveRps;
    const wsOk = this.subscriber.isConnected();
    this.health.set('ws', wsOk ? 'ok' : 'down', wsOk ? undefined : 'disconnected');
    const payload = this.snapshotHealth(effectiveRps);
    // Emit-on-change: uptimeSeconds ticks every second and would defeat the dedup, so it's excluded from
    // the change signature (it refreshes on the next real change). Any status / rps / chain-tip / wallet
    // change still emits immediately — freshness is preserved, only the idle re-broadcast is dropped.
    const { uptimeSeconds: _uptimeSeconds, ...changing } = payload;
    const sig = JSON.stringify(changing);
    if (sig === this.lastHealthSig) return;
    this.lastHealthSig = sig;
    this.bus.emit('health', payload);
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
