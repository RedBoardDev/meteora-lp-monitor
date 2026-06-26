import {
  EventKindSchema,
  type LiveEvent,
  NotifRuleSchema,
  RuntimeSettingsSchema,
  WalletSchema,
} from '@binsight/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Engine } from '@/application/engine';
import type { EventBus } from '@/application/event-bus';
import type { NotificationManager } from '@/application/notification/manager';
import { BUCKET_MS, type Bucket, isBucket, profitHistory } from '@/application/profit-history';
import type { ResidualBackfill } from '@/application/residual-backfill';
import type { WalletPnlService } from '@/application/wallet-pnl-service';
import type { AccountRepository, ConfigRepository, PositionRepository } from '@/domain/ports';
import type { GeckoTerminalGateway } from '@/infrastructure/geckoterminal/geckoterminal-gateway';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';
import type { NetworthSnapshotRepository } from '@/infrastructure/persistence/networth-snapshot-repository';
import type { PushRepository, PushSub } from '@/infrastructure/persistence/push-repository';
import type { RpcCreditLedgerRepository } from '@/infrastructure/persistence/rpc-credit-ledger-repository';
import { renderClosedPnlCard } from '@/infrastructure/share-card/pnl-card';
import type { CreditMeter } from '@/infrastructure/solana/credit-meter';
import { TtlCache, VersionedCache } from '@/util/cache';
import { isValidSolanaAddress } from './auth';

/** Per-account watchlist size (the owner is exempt). Doubles as admission control. */
const MAX_WALLETS_PER_ACCOUNT = 3;
/** Global ceiling on distinct monitored wallets — protects the shared Meteora/Helius budget. */
const GLOBAL_WALLET_CAP = 200;
/** How many recent UTC days of persisted credit spend /debug/rpc returns (the panel's last-7d window). */
const DEBUG_RPC_HISTORY_DAYS = 7;

export type RouteDeps = {
  bus: EventBus;
  engine: Engine;
  repo: PositionRepository;
  configRepo: ConfigRepository;
  accounts: AccountRepository;
  backfill: ResidualBackfill;
  walletPnl: WalletPnlService;
  /** Forward-only persisted Net Worth (TRUE on-chain wallet total over time). */
  networthSnapshots: NetworthSnapshotRepository;
  notifications: NotificationManager;
  presence: PresenceTracker;
  pushRepo: PushRepository;
  /** Free OHLCV candle source for the position price chart (GeckoTerminal). */
  gecko: GeckoTerminalGateway;
  /** Shared RPC credit ledger — drives the owner-only /debug/rpc telemetry + the kill-switch view. */
  meter: CreditMeter;
  /** Durable RPC-credit rollup — backs the persisted last-7d spend on /debug/rpc (survives restarts). */
  creditLedger: RpcCreditLedgerRepository;
  /** VAPID public key handed to the browser so it can subscribe ('' when push is disabled). */
  vapidPublicKey: string;
  /** Send a test push to an account's own subscriptions; returns how many were targeted. */
  sendTestPush: (userId: string) => Promise<number>;
  /** Open-access mode (env OPEN_ACCESS_MODE): single-wallet accounts + notifications disabled. */
  openAccess: boolean;
};

/** Owner-only guard for operational/notification routes. Returns false (and replies 403) otherwise. */
function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.account?.isOwner) return true;
  reply.code(403).send({ error: 'forbidden' });
  return false;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {
    bus,
    engine,
    repo,
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
    creditLedger,
    vapidPublicKey,
    sendTestPush,
    openAccess,
  } = deps;

  // A watchlist changes only on add/remove (which invalidate below), so cache it briefly instead of
  // hitting the DB on every read request — at 50–100 polling users this removes a query per request.
  const watchedCache = new TtlCache<string[]>(15_000);
  const watchedOf = async (userId: string): Promise<string[]> => {
    const hit = watchedCache.get(userId);
    if (hit) return hit;
    const w = await accounts.watchedAddresses(userId);
    watchedCache.set(userId, w);
    return w;
  };

  // Resolve the wallets a request may see: a specific (owned) wallet, or the caller's whole watchlist.
  async function scopeWallets(userId: string, wallet?: string): Promise<string[]> {
    const watched = await watchedOf(userId);
    if (wallet && wallet !== 'all') return watched.includes(wallet) ? [wallet] : [];
    return watched;
  }

  // Short-lived response cache for the aggregation-heavy /stats routes. A wallet's positions changing
  // (closedChanged) bumps its version so the next read recomputes — repeated reads between writes are
  // served from memory (lightens the API for many concurrent viewers) without ever serving stale data.
  const statsCache = new VersionedCache(15_000);
  // The PnL curve is the heaviest read (full wallet_flows scan); cache it too so concurrent viewers
  // share one computation. A longer TTL bounds staleness from incremental flow top-ups; a close also
  // bumps it. Coalescing (singleFlight in VersionedCache) collapses a 50-viewer herd into one scan.
  const curveCache = new VersionedCache(30_000);
  bus.on('closedChanged', (e) => {
    statsCache.bump(e.wallet);
    curveCache.bump(e.wallet);
  });
  // Candle data for the position chart — pure TTL (market data, no per-wallet version) + coalescing,
  // so many viewers of the same pool/timeframe collapse to ONE GeckoTerminal call per minute.
  const ohlcvCache = new VersionedCache(60_000);

  app.get('/health', async () => ({ ok: true }));

  // Fires a fake event through the normal path — for verifying notifications end-to-end (owner only).
  app.post('/debug/notify', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const kind =
      EventKindSchema.safeParse((req.query as Record<string, string>).kind).data ??
      'position_close';
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
    return {
      ok: true,
      kind,
      activeDevices,
      willRoute: activeDevices.length > 0 ? 'native' : 'bark',
    };
  });

  // RPC credit telemetry: the in-memory ledger (totals + by method/codePath/wallet + live tail), the
  // pure anomaly signals, and whether the kill-switch is currently halting calls (owner only).
  app.get('/debug/rpc', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return {
      stats: meter.stats(),
      anomalies: meter.anomalies(),
      killSwitch: { blockingNow: meter.shouldBlock() },
      // Durable spend history (per day/method/wallet/codePath) from the rollup — survives restarts.
      last7d: await creditLedger.since(DEBUG_RPC_HISTORY_DAYS),
    };
  });

  // ── Watchlist (per account) ──────────────────────────────────────────────────────────────────
  // Enriched with each wallet's onboarding status so the UI can show "indexing…" for a freshly-added
  // wallet still backfilling its history (vs ready = queryable).
  app.get('/wallets', async (req) => {
    const watched = await accounts.watchedBy(req.account!.id);
    return watched.map((w) => ({ ...w, ...engine.ingestStatus(w.address) }));
  });

  app.post('/wallets', async (req, reply) => {
    const body = WalletSchema.partial({ createdAt: true, label: true }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.format() });
    const me = req.account!;
    const address = body.data.address;
    // Reject anything that isn't a real base58 Solana address before it burns a watch slot + an RPC
    // backfill (the schema only length-checks). DELETE/engine paths then only ever see valid addresses.
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ error: 'invalid Solana address' });
    }
    const already = await accounts.isWatching(me.id, address);
    if (!already && !me.isOwner) {
      // Open-access accounts are single-wallet (the registration address is auto-watched), so any
      // second wallet is rejected. The owner is exempt in either mode.
      const cap = openAccess ? 1 : MAX_WALLETS_PER_ACCOUNT;
      if ((await accounts.countWatched(me.id)) >= cap) {
        return reply.code(409).send({ error: `wallet limit reached (${cap})` });
      }
      const monitored = await accounts.monitoredWallets();
      if (!monitored.includes(address) && monitored.length >= GLOBAL_WALLET_CAP) {
        return reply.code(503).send({ error: 'capacity reached, try later' });
      }
    }
    await accounts.addWatch(me.id, {
      address,
      label: body.data.label ?? '',
      color: body.data.color,
    });
    watchedCache.delete(me.id); // the watchlist changed → drop the cached copy so reads see it now
    await engine.addWallet(address);
    return { ok: true };
  });

  app.delete<{ Params: { address: string } }>('/wallets/:address', async (req, reply) => {
    // The registration address IS the account identity — it can't be unwatched (only account deletion
    // removes it). Guard here so the UI can't strand an account with no wallets.
    if (req.params.address === req.account!.address) {
      return reply.code(400).send({ error: 'cannot remove your account wallet' });
    }
    const remaining = await accounts.removeWatch(req.account!.id, req.params.address);
    watchedCache.delete(req.account!.id); // watchlist changed → invalidate the cached copy
    // Last watcher gone → stop monitoring the wallet entirely.
    if (remaining === 0) engine.removeWallet(req.params.address);
    return { ok: true };
  });

  app.get<{ Querystring: { wallet?: string } }>('/state', async (req) => {
    const wallet = req.query.wallet;
    const wallets = await scopeWallets(req.account!.id, wallet);
    return engine.getState(wallets, wallet && wallet !== 'all' ? wallet : 'all');
  });

  // Manual force-refresh of all monitored wallets (owner only).
  app.post('/refresh', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    engine.refreshNow();
    return { ok: true };
  });

  // Whether the on-chain backfill (reconstruct-purged) is still running — lets ops know when the
  // purged-tail recovery is settled. market_pnl_sol for reachable positions is written automatically
  // by RealizedPnlEngine on every close, so there is no separate manual reprice.
  app.get('/admin/backfill/status', async () => ({ running: backfill.isRunning }));

  // The TRUE wallet PnL curve from on-chain SOL cash-flow (captures rug/slippage losses that the
  // position-level PnL misses). `days` = window length (default 30). 'all' (~3650) spans any wallet's
  // full history — the curve stops at its first tx, bounded only by the gateway's maxPages.
  app.get<{ Querystring: { wallet?: string; days?: string } }>('/wallet/pnl-curve', async (req) => {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 30));
    const wallets = await scopeWallets(req.account!.id, req.query.wallet);
    // ALL scoped wallets (not just wallets[0]) → `wallet=all` is a true multi-wallet SUM, not the
    // first wallet's curve masquerading as the aggregate.
    return curveCache.wrap(`curve|${req.query.wallet ?? 'all'}|${days}`, wallets, () =>
      walletPnl.curve(wallets, days),
    );
  });

  // The REAL Net Worth curve, reconstructed per UTC day from the ledger: NetWorth(day) = on-chain cash
  // (cumulative wallet_flows ≡ getBalance) + at-cost capital deployed in positions OPEN that day. This
  // traces true net worth (it does NOT plunge when capital is deployed into an LP). `days` = window
  // length (default 30). Same scope resolution as /wallet/pnl-curve — `wallet=all` aggregates the
  // caller's watchlist.
  app.get<{ Querystring: { wallet?: string; days?: string } }>('/networth/curve', async (req) => {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 30));
    const wallets = await scopeWallets(req.account!.id, req.query.wallet);
    const sinceSec = days >= 3650 ? 0 : Math.floor((Date.now() - days * 86_400_000) / 1000);
    // Cache + coalesce like the sibling /wallet/pnl-curve: same 30s TTL (bumped per wallet on a close),
    // so a herd of viewers collapses to ONE reconstruction scan instead of N.
    return curveCache.wrap(`networth|${req.query.wallet ?? 'all'}|${days}`, wallets, async () => ({
      points: await networthSnapshots.reconstructedCurve(wallets, sinceSec),
    }));
  });

  // OHLCV candles for a pool's position price chart (GeckoTerminal, in SOL = our range unit). Cached
  // + coalesced. Empty `candles` ⇒ the pool isn't indexed yet (brand-new) → the client falls back to
  // the dexscreener embed.
  app.get<{ Params: { pool: string }; Querystring: { tf?: string } }>(
    '/pools/:pool/ohlcv',
    async (req) => {
      const tf = req.query.tf ?? '15m';
      return ohlcvCache.wrap(`ohlcv|${req.params.pool}|${tf}`, [], async () => ({
        candles: await gecko.ohlcv(req.params.pool, tf),
      }));
    },
  );

  // SOL spot price in USD — powers the client SOL⇄USD display toggle (cached gateway, cheap).
  app.get('/sol-usd', async () => ({ price: await engine.solUsdPrice().catch(() => null) }));

  // ── Web Push (PWA notifications) ─────────────────────────────────────────────────────────────────
  // The browser fetches this to call PushManager.subscribe (empty string ⇒ push disabled server-side).
  app.get('/push/vapid-public-key', async () => ({ key: vapidPublicKey }));

  app.post<{ Body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }>(
    '/push/subscribe',
    async (req, reply) => {
      // Open-access mode disables notifications entirely — refuse subscriptions so no web push is ever
      // routed to these accounts (the UI also hides the toggle; this is the server-side guarantee).
      if (openAccess) return reply.code(403).send({ error: 'notifications disabled' });
      const b = req.body;
      const endpoint = typeof b?.endpoint === 'string' ? b.endpoint : null;
      const p256dh = typeof b?.keys?.p256dh === 'string' ? b.keys.p256dh : null;
      const auth = typeof b?.keys?.auth === 'string' ? b.keys.auth : null;
      if (!endpoint || !p256dh || !auth) {
        return reply.code(400).send({ error: 'invalid subscription' });
      }
      await pushRepo.save(req.account!.id, { endpoint, p256dh, auth } satisfies PushSub);
      return { ok: true };
    },
  );

  app.post<{ Body: { endpoint?: unknown } }>('/push/unsubscribe', async (req) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;
    if (endpoint) await pushRepo.remove(req.account!.id, endpoint);
    return { ok: true };
  });

  // Send a test push to the caller's own devices — lets the user verify the end-to-end pipeline.
  app.post('/push/test', async (req) => ({ sent: await sendTestPush(req.account!.id) }));

  // Rebuild closed-position PnL PURELY on-chain (Meteora's datapi has corrupt values, e.g. deposit=0).
  // `?all=1` rebuilds EVERY closed position; default only the purged tail Meteora can't price.
  // Heavy one-off; runs in the background (status via /admin/backfill/status).
  // Deliberately caller-scoped (watchedOf), NOT requireOwner-gated despite the /admin/ prefix.
  app.post<{ Querystring: { all?: string } }>('/admin/reconstruct-purged', async (req, reply) => {
    if (backfill.isRunning) return reply.code(409).send({ error: 'backfill already running' });
    const all = req.query.all === '1' || req.query.all === 'true';
    const wallets = await watchedOf(req.account!.id);
    void (async () => {
      for (const w of wallets) await backfill.reconstructPurged(w, { all });
    })();
    return { ok: true, wallets: wallets.length, all };
  });

  app.get<{
    Querystring: {
      wallet?: string;
      page?: string;
      pageSize?: string;
      q?: string;
      sort?: string;
      dir?: string;
      result?: string;
    };
  }>('/positions/closed', async (req) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
    const sort = (['recent', 'pnl', 'fees', 'duration'] as const).find((s) => s === req.query.sort);
    const result = (['win', 'loss'] as const).find((r) => r === req.query.result) ?? 'all';
    const wallets = await scopeWallets(req.account!.id, req.query.wallet);
    return repo.getClosed(wallets, {
      page,
      pageSize,
      q: req.query.q?.trim() || undefined,
      sort: sort ?? 'recent',
      dir: req.query.dir === 'asc' ? 'asc' : 'desc',
      result,
    });
  });

  // Full closed-history CSV export of the CURRENT filter (all matching rows — bypasses the 100 page
  // cap for an explicit one-off download). Cookie-authed, so the browser can fetch it via <a download>.
  app.get<{
    Querystring: { wallet?: string; q?: string; sort?: string; dir?: string; result?: string };
  }>('/positions/closed.csv', async (req, reply) => {
    const sort = (['recent', 'pnl', 'fees', 'duration'] as const).find((s) => s === req.query.sort);
    const result = (['win', 'loss'] as const).find((r) => r === req.query.result) ?? 'all';
    const wallets = await scopeWallets(req.account!.id, req.query.wallet);
    // Cap the one-off export: an unbounded million-row build would allocate hundreds of MB and block
    // the event loop for every other user. 50k covers any realistic wallet history; beyond that the
    // paginated /positions/closed endpoint is the path.
    const CSV_MAX_ROWS = 50_000;
    const { rows } = await repo.getClosed(wallets, {
      page: 1,
      pageSize: CSV_MAX_ROWS,
      q: req.query.q?.trim() || undefined,
      sort: sort ?? 'recent',
      dir: req.query.dir === 'asc' ? 'asc' : 'desc',
      result,
    });
    const cell = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');
    const lines = [
      'Pair,Strategy,Invested SOL,Withdrawn SOL,Fees SOL,PnL SOL,PnL %,Opened,Closed,Duration s,Position',
    ];
    for (const r of rows) {
      lines.push(
        [
          `${r.tokenX}/${r.tokenY}`,
          r.strategy ?? '',
          r.depositSol,
          r.withdrawSol,
          r.feesSol,
          r.pnlSol,
          r.pnlPctSol,
          iso(r.openedAt),
          iso(r.closedAt),
          r.durationSeconds,
          r.positionAddress,
        ]
          .map(cell)
          .join(','),
      );
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="binsight-closed-positions.csv"')
      .send(lines.join('\n'));
  });

  // On-chain reads keyed by an exact position pubkey. The data is public on-chain, but the route is
  // still scoped to the caller's watchlist: an authenticated tenant must not read another tenant's
  // position bins/timeline by guessing a position pubkey. 404 (not 403) so we don't confirm existence.
  app.get<{ Params: { address: string } }>('/positions/:address/bins', async (req, reply) => {
    const owner = await repo.walletOfPosition(req.params.address);
    if (!owner || !(await accounts.isWatching(req.account!.id, owner))) {
      return reply.code(404).send({ error: 'position not found' });
    }
    try {
      const bins = await engine.positionBins(req.params.address);
      if (!bins) return reply.code(404).send({ error: 'position not found or closed' });
      return bins;
    } catch (err) {
      req.log.warn({ err, address: req.params.address }, 'positionBins failed');
      return reply.code(502).send({ error: 'upstream RPC error' });
    }
  });

  app.get<{ Params: { address: string } }>('/positions/:address/history', async (req, reply) => {
    const owner = await repo.walletOfPosition(req.params.address);
    if (!owner || !(await accounts.isWatching(req.account!.id, owner))) {
      return reply.code(404).send({ error: 'position not found' });
    }
    try {
      const history = await engine.positionHistory(req.params.address);
      if (!history) return reply.code(404).send({ error: 'no history for this position' });
      return history;
    } catch (err) {
      req.log.warn({ err, address: req.params.address }, 'positionHistory failed');
      return reply.code(502).send({ error: 'upstream RPC error' });
    }
  });

  // Single closed position by address — only if the caller watches its wallet.
  app.get<{ Params: { address: string } }>('/positions/:address', async (req) => {
    const closed = await repo.getClosedByAddress(req.params.address);
    if (closed && !(await accounts.isWatching(req.account!.id, closed.wallet)))
      return { closed: null };
    return { closed };
  });

  // PnL share card (PNG) for a closed position the caller watches.
  app.get<{ Params: { address: string } }>('/positions/:address/card.png', async (req, reply) => {
    const closed = await repo.getClosedByAddress(req.params.address);
    if (!closed || !(await accounts.isWatching(req.account!.id, closed.wallet))) {
      return reply.code(404).send({ error: 'closed position not found' });
    }
    const solUsd = await engine.solUsdPrice().catch(() => null);
    const png = await renderClosedPnlCard(closed, solUsd);
    return reply.type('image/png').header('cache-control', 'private, max-age=60').send(png);
  });

  app.get<{ Querystring: { wallet?: string; since?: string } }>('/stats', async (req) => {
    const since = Number(req.query.since) || 0;
    const wallets = await scopeWallets(req.account!.id, req.query.wallet);
    return statsCache.wrap(`stats|${req.query.wallet ?? 'all'}|${since}`, wallets, async () => ({
      scope: req.query.wallet ?? 'all',
      ...(await repo.statsAggregate(wallets, since)),
    }));
  });

  app.get<{ Querystring: { wallet?: string; bucket?: string; since?: string } }>(
    '/stats/history',
    async (req) => {
      const bucket: Bucket = isBucket(req.query.bucket ?? '')
        ? (req.query.bucket as Bucket)
        : 'day';
      const since = Number(req.query.since) || 0;
      const wallets = await scopeWallets(req.account!.id, req.query.wallet);
      return statsCache.wrap(
        `stats-history|${req.query.wallet ?? 'all'}|${bucket}|${since}`,
        wallets,
        async () =>
          profitHistory(await repo.profitBuckets(wallets, BUCKET_MS[bucket]), bucket, since),
      );
    },
  );

  // ── Notifications & settings (owner only — not exposed in the public web) ─────────────────────
  app.get('/config/notifications', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return configRepo.listNotifRules();
  });

  app.put('/config/notifications', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const rule = NotifRuleSchema.safeParse(req.body);
    if (!rule.success) return reply.code(400).send({ error: rule.error.format() });
    await configRepo.saveNotifRule(rule.data);
    notifications.reloadRules();
    return { ok: true };
  });

  app.get('/config/settings', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return configRepo.getSettings();
  });

  app.put('/config/settings', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const parsed = RuntimeSettingsSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
    return configRepo.saveSettings(parsed.data);
  });

  // ── Admin (owner only): unified access + wallet overview ──────────────────────────────────────
  // One list over invites (whitelist) + accounts; one revoke removes BOTH so access truly ends.
  app.get('/admin/access', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return accounts.listAccess();
  });

  // Invite: whitelist an address so it can register.
  app.post<{ Body: { address?: unknown; note?: unknown } }>('/admin/access', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const address = req.body?.address;
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ error: 'invalid Solana address' });
    }
    await accounts.addWhitelist({
      address,
      note: (typeof req.body?.note === 'string' ? req.body.note : '').slice(0, 200),
      addedBy: req.account!.address,
    });
    return { ok: true };
  });

  // Revoke access for an address: delete its account (if any) AND remove the invite — the person loses
  // access and can't re-register. SHARED wallet data is kept; live monitoring of orphan wallets stops.
  app.delete<{ Params: { address: string } }>('/admin/access/:address', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const found = await accounts.findByAddress(req.params.address);
    if (found?.user.isOwner) return reply.code(400).send({ error: 'cannot revoke the owner' });
    let stopped: string[] = [];
    if (found) stopped = await accounts.deleteAccount(found.user.id);
    await accounts.removeWhitelist(req.params.address);
    for (const w of stopped) engine.removeWallet(w);
    return { ok: true, stoppedMonitoring: stopped.length };
  });

  // Operational overview of every monitored wallet — watchers + open/closed positions + last sync, plus
  // live ingest status (ready / indexing N txs) from the engine.
  app.get('/admin/wallets', async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const rows = await accounts.walletOverview();
    return rows.map((w) => ({ ...w, ...engine.ingestStatus(w.address) }));
  });
}
