import type { Health, LiveEvent, OpenPosition, WalletState } from '@binsight/shared';
import type { EventBus } from '@/application/event-bus';
import type { HealthMonitor } from '@/application/health-monitor';
import { buildWalletState, combineOnchain } from '@/application/wallet-state';
import type { OnchainValued } from '@/domain/dlmm';
import type { RpcSubscriber } from '@/domain/ports';
import type { WalletRuntime } from './runtime';

/**
 * Stable change signature of a health frame for the emit-on-change dedup. Projects ONLY the fields a
 * client renders as state; every field that advances without a client-visible state change is dropped so
 * it can't defeat the dedup and re-introduce the O(users × wallets) per-second churn:
 *   - `uptimeSeconds` — monotonic, ticks every second.
 *   - `sources[].lastOkAt` / `lastErrorAt` — raw `Date.now()` timestamps; emitHealth calls
 *     `health.set('ws','ok')` on every tick, which bumps `lastOkAt` each call → they'd change every tick.
 * `sources[].status` / `detail` / `consecutiveErrors` (real service transitions) and every wallet field
 * (`lastPollAt` only moves on an actual poll) ARE client-meaningful and stay in the signature.
 */
function healthChangeSignature(payload: Health): string {
  return JSON.stringify({
    ok: payload.ok,
    wsConnected: payload.wsConnected,
    meteoraOk: payload.meteoraOk,
    effectiveRps: payload.effectiveRps,
    chainTipSlot: payload.chainTipSlot,
    sources: payload.sources.map((s) => ({
      name: s.name,
      status: s.status,
      detail: s.detail,
      consecutiveErrors: s.consecutiveErrors,
    })),
    wallets: payload.wallets,
  });
}

export class StateEmitter {
  private seq = 0;
  // Change signature of the last health frame we broadcast (see healthChangeSignature: it projects only
  // client-rendered state, dropping volatile fields like uptime and source timestamps). The engine
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
    // Emit-on-change: the signature is a stable projection (healthChangeSignature) that excludes volatile
    // fields (uptime + source timestamps) which advance every tick and would defeat the dedup. Any real
    // status / rps / chain-tip / wallet change still emits immediately — the full payload is unchanged.
    const sig = healthChangeSignature(payload);
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
