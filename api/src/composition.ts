import type { RuntimeSettings } from '@binsight/shared';
import { Connection } from '@solana/web3.js';
import { pino } from 'pino';
import { DlmmPositionPnl } from './application/dlmm-position-pnl';
import { Engine } from './application/engine/index';
import { StrategyService } from './application/engine/strategy-service';
import { EventBus } from './application/event-bus';
import { HealthMonitor } from './application/health-monitor';
import { NetworthRecorder } from './application/networth-recorder';
import { NotificationManager } from './application/notification/manager';
import { PositionSync } from './application/position-sync-service';
import { RealizedPnlEngine } from './application/realized-pnl';
import { ResidualBackfill } from './application/residual-backfill';
import { flowFromHistory } from './application/residual-realized';
import { WalletFlowIngest } from './application/wallet-flow-ingest';
import { WalletPnlService } from './application/wallet-pnl-service';
import type { AppConfig } from './config/env';
import { GeckoTerminalGateway } from './infrastructure/geckoterminal/geckoterminal-gateway';
import { installGracefulShutdown } from './infrastructure/http/graceful-shutdown';
import { buildServer } from './infrastructure/http/server';
import { CachedPriceGateway } from './infrastructure/jupiter/cached-price-gateway';
import { JupiterPriceGateway } from './infrastructure/jupiter/jupiter-price';
import { MeteoraGateway } from './infrastructure/meteora/meteora-gateway';
import { BarkChannel } from './infrastructure/notifications/bark-channel';
import { PresenceTracker } from './infrastructure/notifications/presence';
import { WebPushChannel } from './infrastructure/notifications/web-push-channel';
import { PostgresAccountRepository } from './infrastructure/persistence/account-repository';
import { PostgresConfigRepository } from './infrastructure/persistence/config-repository';
import { closeDatabase, openDatabase, runMigrations } from './infrastructure/persistence/database';
import { DlmmLegRepository } from './infrastructure/persistence/dlmm-leg-repository';
import { NetworthSnapshotRepository } from './infrastructure/persistence/networth-snapshot-repository';
import { PostgresPositionRepository } from './infrastructure/persistence/position-repository';
import { PushRepository } from './infrastructure/persistence/push-repository';
import { WalletFlowRepository } from './infrastructure/persistence/wallet-flow-repository';
import { DlmmIngest } from './infrastructure/solana/dlmm/dlmm-ingest';
import { OnchainDlmmGateway } from './infrastructure/solana/dlmm/onchain-gateway';
import { OnchainPoolMetaReader } from './infrastructure/solana/dlmm/pool-meta';
import { StrategyResolver } from './infrastructure/solana/dlmm/strategy-resolver';
import { CreditMeter } from './infrastructure/solana/credit-meter';
import { HeliusEnhancedGateway } from './infrastructure/solana/helius-enhanced';
import { HeliusSubscriber } from './infrastructure/solana/helius-subscriber';
import { SolanaRpcRateLimiter } from './infrastructure/solana/rpc-rate-limiter';
import { HeliusTokenMetadataGateway } from './infrastructure/solana/token-metadata-gateway';

export interface App {
  start(): Promise<void>;
}

export function compose(config: AppConfig): App {
  const logger = pino({ level: config.LOG_LEVEL });

  const db = openDatabase(config.DATABASE_URL);
  const positionRepo = new PostgresPositionRepository(db);
  const accounts = new PostgresAccountRepository(db);

  const defaults: RuntimeSettings = {
    meteoraTargetRps: config.METEORA_TARGET_RPS,
    pollMinMs: config.POLL_MIN_MS,
    pollMaxMs: config.POLL_MAX_MS,
    pollIdleMs: config.POLL_IDLE_MS,
    barkKey: config.BARK_KEY,
    presenceTimeoutSeconds: config.PRESENCE_TIMEOUT_SECONDS,
  };
  const configRepo = new PostgresConfigRepository(db, defaults);

  const bus = new EventBus();
  const health = new HealthMonitor();
  // ONE shared credit meter wired into every billable chokepoint (both RPC lanes, the Enhanced REST
  // gateway, the DAS metadata gateway) — the single in-memory ledger behind /debug/rpc + the kill-switch.
  const meter = new CreditMeter();
  const gateway = new MeteoraGateway(logger);
  // Resource-keyed (per-mint) price cache + single-flight + token bucket: N wallets/snapshots
  // needing the same token in one window collapse to ONE Jupiter call (cross-user dedup).
  const prices = new CachedPriceGateway(
    new JupiterPriceGateway(logger, config.JUPITER_PRICE_URL, health),
  );
  const subscriber = new HeliusSubscriber(config.SOLANA_WS_URL, logger);
  // One shared rate limiter gates EVERY RPC call on this Connection (overall + per-method sub-limits),
  // so the live engine and the heavy history backfill stay within the provider's plan. The config
  // values are the PLAN limits; we target a fraction of them so the provider's sliding-window
  // counter never sees us at exactly the ceiling (which still 429s).
  const RPS_SAFETY = 0.85;
  const liveFrac = config.SOLANA_LIVE_FRACTION;
  // LIVE lane — the snapshot/valuation path. Reserved share of the overall budget so a history backfill
  // on the other lane can never starve live valuation.
  const rpcLimiter = new SolanaRpcRateLimiter(
    {
      rps: config.SOLANA_RPS * RPS_SAFETY * liveFrac,
      gpaRps: config.SOLANA_GPA_RPS * RPS_SAFETY,
      dasRps: config.SOLANA_DAS_RPS * RPS_SAFETY,
      sendRps: config.SOLANA_SEND_RPS * RPS_SAFETY,
    },
    undefined,
    meter,
  );
  const connection = new Connection(config.solanaHttpUrl, {
    commitment: 'confirmed',
    fetchMiddleware: rpcLimiter.middleware(),
  });
  // BACKFILL lane — a SEPARATE Connection for the heavy history ingest + projection (legs + pool-meta
  // reads), capped at the remaining OVERALL budget so the two lanes together stay under the plan while
  // the live lane keeps its reserved slice (fixes the "backfill starves live snapshot" contention).
  // Only the OVERALL budget is split — it's the real cross-lane contention. The backfill lane issues
  // only getSignatures/getParsedTransactions/getAccountInfo ("other"), never gpa/das/send, so its
  // method sub-limits are pinned to its overall rate (they never bind); the live lane keeps the FULL
  // per-method plan limits (it's the sole gpa user; das is the token-metadata gateway's own budget).
  const backfillRps = config.SOLANA_RPS * RPS_SAFETY * (1 - liveFrac);
  const backfillLimiter = new SolanaRpcRateLimiter(
    {
      rps: backfillRps,
      gpaRps: backfillRps,
      dasRps: backfillRps,
      sendRps: backfillRps,
    },
    undefined,
    meter,
  );
  const backfillConnection = new Connection(config.solanaHttpUrl, {
    commitment: 'confirmed',
    fetchMiddleware: backfillLimiter.middleware(),
  });
  const onchain = new OnchainDlmmGateway(connection);
  // On-chain DLMM positions engine — the decoupled source (legs ingest + projection → positions table),
  // gated by POSITIONS_SOURCE. Runs on the BACKFILL lane so it never starves the live snapshot path.
  const dlmmLegRepo = new DlmmLegRepository(db);
  const dlmmIngest = new DlmmIngest(backfillConnection, dlmmLegRepo, logger);
  const dlmmPositionPnl = new DlmmPositionPnl(
    dlmmLegRepo,
    new OnchainPoolMetaReader(backfillConnection),
    logger,
  );
  // The DAS budget belongs to this gateway (the Connection lanes issue no DAS calls); size it with the
  // same safety factor so it keeps margin under the plan's DAS sub-limit.
  const tokenMetadata = new HeliusTokenMetadataGateway(
    config.solanaHttpUrl,
    logger,
    config.SOLANA_DAS_RPS * RPS_SAFETY,
    undefined,
    meter,
  );
  const positionSync = new PositionSync(dlmmPositionPnl, tokenMetadata, positionRepo, logger);
  const strategy = new StrategyService(new StrategyResolver(connection), positionRepo, logger);
  const enhanced = new HeliusEnhancedGateway(config.solanaHttpUrl, logger, undefined, undefined, meter);
  // Free OHLCV candle source (no key) for the position price chart.
  const gecko = new GeckoTerminalGateway(logger);
  // Persisted wallet cash-flow: ingested once at backfill + topped up on the cadence, so the wallet
  // PnL curve is served by SQL instead of re-paging the chain per request.
  const walletFlowRepo = new WalletFlowRepository(db);
  const walletFlowIngest = new WalletFlowIngest(enhanced, walletFlowRepo, logger);
  // Exact per-position SOL leg + net residual from the decoded DLMM event history (LPAgent-grade:
  // per-position amounts, not the wallet's aggregate native flow which over-counts multi-position opens).
  const positionFlow = async (address: string) => {
    const hist = await onchain.positionHistory(address);
    return hist ? flowFromHistory(hist) : null;
  };
  const backfill = new ResidualBackfill(enhanced, positionFlow, positionRepo, bus, logger);
  // Authoritative on-chain realized market_pnl_sol writer (chained-FIFO over legs + Helius buys/sells,
  // held residual marked via the shared price gateway). Triggered by the engine after a wallet's closed
  // set changes — the production port of scripts/fifo-cost-basis.ts.
  const realizedPnl = new RealizedPnlEngine(
    dlmmLegRepo,
    positionRepo,
    enhanced,
    prices,
    (mint) => onchain.decimalsOf(mint),
    logger,
  );
  // Wallet PnL curve — the TRUE realized SOL over time from on-chain cash-flow (captures rug/slippage
  // losses that position-level PnL misses). Reads the persisted flows; SQL aggregation, no live paging.
  const walletPnl = new WalletPnlService(walletFlowRepo);
  // Forward-only Net Worth history (TRUE on-chain wallet total = tvl + idle, sampled into 15-min
  // buckets) + a fail-loud reconciliation of the flow ledger against the live on-chain idle.
  const networthSnapshots = new NetworthSnapshotRepository(db);
  const networthRecorder = new NetworthRecorder(bus, networthSnapshots, walletFlowRepo, logger);
  const presence = new PresenceTracker(config.PRESENCE_TIMEOUT_SECONDS * 1000);
  const bark = new BarkChannel(
    config.BARK_BASE_URL,
    () => configRepo.getSettings().barkKey,
    logger,
  );
  // Browser/PWA Web Push, routed per-wallet to subscribers. Fans out alongside Bark via a composite.
  const pushRepo = new PushRepository(db);
  const webPush = new WebPushChannel(
    pushRepo,
    {
      publicKey: config.VAPID_PUBLIC_KEY,
      privateKey: config.VAPID_PRIVATE_KEY,
      subject: config.VAPID_SUBJECT,
    },
    logger,
  );

  const engine = new Engine({
    gateway,
    prices,
    subscriber,
    onchain,
    health,
    strategy,
    repo: positionRepo,
    config: configRepo,
    accounts,
    bus,
    logger,
    appConfig: config,
    dlmmIngest,
    positionSync,
    walletFlowIngest,
    realizedPnl,
  });
  const notifications = new NotificationManager(bus, configRepo, presence, bark, webPush, logger);

  return {
    async start() {
      await runMigrations(db, './drizzle');
      // Populate the wallet_flow_daily rollup from existing raw flows on first boot after it's added;
      // a no-op once populated (upsertFlows then maintains it incrementally).
      await walletFlowRepo.ensureDailyBackfilled();
      await configRepo.init();
      await accounts.init(config.OWNER_ADDRESS);
      notifications.start();
      networthRecorder.start();
      await engine.start();
      const server = await buildServer({
        config,
        bus,
        engine,
        repo: positionRepo,
        configRepo,
        accounts,
        backfill,
        walletPnl,
        networthSnapshots,
        notifications,
        presence,
        pushRepo,
        gecko,
        meter,
        vapidPublicKey: config.VAPID_PUBLIC_KEY,
        sendTestPush: (userId) => pushRepo.forUser(userId).then((subs) => webPush.sendTest(subs)),
        openAccess: config.OPEN_ACCESS_MODE,
      });
      // Periodic RPC call-count log (live + backfill lanes) for Helius tier-headroom monitoring —
      // the wallet PnL curve is served from persisted flows (SQL), so there's no cache to warm.
      let statsTimer: ReturnType<typeof setInterval> | undefined;
      const logRpcStats = () => {
        logger.info(
          {
            live: rpcLimiter.stats(),
            backfill: backfillLimiter.stats(),
            // Enhanced REST (getEnhancedTransactionsByAddress): billed per request and BYPASSES the
            // JSON-RPC limiter, so it had no counter — this is the line that exposes the real RPC spend.
            enhanced: enhanced.stats(),
            // The unified CREDIT ledger across every chokepoint (totals + by method/codePath/wallet).
            credits: meter.stats(),
          },
          'rpc call counts (Helius tier instrumentation)',
        );
      };

      // db closes last (after in-flight requests drain in app.close); engine stops first. (Hooks must
      // be registered BEFORE listen — Fastify rejects addHook once listening.)
      server.addHook('onClose', async () => closeDatabase(db));
      installGracefulShutdown(server, {
        closeHandlers: [
          async () => engine.stop(),
          async () => {
            if (statsTimer) clearInterval(statsTimer);
          },
        ],
      });
      await server.listen({ port: config.PORT, host: '0.0.0.0' });
      logger.info({ port: config.PORT }, 'Binsight API listening');

      logRpcStats();
      statsTimer = setInterval(() => logRpcStats(), 60_000); // every 60s (tightened for RPC debugging)
    },
  };
}
