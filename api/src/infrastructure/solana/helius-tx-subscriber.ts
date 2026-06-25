/**
 * Copy-bot · Phase 1.2 (C) — isolated WebSocket client over Helius `transactionSubscribe` (LaserStream).
 *
 * Why a separate client: `transactionSubscribe` is a Helius (LaserStream) method, with a notification format
 * different from `logsSubscribe`. We do NOT touch the prod `HeliusSubscriber` (used by binsight's live) — we
 * isolate the bot's transport here. Available on the **Developer** plan (since April 2026), same endpoint
 * `wss://mainnet.helius-rpc.com`.
 *
 * Role: low-latency trigger. Completeness stays guaranteed by the LeaderDetector's cursor poll; this client
 * only delivers early (signature + logs) what the poll would re-cover. Resilience modeled on
 * `HeliusSubscriber` (backoff + jitter reconnect, anti-silence heartbeat, re-subscribe on reconnect).
 */
import type { Logger } from 'pino';
import { WebSocket } from 'undici';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const HEARTBEAT_MS = 30_000;
const SILENCE_TIMEOUT_MS = 300_000;

/** Called per tx of the watched wallet: the signature + the logs (to filter DLMM on the consumer side). */
export type TxActivityCb = (signature: string, logs: string[]) => void;

/** Subscription confirmation `{ id, result: subscriptionId }` → null otherwise. (Pure, testable.) */
export function parseSubAck(msg: Record<string, unknown>): { id: number; subId: number } | null {
  if (typeof msg.id === 'number' && typeof msg.result === 'number') {
    return { id: msg.id, subId: msg.result };
  }
  return null;
}

export interface ParsedTxNotification {
  subId: number;
  signature: string;
  logs: string[];
}

/** Extracts (subId, signature, logs) from a Helius `transactionNotification` → null if it is not one.
 *  Documented format: params.result.{signature, transaction.meta.logMessages}. (Pure, testable.) */
export function parseTxNotification(msg: Record<string, unknown>): ParsedTxNotification | null {
  if (msg.method !== 'transactionNotification') return null;
  const params = msg.params as Record<string, unknown> | undefined;
  const result = params?.result as Record<string, unknown> | undefined;
  const subId = params?.subscription;
  if (result === undefined || typeof subId !== 'number') return null;
  const signature = (result.signature as string) ?? '';
  if (!signature) return null;
  const transaction = result.transaction as Record<string, unknown> | undefined;
  const meta = transaction?.meta as Record<string, unknown> | undefined;
  const logs = (meta?.logMessages as string[]) ?? [];
  return { subId, signature, logs };
}

export class HeliusTxSubscriber {
  private ws: WebSocket | undefined;
  private readonly watched = new Map<string, TxActivityCb>();
  private readonly subToWallet = new Map<number, string>();
  private readonly reqToWallet = new Map<number, string>();
  private nextReqId = 1;
  private backoffMs = BACKOFF_BASE_MS;
  private connected = false;
  private stopped = false;
  private lastMessageAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly reconnectCbs: Array<() => void> = [];
  private readonly connChangeCbs: Array<(connected: boolean) => void> = [];

  constructor(
    private readonly wsUrl: string,
    private readonly logger: Logger,
  ) {}

  onReconnect(cb: () => void): void {
    this.reconnectCbs.push(cb);
  }
  onConnectionChange(cb: (connected: boolean) => void): void {
    this.connChangeCbs.push(cb);
  }
  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
  watch(wallet: string, onActivity: TxActivityCb): void {
    this.watched.set(wallet, onActivity);
    if (this.connected) this.subscribe(wallet);
  }

  private connect(): void {
    if (this.stopped) return;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.addEventListener('open', () => {
      this.setConnected(true);
      this.backoffMs = BACKOFF_BASE_MS;
      this.lastMessageAt = Date.now();
      for (const wallet of this.watched.keys()) this.subscribe(wallet);
      for (const cb of this.reconnectCbs) cb(); // catches up via the poll on what may have slipped through during the outage
      this.startHeartbeat();
    });
    this.ws.addEventListener('message', (ev) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    });
    this.ws.addEventListener('close', () => this.scheduleReconnect());
    this.ws.addEventListener('error', () => {
      /* close handler drives reconnection */
    });
  }

  private setConnected(c: boolean): void {
    if (this.connected !== c) {
      this.connected = c;
      for (const cb of this.connChangeCbs) cb(c);
    }
  }

  private scheduleReconnect(): void {
    this.setConnected(false);
    this.subToWallet.clear();
    this.reqToWallet.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stopped) return;
    const jitter = Math.floor(this.backoffMs * 0.25 * ((this.nextReqId % 7) / 7));
    const delay = Math.min(this.backoffMs, BACKOFF_MAX_MS) + jitter;
    this.logger.debug({ delay }, 'tx WS disconnected — reconnecting');
    setTimeout(() => this.connect(), delay);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.watched.size === 0) return;
      if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
        this.logger.warn('tx WS silent too long — forcing reconnect');
        this.ws?.close();
      }
    }, HEARTBEAT_MS);
  }

  private subscribe(wallet: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.nextReqId++;
    this.reqToWallet.set(id, wallet);
    this.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'transactionSubscribe',
        params: [
          { accountInclude: [wallet], vote: false, failed: false },
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    );
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const ack = parseSubAck(msg);
    if (ack) {
      const wallet = this.reqToWallet.get(ack.id);
      this.reqToWallet.delete(ack.id);
      if (wallet && this.watched.has(wallet)) this.subToWallet.set(ack.subId, wallet);
      return;
    }
    const notif = parseTxNotification(msg);
    if (!notif) return;
    const wallet = this.subToWallet.get(notif.subId);
    if (wallet) this.watched.get(wallet)?.(notif.signature, notif.logs);
  }
}
