import {
  type OpenPosition,
  type PositionBins,
  type PositionHistory,
  WALLET_BALANCE_REFRESH_MS,
  type WalletState,
} from '@binsight/shared';
import type { Logger } from 'pino';
import type { EventBus } from '@/application/event-bus';
import type { HealthMonitor } from '@/application/health-monitor';
import type { PositionSync } from '@/application/position-sync-service';
import type { RealizedPnlEngine } from '@/application/realized-pnl';
import type { WalletFlowIngest } from '@/application/wallet-flow-ingest';
import type { AppConfig } from '@/config/env';
import { classifyInstruction } from '@/domain/dlmm';
import type {
  AccountRepository,
  ConfigRepository,
  DlmmIngest,
  OnchainDlmmGateway,
  PositionRepository,
  PositionsGateway,
  PriceGateway,
  RpcSubscriber,
} from '@/domain/ports';
import { mintsNeedingPrice, valueSnapshot } from '@/domain/snapshot-valuation';
import { KeyedSerializer, Semaphore } from '@/util/concurrency';
import { StateEmitter } from './emitter';
import { Reconciler } from './reconciler';
import { PositionRefresher } from './refresher';
import { makeRuntime, type WalletRuntime } from './runtime';
import type { StrategyService } from './strategy-service';
import { clamp, shouldRefreshRealized } from './utils';

const INITIAL_LAG_MS = 1500;
const RETRY_DELAYS_MS = [2000, 2500];
const CLOSED_RESYNC_MS = 90_000;
const STRATEGY_BACKFILL_MS = 60_000;
// Safety net: re-run snapshot discovery at least this often even with no WS activity, so a silently
// dropped open/close (WS reconnect gap) can't keep a stale position set indefinitely.
const SAFETY_REDISCOVER_MS = 600_000;
// Spread a fleet-wide poll burst (WS reconnect / manual refresh) across this step per wallet so it
// doesn't hit the shared Meteora budget all in one tick.
const POLL_STAGGER_MS = 50;
// On-chain source: refresh the positions projection at most this often on the snapshot cadence (open
// positions' live value/range) — re-projecting every snapshot tick would re-read all legs needlessly.
const SYNC_INTERVAL_MS = 60_000;
// On-chain source: periodic delta-ingest backstop so a dropped WS notification (socket stayed up) can't
// strand a missed open/close indefinitely. Catches what the live WS path misses.
const BACKSTOP_INGEST_MS = 300_000;
// After a close the residual is usually market-sold within seconds; Helius indexes that swap in ~1-2s
// (measured), so the realized pass fired at close-detection can run BEFORE the sell exists and overstate
// PnL (residual still marked as held). Re-run it on a small front-loaded schedule after each close so the
// real sale value converges without waiting for the wallet's next close. Bounded → ≤ this many extra
// passes per close. Front-loaded because the bottleneck is the close→sell delay, not indexing.
const REALIZED_REFRESH_OFFSETS_MS = [25_000, 60_000, 150_000];

/** Engine dependencies — one options object instead of 16 positional ctor args. */
export interface EngineDeps {
  gateway: PositionsGateway;
  prices: PriceGateway;
  subscriber: RpcSubscriber;
  onchain: OnchainDlmmGateway;
  health: HealthMonitor;
  strategy: StrategyService;
  repo: PositionRepository;
  config: ConfigRepository;
  accounts: AccountRepository;
  bus: EventBus;
  logger: Logger;
  appConfig: AppConfig;
  dlmmIngest: DlmmIngest;
  positionSync: PositionSync;
  walletFlowIngest: WalletFlowIngest;
  realizedPnl: RealizedPnlEngine;
}

export class Engine {
  private readonly wallets = new Map<string, WalletRuntime>();
  private readonly emitter: StateEmitter;
  private readonly refresher: PositionRefresher;
  private readonly reconciler: Reconciler;
  private tick: NodeJS.Timeout | null = null;
  private effectiveRps = 0;
  private lastBackfillAt = 0;
  // Serializes all ingests for one wallet (backfill + WS deltas + backstop) so two never race the
  // same leg set — the in-process equivalent of a per-wallet lock (single-process deployment).
  private readonly ingestLock = new KeyedSerializer();
  // Global concurrent-backfill cap (onboarding admission control); sized to the RPC tier via config.
  private readonly backfillSemaphore: Semaphore;
  // Wallets a client is currently viewing (maintained by the WS layer). The recurring net-worth
  // snapshot only runs for viewed wallets (+ notify-enabled ones) so idle wallets cost no RPC.
  private viewedWallets = new Set<string>();
  // Per-wallet guard so the chained-FIFO realized-PnL pass (Enhanced API + price gateway) never runs
  // twice concurrently for the same wallet — it fires async off the close-notification, not the loop.
  private readonly realizedPnlRunning = new Set<string>();
  // A trigger that arrives mid-run sets this so exactly ONE more pass runs after the current one
  // finishes (coalesced) — a close-burst no longer gets silently dropped by the single-flight guard.
  private readonly realizedPnlRerun = new Set<string>();

  private readonly prices: PriceGateway;
  private readonly subscriber: RpcSubscriber;
  private readonly onchain: OnchainDlmmGateway;
  private readonly health: HealthMonitor;
  private readonly strategy: StrategyService;
  private readonly repo: PositionRepository;
  private readonly config: ConfigRepository;
  private readonly accounts: AccountRepository;
  private readonly bus: EventBus;
  private readonly logger: Logger;
  private readonly appConfig: AppConfig;
  private readonly dlmmIngest: DlmmIngest;
  private readonly positionSync: PositionSync;
  private readonly walletFlowIngest: WalletFlowIngest;
  private readonly realizedPnl: RealizedPnlEngine;

  constructor(deps: EngineDeps) {
    // gateway is only needed to build the refresher/reconciler below — it's not a field.
    const { gateway, prices, subscriber, bus, logger, repo, appConfig } = deps;
    this.prices = prices;
    this.subscriber = subscriber;
    this.onchain = deps.onchain;
    this.health = deps.health;
    this.strategy = deps.strategy;
    this.repo = repo;
    this.config = deps.config;
    this.accounts = deps.accounts;
    this.bus = bus;
    this.logger = logger;
    this.appConfig = appConfig;
    this.dlmmIngest = deps.dlmmIngest;
    this.positionSync = deps.positionSync;
    this.walletFlowIngest = deps.walletFlowIngest;
    this.realizedPnl = deps.realizedPnl;
    this.emitter = new StateEmitter(this.wallets, subscriber, bus, this.health);
    this.refresher = new PositionRefresher(
      gateway,
      prices,
      repo,
      this.emitter,
      logger,
      this.strategy,
    );
    this.reconciler = new Reconciler(gateway, repo, bus, logger);
    this.backfillSemaphore = new Semaphore(appConfig.BACKFILL_CONCURRENCY);
  }

  async start(): Promise<void> {
    this.subscriber.onReconnect(() =>
      this.onchainSource ? this.resyncAllOnchain() : this.pollAllNow('ws-reconnect'),
    );
    this.subscriber.onConnectionChange((c) =>
      this.logger.debug({ connected: c }, 'Solana WS connection changed'),
    );
    this.subscriber.start();
    await this.strategy.init();

    for (const address of await this.accounts.monitoredWallets())
      await this.registerWallet(address);

    for (const [, rt] of this.wallets) {
      void this.doInitialSync(rt);
    }

    this.tick = setInterval(() => this.onTick(), 1000);
  }

  private get onchainSource(): boolean {
    return this.appConfig.POSITIONS_SOURCE === 'onchain';
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    this.subscriber.stop();
  }

  async addWallet(address: string): Promise<void> {
    if (this.wallets.has(address)) return;
    await this.registerWallet(address);
    void this.doInitialSync(this.wallets.get(address)!);
  }

  removeWallet(address: string): void {
    this.subscriber.unwatch(address);
    this.wallets.delete(address);
    this.ingestLock.delete(address);
  }

  getState(wallets: string[], scope: string): WalletState {
    return this.emitter.getState(wallets, scope);
  }

  /** Per-bin liquidity of one open position (Price-Bin histogram). Null if closed/missing. */
  positionBins(positionAddress: string): Promise<PositionBins | null> {
    return this.onchain.positionBins(positionAddress);
  }

  /** On-chain event timeline of a position (History drawer). Null if no history. */
  positionHistory(positionAddress: string): Promise<PositionHistory | null> {
    return this.onchain.positionHistory(positionAddress);
  }

  /** SOL spot price in USD — for the USD figures on a share card. Null if unavailable. */
  solUsdPrice(): Promise<number | null> {
    return this.prices.getSolUsd();
  }

  /** Immediately poll + snapshot all wallets (a manual refresh from a client). */
  refreshNow(): void {
    if (this.onchainSource) this.resyncAllOnchain();
    else this.pollAllNow('manual-refresh');
  }

  /** The WS layer reports which wallets currently have a viewer. The recurring net-worth snapshot is
   *  gated on this so idle/unwatched wallets cost no RPC; a wallet that GAINS a viewer (0→1) is
   *  snapshotted immediately so a returning viewer isn't served a stale total. */
  setViewedWallets(wallets: Set<string>): void {
    for (const w of wallets) {
      if (this.viewedWallets.has(w)) continue;
      const rt = this.wallets.get(w);
      if (rt) void this.doSnapshot(rt); // refresh-on-connect
    }
    this.viewedWallets = wallets;
  }

  /** A wallet warrants the recurring snapshot if a client is viewing it OR it has an enabled
   *  notification rule (global or wallet-scoped) — the owner's alert path is never gated on viewers. */
  private isWalletActive(address: string): boolean {
    if (this.viewedWallets.has(address)) return true;
    return this.config
      .listNotifRules()
      .some((r) => r.enabled && (r.wallet === null || r.wallet === address));
  }

  private async registerWallet(address: string): Promise<void> {
    const rt = makeRuntime(address, await this.repo.getOpen(address));
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

      if (!this.onchainSource && !rt.refreshing && Date.now() - rt.lastPollAt >= interval)
        void this.doRefresh(rt, 'poll');
      if (
        !rt.snapshotting &&
        this.isWalletActive(rt.address) &&
        Date.now() - rt.lastSnapshotAt >= WALLET_BALANCE_REFRESH_MS
      )
        void this.doSnapshot(rt);
      if (!this.onchainSource && Date.now() - rt.lastClosedSyncAt >= CLOSED_RESYNC_MS)
        void this.reconciler.resyncClosed(rt);
      if (this.onchainSource && Date.now() - rt.lastIngestAt >= BACKSTOP_INGEST_MS)
        void this.triggerOnchainSync(rt.address);
      if (hasOpen) rps += rt.pools.length / (interval / 1000);
    }

    if (Date.now() - this.lastBackfillAt >= STRATEGY_BACKFILL_MS) {
      this.lastBackfillAt = Date.now();
      void this.strategy.backfill();
    }

    this.effectiveRps = rps;
    this.emitter.emitHealth(this.effectiveRps);
  }

  private pollAllNow(reason: string): void {
    // Stagger the burst across wallets instead of firing every one in the same tick.
    let i = 0;
    for (const rt of this.wallets.values()) {
      const { address } = rt;
      setTimeout(() => {
        const r = this.wallets.get(address);
        if (r && !r.refreshing) void this.doRefresh(r, reason);
      }, i++ * POLL_STAGGER_MS);
    }
  }

  private onWsActivity(address: string, instr: string): void {
    const kind = classifyInstruction(instr);
    if (!kind) return;
    // A position-set or range change (open/close/add/remove) invalidates the cached snapshot plan
    // (Layer A); a claim only changes fees, so it keeps the plan and avoids a needless gPA.
    if (kind !== 'claim') {
      const target = this.wallets.get(address);
      if (target) target.needsDiscovery = true;
    }
    if (this.onchainSource) {
      this.onchainActivity(address);
      return;
    }
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
    return this.refresher
      .refresh(rt, trigger, {
        onClosed: (addr, pools) => void this.reconciler.captureClosed(addr, pools),
        onBalance: (addr) => {
          const target = this.wallets.get(addr);
          if (target) void this.doSnapshot(target);
        },
      })
      .then((changed) => {
        this.health.record('meteora', rt.lastPollOk, rt.lastPollOk ? undefined : 'poll failed');
        return changed;
      })
      .catch((err) => {
        // Never let a poll rejection escape the loop — record it and keep serving last-good state.
        this.health.record('meteora', false, err instanceof Error ? err.message : 'poll error');
        this.logger.warn({ err, address: rt.address }, 'refresh failed');
        return false;
      });
  }

  /**
   * Authoritative, slot-consistent wallet valuation from on-chain accounts (positions + idle + fees +
   * rent in ONE getMultipleAccounts pass). Replaces the old tvl+idle two-clock total and its pendingDelta
   * heuristic. Never resets the last good total on failure — a transient RPC error must not corrupt
   * the displayed wallet size.
   */
  private async doSnapshot(rt: WalletRuntime): Promise<void> {
    if (rt.snapshotting) return;
    rt.snapshotting = true;
    rt.lastSnapshotAt = Date.now();
    try {
      // Layer A: only re-discover (the 10-credit getProgramAccounts) when the position set may have
      // changed — on WS activity, a missing plan, or the periodic safety interval. Clear the flag
      // BEFORE awaiting so a WS event during the snapshot forces another discovery next tick.
      const rediscover =
        rt.needsDiscovery ||
        rt.snapshotPlan === null ||
        Date.now() - rt.lastDiscoveryAt >= SAFETY_REDISCOVER_MS;
      if (rediscover) {
        rt.needsDiscovery = false;
        rt.lastDiscoveryAt = Date.now();
      }
      const snap = await this.onchain.snapshotWallet(
        rt.address,
        rediscover ? undefined : (rt.snapshotPlan ?? undefined),
      );
      rt.snapshotPlan = snap.plan;
      this.health.record('rpc', true);
      this.health.setChainTip(snap.slot);
      const priceMap = await this.prices.getPricesSol(mintsNeedingPrice(snap));
      const valued = valueSnapshot(snap, priceMap);
      rt.onchain = valued;
      this.emitter.emitState(rt.address);
      // On-chain source: keep the positions table in sync with the legs ⊕ this snapshot.
      //  - after an INGEST (`needsSync`): FULL reproject (open + closed) — closed may have changed.
      //    Emit closed_changed ONLY when the closed count actually moves, so viewers don't refetch on
      //    every tick. Flags cleared AFTER success so a transient failure retries next tick.
      //  - otherwise on the CADENCE: refresh ONLY the open positions' live value/range (cheap) — never
      //    re-write the (large, unchanged) closed history. Waits for `reconciled` so a tick before the
      //    first backfill can't wipe the open set with an empty projection.
      if (this.onchainSource && rt.needsSync) {
        // Gate the close-notification on prior reconciliation: the FIRST sync is the historical backfill
        // (can write ~15k closed rows) and must emit ZERO `closed` events. `sync` already returns only the
        // genuinely newly-closed rows (open→closed transitions vs the persisted open set), so on every
        // SUBSEQUENT sync each newly-closed position fires exactly one `closed` → one push.
        const wasReconciled = rt.reconciled;
        const res = await this.positionSync.sync(rt.address, snap, valued);
        rt.needsSync = false;
        rt.lastSyncAt = Date.now();
        rt.reconciled = true;
        this.applyOpenPositions(rt, res.openPositions);
        if (wasReconciled) for (const row of res.closedRows) this.bus.emit('closed', row);
        if (res.closed !== rt.lastClosedCount) {
          rt.lastClosedCount = res.closed;
          this.bus.emit('closedChanged', { wallet: rt.address });
          // The closed set moved → (re)compute the authoritative on-chain realized market_pnl_sol for
          // this wallet's closed positions. Runs async (Enhanced API + price gateway) so it never blocks
          // the snapshot loop; the UI fills in via a second closedChanged when it persists.
          // INCREMENTAL: loadFlows still does one FULL seed on a cold cache (else-branch), so the first
          // close after a (re)start pages the whole history once; every subsequent close then costs only
          // the delta (~one Helius page). A full re-page on EVERY close was burning millions of
          // getEnhancedTransactionsByAddress calls/day on an actively-churning wallet.
          rt.lastRealizedRunAt = Date.now();
          void this.runRealizedPnl(rt.address, { incremental: true });
          // Arm the BOUNDED deferred refresh (below) ONLY for a genuine LIVE close — post-reconcile with
          // newly-closed rows. NEVER the initial backfill count-establishment (wasReconciled=false) or a
          // bulk catch-up, which would otherwise fan out N extra realized passes per wallet on cold-start.
          if (wasReconciled && res.closedRows.length > 0) rt.lastCloseAt = Date.now();
        }
      } else if (
        this.onchainSource &&
        rt.reconciled &&
        Date.now() - rt.lastSyncAt >= SYNC_INTERVAL_MS
      ) {
        const open = await this.positionSync.refreshOpen(rt.address, snap, valued);
        rt.lastSyncAt = Date.now();
        this.applyOpenPositions(rt, open);
      }

      // Deferred convergence: independent of a new close, keep re-running the realized pass for a bounded
      // window after the last close so a freshly market-sold residual's REAL value lands once Helius
      // indexes the swap — instead of showing the stale pool-spot mark until the wallet's next close.
      if (
        this.onchainSource &&
        rt.reconciled &&
        shouldRefreshRealized({
          now: Date.now(),
          lastCloseAt: rt.lastCloseAt,
          lastRealizedRunAt: rt.lastRealizedRunAt,
          offsetsMs: REALIZED_REFRESH_OFFSETS_MS,
        })
      ) {
        rt.lastRealizedRunAt = Date.now();
        // Incremental: the close-time pass already seeded the full history; a refresh only needs the
        // recent delta (the residual sell) — cheap, so it converges fast even for huge wallets.
        void this.runRealizedPnl(rt.address, { incremental: true });
      }
    } catch (err) {
      this.health.record('rpc', false, err instanceof Error ? err.message : String(err));
      this.logger.warn(
        { err, address: rt.address },
        'on-chain snapshot failed — keeping last good total',
      );
    } finally {
      rt.snapshotting = false;
    }
  }

  /** On-chain source: refresh the in-memory open set from the freshly persisted projection and push it
   *  to viewers. `rt.open` is otherwise seeded only at registration, so without this a position opened
   *  after the wallet was registered never appears in the live state until the next process restart. */
  private applyOpenPositions(rt: WalletRuntime, positions: OpenPosition[]): void {
    rt.open = new Map(positions.map((p) => [p.positionAddress, p]));
    this.emitter.emitState(rt.address);
  }

  /**
   * Recompute + persist the authoritative on-chain realized PnL (`market_pnl_sol`) for a wallet's CLOSED
   * positions via the chained-FIFO engine. Idempotent (re-running just rewrites the same values) and
   * single-flight per wallet so it can never pile up. Errors are swallowed — a failed pass must not
   * disturb the live snapshot loop; the existing values stay until the next close-notification retries.
   */
  private async runRealizedPnl(wallet: string, opts: { incremental?: boolean } = {}): Promise<void> {
    if (this.realizedPnlRunning.has(wallet)) {
      this.realizedPnlRerun.add(wallet); // coalesce a mid-run trigger into one more pass
      return;
    }
    this.realizedPnlRunning.add(wallet);
    try {
      // First pass honors the requested mode (deferred refresh = incremental → cheap delta fetch); any
      // COALESCED rerun falls back to a full pass (rare, since passes are spaced, and always safe).
      let incremental = opts.incremental ?? false;
      do {
        this.realizedPnlRerun.delete(wallet);
        const pnlByPos = await this.realizedPnl.computeForWallet(wallet, { incremental });
        incremental = false;
        // null = the engine refused to produce values (incomplete buy/sell history). Skip persisting so
        // a flaky live Helius fetch can never overwrite good market_pnl_sol with inflated held values.
        if (pnlByPos == null || pnlByPos.size === 0) continue;
        // One atomic batched UPDATE for the whole wallet (was N sequential single-row writes): a
        // mid-loop crash can no longer leave mixed old/new market_pnl_sol generations.
        await this.repo.setAuthoritativePnlMany(pnlByPos);
        // Tell viewers the closed figures changed so the table/stats recompute with the real cash values.
        this.bus.emit('closedChanged', { wallet });
        this.logger.info(
          { wallet, written: pnlByPos.size },
          'realized-pnl: market_pnl_sol persisted',
        );
      } while (this.realizedPnlRerun.has(wallet));
    } catch (err) {
      this.logger.error({ err, wallet }, 'realized-pnl pass failed — keeping prior market_pnl_sol');
    } finally {
      this.realizedPnlRunning.delete(wallet);
      this.realizedPnlRerun.delete(wallet);
    }
  }

  private doReconcile(rt: WalletRuntime): Promise<void> {
    return this.reconciler.reconcile(rt, this.appConfig.historyDays, {
      doRefresh: (r) => this.doRefresh(r, 'reconcile'),
      doBalance: (r) => void this.doSnapshot(r),
    });
  }

  /** Initial catch-up for a wallet: on-chain backfill (legs → projection) or the Meteora reconcile. */
  private doInitialSync(rt: WalletRuntime): Promise<void> {
    return this.onchainSource ? this.onchainBackfill(rt) : this.doReconcile(rt);
  }

  /** Full historical ingest of a wallet's DLMM legs, then project the positions table from them. */
  private onchainBackfill(rt: WalletRuntime): Promise<void> {
    // Admission control: at most MAX_CONCURRENT_BACKFILLS wallets backfill at once.
    return this.backfillSemaphore.run(async () => {
      try {
        rt.lastIngestAt = Date.now();
        await this.ingestLock.run(rt.address, () =>
          this.dlmmIngest.ingest(rt.address, {
            onProgress: (txs) => {
              rt.ingestedTxs = txs; // surfaced as the UI's "indexing… (N txs)" onboarding progress
            },
          }),
        );
        rt.needsSync = true;
        await this.doSnapshot(rt); // full reproject; emits closed_changed iff the closed count moved
        this.logger.info({ address: rt.address }, 'onchain backfill complete');
      } catch (err) {
        this.logger.error(
          { err, address: rt.address },
          'onchain backfill failed — backstop sweep will retry',
        );
      }
      // Cash-flow backfill for the wallet PnL curve — best-effort & isolated so a flow failure never
      // blocks the positions path; still inside the backfill semaphore so onboarding stays rate-bounded.
      await this.ingestWalletFlows(rt.address);
    });
  }

  /** Top up a wallet's persisted cash-flow (powers the wallet PnL curve). Never throws into callers. */
  private async ingestWalletFlows(address: string): Promise<void> {
    try {
      await this.ingestLock.run(address, () => this.walletFlowIngest.ingest(address));
    } catch (err) {
      this.logger.warn({ err, address }, 'wallet flow ingest failed — curve may lag, will retry');
    }
  }

  /** Onboarding status for a wallet: `ready` once its first projection has landed (history is queryable);
   *  `indexedTxs` = txs ingested so far during the initial backfill (for an "indexing…" UI state). */
  ingestStatus(address: string): { ready: boolean; indexedTxs: number } {
    const rt = this.wallets.get(address);
    return { ready: rt?.reconciled ?? false, indexedTxs: rt?.ingestedTxs ?? 0 };
  }

  /** WS open/close/add/remove/claim → delta-ingest the new signatures then re-project, after a short
   *  lag so the just-confirmed tx is visible to getSignaturesForAddress. */
  private onchainActivity(address: string): void {
    setTimeout(() => void this.triggerOnchainSync(address), INITIAL_LAG_MS);
  }

  /** Delta-ingest a wallet's new legs (cursor top-up), then sync — the WS-activity & backstop path. */
  private async triggerOnchainSync(address: string): Promise<void> {
    const rt = this.wallets.get(address);
    if (!rt) return;
    try {
      rt.lastIngestAt = Date.now();
      const r = await this.ingestLock.run(address, () => this.dlmmIngest.ingest(address));
      // Only force a full reproject when the delta actually ingested new txs (a real open/close/add/
      // claim). A backstop sweep that finds nothing must NOT re-write the whole closed history — that
      // was a recurring 15k-row write per wallet every 5 min. doSnapshot still refreshes net-worth.
      if (r.txs > 0) rt.needsSync = true;
      await this.doSnapshot(rt);
    } catch (err) {
      this.logger.warn({ err, address }, 'onchain delta sync failed (backstop will retry)');
    }
    // Delta-ingest the wallet's cash-flow too — captures post-close SWAP dumps the DLMM ingest can't
    // see. Outside the try above so it runs even if the leg sync threw; isolated and cheap (1 page).
    await this.ingestWalletFlows(address);
  }

  /** WS reconnect / manual refresh: a staggered safety delta-ingest of every wallet to self-heal gaps. */
  private resyncAllOnchain(): void {
    let i = 0;
    for (const rt of this.wallets.values()) {
      const { address } = rt;
      setTimeout(() => void this.triggerOnchainSync(address), i++ * POLL_STAGGER_MS);
    }
  }
}
