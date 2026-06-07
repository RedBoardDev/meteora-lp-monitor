import { DLMM_PROGRAM_ID } from '@meteora/shared';
import type { Logger } from 'pino';
import { WebSocket } from 'undici';
import type { RpcSubscriber } from '@/domain/ports';

type ActivityCb = (signature: string, instruction: string) => void;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const HEARTBEAT_MS = 30_000;
// A Solana logsSubscribe stream is legitimately silent when there's no activity, so
// silence alone isn't a death signal. Only force a reconnect after a long silence AND
// only when we actually have subscriptions (the poll is the real completeness backstop).
const SILENCE_TIMEOUT_MS = 300_000;

/**
 * Single resilient WS connection multiplexing logsSubscribe for many wallets.
 * Reconnects forever with exponential backoff + jitter; re-subscribes everything
 * and fires onReconnect (so the engine can trigger an immediate catch-up poll).
 * A WS gap never causes a data gap — the poll is the backstop.
 */
export class HeliusSubscriber implements RpcSubscriber {
  private ws: WebSocket | null = null;
  private readonly watched = new Map<string, ActivityCb>();
  private readonly subToWallet = new Map<number, string>();
  private readonly reqToWallet = new Map<number, string>();
  private nextReqId = 1;
  private backoffMs = BACKOFF_BASE_MS;
  private connected = false;
  private stopped = false;
  private lastMessageAt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly reconnectCbs: Array<() => void> = [];
  private readonly connChangeCbs: Array<(c: boolean) => void> = [];

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
    this.ws = null;
  }

  watch(wallet: string, onActivity: ActivityCb): void {
    this.watched.set(wallet, onActivity);
    if (this.connected) this.subscribe(wallet);
  }

  unwatch(wallet: string): void {
    this.watched.delete(wallet);
    for (const [subId, w] of this.subToWallet) {
      if (w === wallet) this.subToWallet.delete(subId);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.addEventListener('open', () => {
      this.setConnected(true);
      this.backoffMs = BACKOFF_BASE_MS;
      this.lastMessageAt = Date.now();
      for (const wallet of this.watched.keys()) this.subscribe(wallet);
      // Let the engine catch up anything missed while we were down.
      for (const cb of this.reconnectCbs) cb();
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
    this.logger.debug({ delay }, 'Solana WS disconnected — reconnecting');
    setTimeout(() => this.connect(), delay);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.watched.size === 0) return;
      if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
        this.logger.warn('Solana WS silent too long — forcing reconnect');
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
        method: 'logsSubscribe',
        params: [{ mentions: [wallet] }, { commitment: 'confirmed' }],
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
    // Subscription confirmation: { id, result: subscriptionId }
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      const wallet = this.reqToWallet.get(msg.id);
      if (wallet) {
        this.subToWallet.set(msg.result, wallet);
        this.reqToWallet.delete(msg.id);
      }
      return;
    }
    if (msg.method !== 'logsNotification') return;
    const params = msg.params as Record<string, unknown> | undefined;
    const result = (params?.result as Record<string, unknown> | undefined)?.value as
      | Record<string, unknown>
      | undefined;
    const subId = (params?.subscription as number) ?? -1;
    const wallet = this.subToWallet.get(subId);
    if (!wallet || !result) return;

    const logs = (result.logs as string[]) ?? [];
    const signature = (result.signature as string) ?? '';
    if (!signature || !logs.some((l) => l.includes(DLMM_PROGRAM_ID))) return;
    const instruction = parseInstruction(logs);
    if (!instruction) return;
    this.watched.get(wallet)?.(signature, instruction);
  }
}

function parseInstruction(logs: string[]): string | null {
  let inDlmm = false;
  for (const l of logs) {
    if (l.includes(`Program ${DLMM_PROGRAM_ID} invoke`)) inDlmm = true;
    else if (l.includes(`Program ${DLMM_PROGRAM_ID} success`)) inDlmm = false;
    else if (inDlmm && l.startsWith('Program log: Instruction:')) {
      return l.replace('Program log: Instruction:', '').trim();
    }
  }
  return null;
}

export function classifyInstruction(
  instr: string,
): 'open' | 'close' | 'add' | 'remove' | 'claim' | null {
  const i = instr.toLowerCase();
  if (i.startsWith('initializeposition') || i.startsWith('openposition')) return 'open';
  if (i.startsWith('closeposition')) return 'close';
  if (i.startsWith('addliquidity')) return 'add';
  if (i.startsWith('removeliquidity')) return 'remove';
  if (i.startsWith('claimfee') || i.startsWith('claimreward')) return 'claim';
  return null;
}
