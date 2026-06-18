import type { Health, LiveEvent, WalletState } from '@meteora/shared';
import { authApi } from '@/infrastructure/api/client';

export type LiveHandlers = {
  onState: (state: WalletState) => void;
  onHealth: (health: Health) => void;
  onEvent: (event: LiveEvent) => void;
  onClosedChanged: () => void;
  onConnectionChange: (connected: boolean) => void;
};

const WS_BASE = process.env.NEXT_PUBLIC_API_WS_URL ?? 'ws://localhost:8787';
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const PING_MS = 25000;

/**
 * Live WebSocket client. Fetches a short-lived ticket from the BFF, connects to the API's `/live`
 * feed, and reconnects with capped backoff. Mirrors the server protocol (state/health/event/
 * notify/closed_changed). One instance per session, owned by the portfolio store.
 */
export class LiveClient {
  private socket: WebSocket | null = null;
  private scope = 'all';
  private attempt = 0;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly handlers: LiveHandlers) {}

  async connect(scope = 'all'): Promise<void> {
    this.scope = scope;
    this.stopped = false;
    await this.open();
  }

  subscribe(scope: string): void {
    this.scope = scope;
    this.send({ type: 'subscribe', scope });
  }

  disconnect(): void {
    this.stopped = true;
    this.clearPing();
    this.socket?.close();
    this.socket = null;
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    try {
      const ticket = await authApi.wsTicket();
      if (!ticket) {
        this.scheduleReconnect();
        return;
      }

      const socket = new WebSocket(`${WS_BASE}/live?token=${encodeURIComponent(ticket)}`);
      this.socket = socket;

      socket.onopen = () => {
        this.attempt = 0;
        this.handlers.onConnectionChange(true);
        this.send({ type: 'subscribe', scope: this.scope });
        this.send({ type: 'presence', device: 'web', active: true });
        this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS);
      };
      socket.onmessage = (ev) => this.dispatch(ev.data);
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        this.clearPing();
        this.handlers.onConnectionChange(false);
        if (!this.stopped) this.scheduleReconnect();
      };
    } catch {
      // A thrown ticket-fetch / socket-construction error must retry like a null ticket.
      this.scheduleReconnect();
    }
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: { type?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'state':
        this.handlers.onState(msg.payload as WalletState);
        break;
      case 'health':
        this.handlers.onHealth(msg.payload as Health);
        break;
      case 'event':
      case 'notify':
        this.handlers.onEvent(msg.payload as LiveEvent);
        break;
      case 'closed_changed':
        this.handlers.onClosedChanged();
        break;
    }
  }

  private send(msg: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    setTimeout(() => void this.open(), delay);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
