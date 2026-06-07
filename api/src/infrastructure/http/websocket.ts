import type { FastifyInstance } from 'fastify';
import { ClientMessageSchema } from '@meteora/shared';
import type { WebSocket } from 'ws';
import type { AppConfig } from '@/config/env';
import type { Engine } from '@/application/engine';
import type { EventBus } from '@/application/event-bus';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';

interface WsClient {
  socket: WebSocket;
  scope: string;
}

function send(socket: WebSocket, data: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
}

function broadcast(clients: Set<WsClient>, data: unknown): void {
  for (const c of clients) send(c.socket, data);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function registerWebSocket(
  app: FastifyInstance,
  config: AppConfig,
  engine: Engine,
  bus: EventBus,
  presence: PresenceTracker,
): void {
  const clients = new Set<WsClient>();

  // logLevel:silent — the upgrade URL carries ?token=, keep it out of request logs.
  app.get('/live', { websocket: true, logLevel: 'silent' }, (socket: WebSocket, req) => {
    if ((req.query as { token?: string }).token !== config.API_TOKEN) {
      socket.close(1008, 'unauthorized');
      return;
    }
    const client: WsClient = { socket, scope: 'all' };
    clients.add(client);
    send(socket, { type: 'state', payload: engine.getState('all') });

    socket.on('message', (raw: Buffer) => {
      const parsed = ClientMessageSchema.safeParse(safeJson(raw.toString()));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === 'subscribe') {
        client.scope = msg.scope;
        send(socket, { type: 'state', payload: engine.getState(msg.scope) });
      } else if (msg.type === 'presence') {
        presence.heartbeat(msg.device, msg.active);
      }
    });

    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  bus.on('state', (state) => {
    for (const c of clients) {
      if (c.scope === state.scope) send(c.socket, { type: 'state', payload: state });
      else if (c.scope === 'all') send(c.socket, { type: 'state', payload: engine.getState('all') });
    }
  });
  // Raw live feed — drives history refetch on the client, never a banner (ungated).
  bus.on('event', (event) => broadcast(clients, { type: 'event', payload: event }));
  // Rule-gated notifications — the client shows these as native banners.
  bus.on('notify', (event) => broadcast(clients, { type: 'notify', payload: event }));
  // Prompt clients to refetch closed history the instant a close lands (no banner).
  bus.on('closedChanged', () => broadcast(clients, { type: 'closed_changed' }));
  bus.on('health', (health) => broadcast(clients, { type: 'health', payload: health }));
}
