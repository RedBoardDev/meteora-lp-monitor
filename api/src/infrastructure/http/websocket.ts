import { ClientMessageSchema } from '@binsight/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Engine } from '@/application/engine';
import type { EventBus } from '@/application/event-bus';
import type { AccountRepository } from '@/domain/ports';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';
import { verifyJwt } from './auth';

interface WsClient {
  socket: WebSocket;
  userId: string;
  /** The connecting token's jti + version — re-checked on a timer so revocation reaches a live socket. */
  jti: string;
  ver: number;
  /** Resolved once at connect — only the owner's heartbeats gate Bark (notifications are owner-only). */
  isOwner: boolean;
  watched: Set<string>;
  /** What the client is viewing: 'all' (its whole watchlist) or one watched address. */
  view: string;
}

/** How often live sockets are re-checked against the account store (revocation + watchlist drift). */
const REVALIDATE_MS = 30_000;

/**
 * A live socket stays authorized only while its account still exists, its token version still matches
 * (a password reset bumps it), and its session jti is still allow-listed (logout / owner-revoke deletes
 * it). The HTTP Bearer hook enforces exactly this, but /live bypasses that hook and authenticates once
 * at upgrade — so without re-checking, a revoked token would keep streaming until the JWT's exp.
 */
export async function sessionStillValid(
  accounts: Pick<AccountRepository, 'findById' | 'isSessionValid'>,
  userId: string,
  ver: number,
  jti: string,
): Promise<boolean> {
  const u = await accounts.findById(userId);
  if (!u || u.tokenVersion !== ver) return false;
  return accounts.isSessionValid(jti);
}

// Shed frames to a client that isn't draining (bufferedAmount past this) instead of growing the heap
// unbounded — a 'state' push is fully superseded by the next one, and a degraded socket is better shed
// than letting one stuck client OOM the process at 50–100 connections.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function send(socket: WebSocket, data: unknown): void {
  if (socket.readyState === socket.OPEN && socket.bufferedAmount <= MAX_BUFFERED_BYTES)
    socket.send(JSON.stringify(data));
}

// Broadcast a payload that is IDENTICAL for every recipient: serialize it ONCE and send the same
// frame to all matching sockets, instead of re-JSON.stringify-ing per client. During trading bursts
// (many event/notify across many wallets) this removes N-1 redundant serializations per broadcast.
function sendRaw(socket: WebSocket, frame: string): void {
  if (socket.readyState === socket.OPEN && socket.bufferedAmount <= MAX_BUFFERED_BYTES)
    socket.send(frame);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The /live auth token. Native clients (URLSessionWebSocketTask) send it in the Authorization header
 *  so a long-lived JWT never lands in URLs / proxy access logs (S10); browsers can't set WS request
 *  headers, so they pass a short-lived ws-ticket in ?token=. Prefer the header, fall back to the query. */
export function liveToken(
  authHeader: string | undefined,
  queryToken: string | undefined,
): string | undefined {
  if (authHeader?.startsWith('Bearer '))
    return authHeader.slice('Bearer '.length).trim() || undefined;
  return queryToken;
}

export function registerWebSocket(
  app: FastifyInstance,
  secret: string,
  engine: Engine,
  bus: EventBus,
  presence: PresenceTracker,
  accounts: AccountRepository,
  allowedOrigins: string[],
): void {
  const clients = new Set<WsClient>();
  const watchedOf = async (userId: string): Promise<Set<string>> =>
    new Set(await accounts.watchedAddresses(userId));

  // Recompute the wallets currently being viewed (an 'all'-scope client views its whole watchlist; a
  // focused client views one) and hand them to the engine, which gates the recurring net-worth snapshot
  // on this set — idle/unwatched wallets then cost no RPC.
  const pushViewers = (): void => {
    const viewed = new Set<string>();
    for (const c of clients) {
      if (c.view === 'all') for (const w of c.watched) viewed.add(w);
      else viewed.add(c.view);
    }
    engine.setViewedWallets(viewed);
  };

  // logLevel:silent — a browser passes a short-lived ws-ticket in ?token=; keep it out of request logs.
  app.get('/live', { websocket: true, logLevel: 'silent' }, async (socket: WebSocket, req) => {
    // Browsers send Origin on a WS upgrade; reject any that isn't allow-listed (defence-in-depth on top
    // of the SameSite cookie that gates the ws-ticket). Native clients send no Origin → allowed.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !allowedOrigins.includes(origin)) {
      socket.close(1008, 'forbidden origin');
      return;
    }
    // Native clients send the JWT in the Authorization header (kept out of URLs/logs, S10); browsers
    // can't set WS headers, so they pass a short-lived ws-ticket in ?token=.
    const token = liveToken(req.headers.authorization, (req.query as { token?: string }).token);
    const payload = token ? verifyJwt(secret, token) : null;
    if (!payload) {
      socket.close(1008, 'unauthorized');
      return;
    }
    const userId = payload.sub;
    const me = await accounts.findById(userId);
    // /live bypasses the Bearer hook, so enforce the SAME revocation checks here (token version + jti
    // allowlist), not just the JWT signature — else a logged-out / reset / revoked token streams to exp.
    if (!me || me.tokenVersion !== payload.ver || !(await accounts.isSessionValid(payload.jti))) {
      socket.close(1008, 'unauthorized');
      return;
    }
    const client: WsClient = {
      socket,
      userId,
      jti: payload.jti,
      ver: payload.ver,
      isOwner: me.isOwner,
      watched: await watchedOf(userId),
      view: 'all',
    };
    clients.add(client);
    pushViewers();
    send(socket, { type: 'state', payload: engine.getState([...client.watched], 'all') });

    socket.on('message', async (raw: Buffer) => {
      const parsed = ClientMessageSchema.safeParse(safeJson(raw.toString()));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === 'subscribe') {
        client.watched = await watchedOf(userId); // pick up watchlist changes
        if (msg.scope === 'all') {
          client.view = 'all';
          send(socket, { type: 'state', payload: engine.getState([...client.watched], 'all') });
        } else if (client.watched.has(msg.scope)) {
          client.view = msg.scope;
          send(socket, { type: 'state', payload: engine.getState([msg.scope], msg.scope) });
        }
        pushViewers();
      } else if (msg.type === 'presence' && client.isOwner) {
        // Notifications are owner-only, so ONLY the owner's devices gate Bark. Without this guard a
        // public web viewer's heartbeat marks presence "active" and silently suppresses the owner's
        // Bark push (cross-tenant alert loss).
        presence.heartbeat(msg.device, msg.active);
      }
    });

    socket.on('close', () => {
      clients.delete(client);
      pushViewers();
    });
    socket.on('error', () => {
      clients.delete(client);
      pushViewers();
    });
  });

  // Per-wallet state emit (scope = the wallet address) → only clients watching that wallet.
  bus.on('state', (state) => {
    // The 'all'-scope aggregate is identical for every client sharing a watchlist — compute it ONCE per
    // distinct watched-set per emit (the owner's open tabs + macOS all watch the same list), not N times.
    const aggByWatch = new Map<string, ReturnType<typeof engine.getState>>();
    for (const c of clients) {
      if (!c.watched.has(state.scope)) continue;
      if (c.view === 'all') {
        const key = [...c.watched].sort().join(',');
        let agg = aggByWatch.get(key);
        if (!agg) {
          agg = engine.getState([...c.watched], 'all');
          aggByWatch.set(key, agg);
        }
        send(c.socket, { type: 'state', payload: agg });
      } else if (c.view === state.scope) {
        send(c.socket, { type: 'state', payload: state });
      }
    }
  });
  // Raw live feed — drives history refetch on the client, never a banner. Scoped to the wallet.
  bus.on('event', (event) => {
    const frame = JSON.stringify({ type: 'event', payload: event });
    for (const c of clients) {
      if (event.wallet === null || c.watched.has(event.wallet)) sendRaw(c.socket, frame);
    }
  });
  // Rule-gated notifications (owner-driven). Scoped to the wallet so they never leak across tenants.
  bus.on('notify', (event) => {
    const frame = JSON.stringify({ type: 'notify', payload: event });
    for (const c of clients) {
      if (event.wallet === null || c.watched.has(event.wallet)) sendRaw(c.socket, frame);
    }
  });
  // Prompt clients to refetch closed history the instant a close lands on a wallet they watch.
  bus.on('closedChanged', (e) => {
    const frame = JSON.stringify({ type: 'closed_changed' });
    for (const c of clients) if (c.watched.has(e.wallet)) sendRaw(c.socket, frame);
  });
  // Health — filter the per-wallet sync list to the client's watchlist (no global wallet leak). The
  // filtered frame is identical for clients sharing a watchlist, so serialize it ONCE per distinct
  // watched-set (this fires every 1s for every client, so the per-client re-stringify added up).
  bus.on('health', (health) => {
    const frameByWatch = new Map<string, string>();
    for (const c of clients) {
      const key = [...c.watched].sort().join(',');
      let frame = frameByWatch.get(key);
      if (frame === undefined) {
        frame = JSON.stringify({
          type: 'health',
          payload: { ...health, wallets: health.wallets.filter((w) => c.watched.has(w.wallet)) },
        });
        frameByWatch.set(key, frame);
      }
      sendRaw(c.socket, frame);
    }
  });

  // Revocation + watchlist changes don't reach an already-open socket (it authenticates once at
  // upgrade), so re-check every client on a timer: close any whose account/session was revoked, and
  // refresh each client's watched set so a removed wallet stops streaming (a newly-added one starts).
  const revalidate = setInterval(async () => {
    if (clients.size === 0) return;
    const watchedByUser = new Map<string, Set<string>>();
    for (const c of [...clients]) {
      if (c.socket.readyState !== c.socket.OPEN) continue;
      if (!(await sessionStillValid(accounts, c.userId, c.ver, c.jti))) {
        c.socket.close(1008, 'session revoked');
        continue;
      }
      let watched = watchedByUser.get(c.userId);
      if (!watched) {
        watched = await watchedOf(c.userId);
        watchedByUser.set(c.userId, watched);
      }
      c.watched = watched;
    }
    pushViewers();
  }, REVALIDATE_MS);
  revalidate.unref(); // never keep the process alive just for the revalidation timer
  app.addHook('onClose', async () => {
    clearInterval(revalidate);
  });
}
