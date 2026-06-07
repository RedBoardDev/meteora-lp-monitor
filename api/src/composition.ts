import type { RuntimeSettings } from '@meteora/shared';
import { pino } from 'pino';
import { Engine } from './application/engine/index';
import { EventBus } from './application/event-bus';
import { LpAgentEnricher } from './application/lpagent-enricher';
import { NotificationManager } from './application/notification/manager';
import type { AppConfig } from './config/env';
import { installGracefulShutdown } from './infrastructure/http/graceful-shutdown';
import { buildServer } from './infrastructure/http/server';
import { JupiterPriceGateway } from './infrastructure/jupiter/jupiter-price';
import { LpAgentGateway } from './infrastructure/lpagent/lpagent-gateway';
import { RateLimitedQueue } from './infrastructure/lpagent/rate-limited-queue';
import { MeteoraGateway } from './infrastructure/meteora/meteora-gateway';
import { BarkChannel } from './infrastructure/notifications/bark-channel';
import { PresenceTracker } from './infrastructure/notifications/presence';
import { SqliteConfigRepository } from './infrastructure/persistence/config-repository';
import { openDatabase } from './infrastructure/persistence/database';
import { SqlitePositionRepository } from './infrastructure/persistence/position-repository';
import { RpcBalanceGateway } from './infrastructure/solana/balance-gateway';
import { HeliusSubscriber } from './infrastructure/solana/helius-subscriber';

export interface App {
  start(): Promise<void>;
}

export function compose(config: AppConfig): App {
  const logger = pino({ level: config.LOG_LEVEL });

  const db = openDatabase(config.DB_PATH);
  const positionRepo = new SqlitePositionRepository(db);

  const defaults: RuntimeSettings = {
    meteoraTargetRps: config.METEORA_TARGET_RPS,
    pollMinMs: config.POLL_MIN_MS,
    pollMaxMs: config.POLL_MAX_MS,
    pollIdleMs: config.POLL_IDLE_MS,
    barkKey: config.BARK_KEY,
    presenceTimeoutSeconds: config.PRESENCE_TIMEOUT_SECONDS,
  };
  const configRepo = new SqliteConfigRepository(db, defaults);

  const bus = new EventBus();
  const gateway = new MeteoraGateway(logger);
  const prices = new JupiterPriceGateway(logger, config.JUPITER_PRICE_URL);
  const lpAgentQueue = new RateLimitedQueue(config.LPAGENT_RPM);
  const lpAgent = new LpAgentGateway(config.LPAGENT_BASE_URL, config.LPAGENT_API_KEY, lpAgentQueue);
  const enricher = new LpAgentEnricher(lpAgent, positionRepo, bus, logger);
  const subscriber = new HeliusSubscriber(config.SOLANA_WS_URL, logger);
  const balances = new RpcBalanceGateway(config.solanaHttpUrl, logger);
  const presence = new PresenceTracker(config.PRESENCE_TIMEOUT_SECONDS * 1000);
  const bark = new BarkChannel(
    config.BARK_BASE_URL,
    () => configRepo.getSettings().barkKey,
    logger,
  );

  const engine = new Engine(
    gateway,
    prices,
    subscriber,
    balances,
    positionRepo,
    configRepo,
    bus,
    enricher,
    logger,
    config,
  );
  const notifications = new NotificationManager(bus, configRepo, presence, bark, logger);

  return {
    async start() {
      notifications.start();
      await engine.start();
      const server = await buildServer({
        config,
        bus,
        engine,
        repo: positionRepo,
        configRepo,
        notifications,
        presence,
      });
      // db closes last (after in-flight requests drain in app.close); engine stops first.
      server.addHook('onClose', async () => db.close());
      installGracefulShutdown(server, {
        closeHandlers: [async () => engine.stop()],
      });
      await server.listen({ port: config.PORT, host: '0.0.0.0' });
      logger.info({ port: config.PORT }, 'Meteora LP Monitor API listening');
    },
  };
}
