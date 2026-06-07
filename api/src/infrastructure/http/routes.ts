import type { FastifyInstance } from 'fastify';
import { EventKindSchema, NotifRuleSchema, RuntimeSettingsSchema, WalletSchema, type LiveEvent } from '@meteora/shared';
import type { Engine } from '@/application/engine';
import type { NotificationManager } from '@/application/notification/manager';
import type { ConfigRepository, PositionRepository } from '@/domain/ports';
import type { EventBus } from '@/application/event-bus';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';
import { computeStats } from '@/application/stats';

export type RouteDeps = {
  bus: EventBus;
  engine: Engine;
  repo: PositionRepository;
  configRepo: ConfigRepository;
  notifications: NotificationManager;
  presence: PresenceTracker;
};

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { bus, engine, repo, configRepo, notifications, presence } = deps;

  app.get('/health', async () => ({ ok: true }));

  // Fires a fake event through the normal path — for verifying notifications end-to-end.
  app.post('/debug/notify', async (req) => {
    const kind = EventKindSchema.safeParse((req.query as Record<string, string>).kind).data ?? 'position_close';
    const ev: LiveEvent = {
      id: `test-${Date.now()}`,
      kind,
      wallet: null,
      positionAddress: null,
      pair: 'SOL/USDC',
      title: kind === 'position_close' ? 'Position closed — SOL/USDC' : 'Test notification',
      body: kind === 'position_close' ? '+0.0420 SOL · fees 0.0012' : 'Notifications work ✅',
      data: {},
      createdAt: Date.now(),
    };
    bus.emit('event', ev);
    const activeDevices = presence.activeDevices();
    // A device only reports active when it'll show a native banner (foreground + notifs enabled).
    return { ok: true, kind, activeDevices, willRoute: activeDevices.length > 0 ? 'native' : 'bark' };
  });

  app.get('/wallets', async () => configRepo.listWallets());

  app.post('/wallets', async (req, reply) => {
    const body = WalletSchema.partial({ createdAt: true, label: true }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.format() });
    configRepo.addWallet({ address: body.data.address, label: body.data.label ?? '', color: body.data.color });
    engine.addWallet(body.data.address);
    return { ok: true };
  });

  app.delete<{ Params: { address: string } }>('/wallets/:address', async (req) => {
    engine.removeWallet(req.params.address);
    configRepo.removeWallet(req.params.address);
    return { ok: true };
  });

  app.get<{ Querystring: { wallet?: string } }>('/state', async (req) =>
    engine.getState(req.query.wallet ?? 'all'),
  );

  app.get<{ Querystring: { wallet?: string; page?: string; pageSize?: string } }>(
    '/positions/closed',
    async (req) => {
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
      return repo.getClosed(req.query.wallet ?? 'all', { page, pageSize });
    },
  );

  app.get<{ Querystring: { wallet?: string } }>('/stats', async (req) => {
    const scope = req.query.wallet ?? 'all';
    return computeStats(scope, repo.getClosedForStats(scope));
  });

  app.get('/config/notifications', async () => configRepo.listNotifRules());

  app.put('/config/notifications', async (req, reply) => {
    const rule = NotifRuleSchema.safeParse(req.body);
    if (!rule.success) return reply.code(400).send({ error: rule.error.format() });
    configRepo.saveNotifRule(rule.data);
    notifications.reloadRules();
    return { ok: true };
  });

  app.get('/config/settings', async () => configRepo.getSettings());

  app.put('/config/settings', async (req, reply) => {
    const parsed = RuntimeSettingsSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
    return configRepo.saveSettings(parsed.data);
  });

}
