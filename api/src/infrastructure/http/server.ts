import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { Engine } from '@/application/engine';
import type { EventBus } from '@/application/event-bus';
import type { NotificationManager } from '@/application/notification/manager';
import type { AppConfig } from '@/config/env';
import type { ConfigRepository, PositionRepository } from '@/domain/ports';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';
import { registerRoutes } from './routes';
import { registerWebSocket } from './websocket';

export type ServerDeps = {
  config: AppConfig;
  bus: EventBus;
  engine: Engine;
  repo: PositionRepository;
  configRepo: ConfigRepository;
  notifications: NotificationManager;
  presence: PresenceTracker;
};

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: { level: deps.config.LOG_LEVEL } });

  // Allowlist for browsers — Auth is the real boundary; this is defense-in-depth.
  await app.register(cors, {
    origin: deps.config.WEB_ORIGINS.split(',').map((o) => o.trim()),
  });
  await app.register(websocket);

  // ── Auth (Bearer for REST, ?token= for WS) ──────────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/live') || req.url === '/health') return;
    if (req.headers.authorization !== `Bearer ${deps.config.API_TOKEN}`) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  registerRoutes(app, {
    bus: deps.bus,
    engine: deps.engine,
    repo: deps.repo,
    configRepo: deps.configRepo,
    notifications: deps.notifications,
    presence: deps.presence,
  });
  registerWebSocket(app, deps.config, deps.engine, deps.bus, deps.presence);

  return app;
}
