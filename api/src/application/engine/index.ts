import { WALLET_BALANCE_REFRESH_MS, type WalletState } from '@meteora/shared';
import type { Logger } from 'pino';
import type { EventBus } from '@/application/event-bus';
import type { LpAgentEnricher } from '@/application/lpagent-enricher';
import type { AppConfig } from '@/config/env';
import type {
  BalanceGateway,
  ConfigRepository,
  PositionRepository,
  PositionsGateway,
  PriceGateway,
  RpcSubscriber,
} from '@/domain/ports';
import { classifyInstruction } from '@/infrastructure/solana/helius-subscriber';
import { refreshBalance } from './balance';
import { StateEmitter } from './emitter';
import { Reconciler } from './reconciler';
import { PositionRefresher } from './refresher';
import { makeRuntime, type WalletRuntime } from './runtime';
import { clamp } from './utils';

const INITIAL_LAG_MS = 1500;
const RETRY_DELAYS_MS = [2000, 2500];
const CLOSED_RESYNC_MS = 90_000;

export class Engine {
  private readonly wallets = new Map<string, WalletRuntime>();
  private readonly emitter: StateEmitter;
  private readonly refresher: PositionRefresher;
  private readonly reconciler: Reconciler;
  private tick: NodeJS.Timeout | null = null;
  private effectiveRps = 0;

  constructor(
    gateway: PositionsGateway,
    prices: PriceGateway,
    private readonly subscriber: RpcSubscriber,
    private readonly balances: BalanceGateway,
    private readonly repo: PositionRepository,
    private readonly config: ConfigRepository,
    bus: EventBus,
    private readonly enricher: LpAgentEnricher,
    private readonly logger: Logger,
    private readonly appConfig: AppConfig,
  ) {
    this.emitter = new StateEmitter(this.wallets, subscriber, bus);
    this.refresher = new PositionRefresher(gateway, prices, repo, this.emitter, logger);
    this.reconciler = new Reconciler(gateway, repo, enricher, bus, logger);
  }

  async start(): Promise<void> {
    this.subscriber.onReconnect(() => this.pollAllNow('ws-reconnect'));
    this.subscriber.onConnectionChange((c) =>
      this.logger.debug({ connected: c }, 'Solana WS connection changed'),
    );
    this.subscriber.start();
    this.enricher.start();

    for (const w of this.config.listWallets()) this.registerWallet(w.address);

    const floorMs = this.appConfig.HISTORY_SINCE
      ? Date.parse(this.appConfig.HISTORY_SINCE)
      : Date.now() - this.appConfig.historyDays * 86_400_000;

    for (const [address, rt] of this.wallets) {
      // LPAgent backfill must run AFTER Meteora full sync — otherwise it reads an empty set.
      void this.doReconcile(rt).then(() => this.enricher.reconcile(address, floorMs));
    }

    this.tick = setInterval(() => this.onTick(), 1000);
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    this.subscriber.stop();
  }

  addWallet(address: string): void {
    if (this.wallets.has(address)) return;
    this.registerWallet(address);
    void this.doReconcile(this.wallets.get(address)!);
  }

  removeWallet(address: string): void {
    this.subscriber.unwatch(address);
    this.wallets.delete(address);
  }

  getState(scope: string): WalletState {
    return this.emitter.getState(scope);
  }

  private registerWallet(address: string): void {
    const rt = makeRuntime(address, this.repo.getOpen(address));
    this.wallets.set(address, rt);
    this.subscriber.watch(address, (_sig, instr) => this.onWsActivity(address, instr));
  }

  private onTick(): void {
    let totalPools = 0;
    for (const rt of this.wallets.values()) totalPools += Math.max(rt.pools.length, 1);
    const settings = this.config.getSettings();
    let rps = 0;

    for (const rt of this.wallets.values()) {
      const hasOpen = rt.open.size > 0;
      const perPoolMs = (totalPools / settings.meteoraTargetRps) * 1000;
      const interval = hasOpen
        ? clamp(perPoolMs * Math.max(rt.pools.length, 1), settings.pollMinMs, settings.pollMaxMs)
        : settings.pollIdleMs;
      rt.pollIntervalMs = interval;

      if (!rt.refreshing && Date.now() - rt.lastPollAt >= interval) void this.doRefresh(rt, 'poll');
      if (Date.now() - rt.lastBalanceAt >= WALLET_BALANCE_REFRESH_MS) void this.doBalance(rt);
      if (Date.now() - rt.lastClosedSyncAt >= CLOSED_RESYNC_MS)
        void this.reconciler.resyncClosed(rt);
      if (hasOpen) rps += rt.pools.length / (interval / 1000);
    }

    this.effectiveRps = rps;
    this.emitter.emitHealth(this.effectiveRps);
  }

  private pollAllNow(reason: string): void {
    for (const rt of this.wallets.values()) {
      if (!rt.refreshing) void this.doRefresh(rt, reason);
    }
  }

  private onWsActivity(address: string, instr: string): void {
    const kind = classifyInstruction(instr);
    if (!kind) return;
    // Retry schedule absorbs Meteora indexer lag; the periodic poll is the backstop.
    let attempt = 0;
    const run = () => {
      const rt = this.wallets.get(address);
      if (!rt) return;
      void this.doRefresh(rt, `ws:${kind}`).then((changed) => {
        if (!changed && attempt < RETRY_DELAYS_MS.length) {
          setTimeout(run, RETRY_DELAYS_MS[attempt]!);
          attempt++;
        }
      });
    };
    setTimeout(run, INITIAL_LAG_MS);
  }

  private doRefresh(rt: WalletRuntime, trigger: string): Promise<boolean> {
    return this.refresher.refresh(rt, trigger, {
      onClosed: (addr, pools) => void this.reconciler.captureClosed(addr, pools),
      onBalance: (addr) => {
        const target = this.wallets.get(addr);
        if (target) void this.doBalance(target);
      },
    });
  }

  private doBalance(rt: WalletRuntime): Promise<void> {
    return refreshBalance(rt, this.balances, () => this.emitter.emitState(rt.address));
  }

  private doReconcile(rt: WalletRuntime): Promise<void> {
    return this.reconciler.reconcile(rt, this.appConfig.historyDays, {
      doRefresh: (r) => this.doRefresh(r, 'reconcile'),
      doBalance: (r) => void this.doBalance(r),
    });
  }
}
