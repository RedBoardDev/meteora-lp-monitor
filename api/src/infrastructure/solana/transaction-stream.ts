import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { Logger } from 'pino';
import type { WalletStreamCursor } from '@/infrastructure/persistence/wallet-stream-cursor-repository';

/**
 * Helius `transactionSubscribe` backbone — ONE WebSocket multiplexing every watched wallet, the trigger
 * for the existing cursor-based delta ingest. It is the #1 no-miss surface of the watcher, so the no-miss
 * machinery is self-contained and fully driven by injected interfaces (so it is testable with a mock
 * transport + a fake cursor store, NEVER a real connection):
 *
 *  - durable per-wallet checkpoint (`wallet_stream_cursor`) advanced on every notification (crash-safe);
 *  - signature dedup (bounded in-session set + the persisted cursor) for at-least-once delivery;
 *  - reconnect → resubscribe with `fromSlot = min(lastSlot)` so every tx since the last processed slot is
 *    re-delivered (then deduped);
 *  - a gap detector that REPLACES the old blind fleet sweep: it only spends RPC when a gap is SUSPECTED —
 *    an outage longer than the replay window, or a slot-watermark check finding the chain tip far past a
 *    wallet's cursor with no events — firing a bounded per-wallet recovery instead of an unconditional poll.
 *
 * This step does NOT re-parse the WS payload into legs/swaps (a later optimization): a DLMM notification
 * for wallet X simply (a) advances X's durable cursor and (b) invokes X's activity handler, which triggers
 * the cheap delta ingest + close-detection downstream.
 */

/** Helius caps `accountInclude`/`accountExclude`/`accountRequired` at 50,000 addresses per filter. */
export const MAX_ADDRESSES_PER_FILTER = 50_000;

// ── Tunable defaults (named — no magic numbers). All overridable via TransactionStreamConfig. ──
/** Keepalive ping cadence (Helius docs example pings every 30s to hold the socket open). */
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** Slot-watermark gap scan cadence — cheap (in-memory) so it can run often. */
const DEFAULT_GAP_CHECK_INTERVAL_MS = 60_000;
/**
 * Conservative `fromSlot` replay horizon. The public docs do NOT pin the exact retention of the enhanced
 * WS replay buffer, so we treat it as an ASSUMPTION and design the backfill as the safety net: an outage
 * SHORTER than this is recovered for free by replay; an outage LONGER triggers a bounded RPC backfill.
 * Erring SMALL is the safe direction — over-estimating the true retention would let a long outage rely on
 * a replay that cannot cover it (a miss); under-estimating only costs an extra, idempotent, ~0-result
 * `getSignaturesForAddress(until=lastSig)` per cursored wallet. See the Step-5 report for the assumption.
 */
const DEFAULT_REPLAY_WINDOW_MS = 5 * 60_000;
/**
 * Slot lag past which a cursor is "suspiciously behind" the live stream tip. ~9000 slots ≈ 1h at the
 * ~400ms Solana slot time. Large on purpose: the watermark check is a backstop for a silently-dropped
 * notification (socket stayed up), NOT a per-tick poll — so it must not fire for merely-idle wallets.
 */
const DEFAULT_GAP_SUSPECT_SLOTS = 9_000;
/** Bounded in-session dedup window (recent signatures). Survives reconnects; reset only by a restart. */
const DEFAULT_RECENT_SIG_CAPACITY = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

/** Why a wallet's activity handler fired — lets downstream/tests tell a live notification apart from a
 *  gap-detector recovery (both run the same cheap delta ingest; the reason is for telemetry + assertions). */
export type StreamActivityReason = 'ws' | 'gap-backfill';

/** Invoked for each watched wallet a DLMM tx touches (or that the gap detector wants recovered). */
export type StreamActivityHandler = (wallet: string, reason: StreamActivityReason) => void;

/** The minimal cursor persistence the stream needs (the WalletStreamCursorRepository satisfies it). */
export interface WalletStreamCursorStore {
  get(wallet: string): Promise<WalletStreamCursor | null>;
  set(wallet: string, cursor: WalletStreamCursor): Promise<void>;
}

/** One WebSocket connection, abstracted so tests inject a mock and NO real socket is ever opened here. */
export interface WsTransport {
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  send(data: string): void;
  /** Keepalive frame. */
  ping(): void;
  close(): void;
}

/** Creates a fresh transport per (re)connect — the ONLY place a real socket would be opened (production). */
export type WsTransportFactory = () => WsTransport;

export interface TransactionStreamConfig {
  commitment: 'processed' | 'confirmed' | 'finalized';
  encoding: 'base58' | 'base64' | 'jsonParsed';
  /** Required by Helius to return account/full details for legacy + v0 txs. */
  maxSupportedTransactionVersion: number;
  addressesPerFilter: number;
  pingIntervalMs: number;
  gapCheckIntervalMs: number;
  replayWindowMs: number;
  gapSuspectSlots: number;
  recentSigCapacity: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_STREAM_CONFIG: TransactionStreamConfig = {
  commitment: 'confirmed',
  encoding: 'jsonParsed',
  maxSupportedTransactionVersion: 0,
  addressesPerFilter: MAX_ADDRESSES_PER_FILTER,
  pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
  gapCheckIntervalMs: DEFAULT_GAP_CHECK_INTERVAL_MS,
  replayWindowMs: DEFAULT_REPLAY_WINDOW_MS,
  gapSuspectSlots: DEFAULT_GAP_SUSPECT_SLOTS,
  recentSigCapacity: DEFAULT_RECENT_SIG_CAPACITY,
  backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
};

export interface TransactionStreamDeps {
  transportFactory: WsTransportFactory;
  cursors: WalletStreamCursorStore;
  logger: Logger;
  /** Injectable clock so outage-window logic is deterministic in tests. */
  now?: () => number;
  config?: Partial<TransactionStreamConfig>;
}

/** A parsed DLMM transaction notification — the signature + slot + the watched accounts it touched. */
export interface ParsedTxNotification {
  signature: string;
  slot: number;
  accounts: string[];
}

export class TransactionStream {
  private readonly cfg: TransactionStreamConfig;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly transportFactory: WsTransportFactory;
  private readonly cursors: WalletStreamCursorStore;

  /** wallet → its activity handler. Source of truth for the watched set. */
  private readonly watched = new Map<string, StreamActivityHandler>();
  /** wallet → its in-flight (then resolved) cursor-seed load. Awaited before any subscribe so the
   *  reconnect `fromSlot = min(lastSlot)` is computed from durable cursors, never a half-loaded cache. */
  private readonly seeded = new Map<string, Promise<void>>();
  /** In-memory mirror of each wallet's durable cursor (seeded from the store on first watch). */
  private readonly cursorCache = new Map<string, WalletStreamCursor>();
  /** Bounded, insertion-ordered set of recently-handled signatures (in-session dedup). */
  private readonly recentSigs = new Set<string>();
  /** wallet → the observed tip slot at which we last fired a gap-backfill (so we don't re-fire idly). */
  private readonly lastGapCheckedSlot = new Map<string, number>();

  private transport: WsTransport | null = null;
  private connected = false;
  private stopped = false;
  private backoffMs: number;
  private nextReqId = 1;
  private disconnectedAt = 0;
  /** Highest slot seen on the stream across ALL wallets — a free proxy for the chain tip. */
  private observedTipSlot = 0;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private gapTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Serializes async processing (cursor writes + handler) so tests can deterministically await it. */
  private chain: Promise<void> = Promise.resolve();

  private readonly reconnectCbs: Array<() => void> = [];
  private readonly connChangeCbs: Array<(connected: boolean) => void> = [];

  constructor(deps: TransactionStreamDeps) {
    this.transportFactory = deps.transportFactory;
    this.cursors = deps.cursors;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.cfg = { ...DEFAULT_STREAM_CONFIG, ...deps.config };
    this.backoffMs = this.cfg.backoffBaseMs;
  }

  // ── Lifecycle / engine wiring parity with the old RpcSubscriber port ──────────────────────────────

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
    this.clearTimers();
    this.transport?.close();
    this.transport = null;
    this.setConnected(false);
  }

  /** Watch a wallet (idempotent). Seeds its cursor from the durable store, then subscribes if live. */
  watch(wallet: string, onActivity: StreamActivityHandler): void {
    const isNew = !this.watched.has(wallet);
    this.watched.set(wallet, onActivity);
    if (isNew) this.seeded.set(wallet, this.seedCursor(wallet));
    // A new wallet changes the accountInclude set → resubscribe so the server streams it.
    if (this.connected) this.scheduleSubscribe();
  }

  unwatch(wallet: string): void {
    if (!this.watched.delete(wallet)) return;
    this.seeded.delete(wallet);
    this.cursorCache.delete(wallet);
    this.lastGapCheckedSlot.delete(wallet);
    if (this.connected) this.scheduleSubscribe();
  }

  /** Test/diagnostic seam: resolves once all in-flight notification processing has settled. */
  async idle(): Promise<void> {
    await this.chain;
  }

  private async seedCursor(wallet: string): Promise<void> {
    try {
      const c = await this.cursors.get(wallet);
      // Don't clobber a cursor a live notification already advanced while the load was in flight.
      if (c && !this.cursorCache.has(wallet)) this.cursorCache.set(wallet, c);
    } catch (err) {
      this.logger.warn({ err, wallet }, 'transaction-stream: cursor seed failed');
    }
  }

  // ── Connection ────────────────────────────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    const t = this.transportFactory();
    this.transport = t;
    t.onOpen(() => this.onOpen());
    t.onMessage((data) => this.onMessage(data));
    t.onClose(() => this.onClose());
    t.onError((err) =>
      this.logger.debug({ err }, 'transaction-stream: socket error (close drives reconnect)'),
    );
  }

  private onOpen(): void {
    this.setConnected(true);
    this.backoffMs = this.cfg.backoffBaseMs;
    const outageMs = this.disconnectedAt === 0 ? 0 : this.now() - this.disconnectedAt;
    this.startTimers();
    // Gate the (re)subscribe behind cursor seeding so `fromSlot` is computed from durable cursors, and
    // serialize it on the same chain as notification processing so `idle()` settles it deterministically.
    this.chain = this.chain
      .then(async () => {
        await this.awaitSeeds();
        this.subscribeAll();
        // Outage longer than the replay window: `fromSlot` can no longer cover it → fire a bounded RPC
        // backfill for every cursored wallet so a close that landed during the gap is still recovered.
        if (outageMs > this.cfg.replayWindowMs) {
          this.logger.warn(
            { outageMs },
            'transaction-stream: outage exceeded replay window — RPC backfill',
          );
          for (const wallet of this.watched.keys()) {
            if (this.cursorCache.has(wallet)) this.fireGapBackfill(wallet);
          }
        }
        // Let the engine run its own catch-up too (parity with the old subscriber's onReconnect hook).
        for (const cb of this.reconnectCbs) cb();
      })
      .catch((err) => this.logger.error({ err }, 'transaction-stream: open handling failed'));
  }

  /** Resubscribe (account-set change while live), seeding-gated + serialized on the processing chain. */
  private scheduleSubscribe(): void {
    this.chain = this.chain
      .then(async () => {
        await this.awaitSeeds();
        this.subscribeAll();
      })
      .catch((err) => this.logger.error({ err }, 'transaction-stream: resubscribe failed'));
  }

  private async awaitSeeds(): Promise<void> {
    await Promise.all([...this.seeded.values()]);
  }

  private onClose(): void {
    this.setConnected(false);
    this.disconnectedAt = this.now();
    this.clearTimers();
    if (this.stopped) return;
    const delay = Math.min(this.backoffMs, this.cfg.backoffMaxMs);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.backoffMs = Math.min(this.backoffMs * 2, this.cfg.backoffMaxMs);
  }

  private setConnected(c: boolean): void {
    if (this.connected === c) return;
    this.connected = c;
    for (const cb of this.connChangeCbs) cb(c);
  }

  /**
   * (Re)subscribe the FULL watched set, chunked at the per-filter cap. Routing is by the tx's account keys
   * (not by subscription id), so one `transactionSubscribe` per chunk is enough — a notification from any
   * chunk is matched back to the watched wallet(s) it touched. `fromSlot = min(lastSlot)` makes a reconnect
   * replay everything since the oldest processed slot; absent any cursor we omit it and rely on the seed.
   */
  private subscribeAll(): void {
    const t = this.transport;
    if (!t || !this.connected) return;
    const wallets = [...this.watched.keys()];
    const fromSlot = this.minCursorSlot();
    for (let i = 0; i < wallets.length; i += this.cfg.addressesPerFilter) {
      const chunk = wallets.slice(i, i + this.cfg.addressesPerFilter);
      t.send(this.subscribeMessage(chunk, fromSlot));
    }
  }

  private subscribeMessage(accountInclude: string[], fromSlot: number | null): string {
    const options: Record<string, unknown> = {
      commitment: this.cfg.commitment,
      encoding: this.cfg.encoding,
      transactionDetails: 'full',
      maxSupportedTransactionVersion: this.cfg.maxSupportedTransactionVersion,
    };
    if (fromSlot !== null) options.fromSlot = fromSlot;
    return JSON.stringify({
      jsonrpc: '2.0',
      id: this.nextReqId++,
      method: 'transactionSubscribe',
      params: [
        {
          // OR over the watched wallets, AND-required to touch the DLMM program — filters the stream to
          // DLMM activity server-side (the only thing we trigger on), cutting billable WS bytes.
          accountInclude,
          accountRequired: [DLMM_PROGRAM_ID],
          vote: false,
          failed: false,
        },
        options,
      ],
    });
  }

  /** The oldest durable slot across watched wallets — the reconnect replay floor. Null if none have one. */
  private minCursorSlot(): number | null {
    let min: number | null = null;
    for (const wallet of this.watched.keys()) {
      const slot = this.cursorCache.get(wallet)?.lastSlot;
      if (slot == null) continue;
      if (min === null || slot < min) min = slot;
    }
    return min;
  }

  // ── Message handling ────────────────────────────────────────────────────────────────────────────────

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Subscription confirmation `{ id, result: <subId> }` — nothing to route (we match by account keys).
    if (typeof msg.result === 'number' && typeof msg.id === 'number') return;
    if (msg.method !== 'transactionNotification') return;
    const parsed = parseTxNotification(msg);
    if (!parsed) return;
    // Serialize so each notification's durable cursor write + handler completes before the next — and so
    // tests can deterministically `await stream.idle()`.
    this.chain = this.chain
      .then(() => this.handleNotification(parsed))
      .catch((err) => {
        this.logger.error({ err }, 'transaction-stream: notification handling failed');
      });
  }

  private async handleNotification(n: ParsedTxNotification): Promise<void> {
    if (n.slot > this.observedTipSlot) this.observedTipSlot = n.slot;
    // Dedup (at-least-once delivery): a signature handled this session is never handled twice.
    if (this.recentSigs.has(n.signature)) return;
    const matched = n.accounts.filter((a) => this.watched.has(a));
    if (matched.length === 0) return;
    this.rememberSig(n.signature);
    for (const wallet of matched) {
      await this.advanceCursor(wallet, n.signature, n.slot);
      this.watched.get(wallet)?.(wallet, 'ws');
    }
  }

  /**
   * Advance a wallet's durable checkpoint MONOTONICALLY: a late/older signature (replay re-delivery, or
   * out-of-order arrival) never rewinds `lastSlot`. Persisted per signature so the cursor is crash-safe.
   */
  private async advanceCursor(wallet: string, signature: string, slot: number): Promise<void> {
    const prev = this.cursorCache.get(wallet);
    if (prev && prev.lastSlot != null && slot < prev.lastSlot) return; // older — keep the higher watermark
    const next: WalletStreamCursor = { lastSignature: signature, lastSlot: slot };
    this.cursorCache.set(wallet, next);
    try {
      await this.cursors.set(wallet, next);
    } catch (err) {
      this.logger.warn(
        { err, wallet },
        'transaction-stream: cursor persist failed (will retry next tx)',
      );
    }
  }

  private rememberSig(signature: string): void {
    this.recentSigs.add(signature);
    if (this.recentSigs.size > this.cfg.recentSigCapacity) {
      // Evict the oldest (Set preserves insertion order) to keep the dedup window bounded.
      const oldest = this.recentSigs.values().next().value;
      if (oldest !== undefined) this.recentSigs.delete(oldest);
    }
  }

  // ── Gap detector (replaces the unconditional fleet sweep) ────────────────────────────────────────────

  /**
   * Slot-watermark gap scan: a wallet whose cursor sits more than `gapSuspectSlots` behind the observed
   * stream tip, that we have NOT already recovered at (roughly) this tip, is a suspected silent drop →
   * one bounded backfill. `lastGapCheckedSlot` bounds re-fires to at most one per `gapSuspectSlots` of tip
   * advance per wallet, so an idle wallet costs ~0 RPC (vs the old every-5-min unconditional sweep).
   */
  checkGaps(): void {
    if (this.observedTipSlot === 0) return;
    for (const wallet of this.watched.keys()) {
      const cursor = this.cursorCache.get(wallet);
      if (!cursor || cursor.lastSlot == null) continue; // no checkpoint yet → the seed/backfill owns it
      if (this.observedTipSlot - cursor.lastSlot < this.cfg.gapSuspectSlots) continue; // keeping up
      const checkedAt = this.lastGapCheckedSlot.get(wallet) ?? Number.NEGATIVE_INFINITY;
      if (this.observedTipSlot - checkedAt < this.cfg.gapSuspectSlots) continue; // already recovered here
      this.lastGapCheckedSlot.set(wallet, this.observedTipSlot);
      this.fireGapBackfill(wallet);
    }
  }

  private fireGapBackfill(wallet: string): void {
    this.logger.warn(
      { wallet, tipSlot: this.observedTipSlot },
      'transaction-stream: suspected gap — backfill',
    );
    this.watched.get(wallet)?.(wallet, 'gap-backfill');
  }

  // ── Timers ────────────────────────────────────────────────────────────────────────────────────────

  private startTimers(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => this.transport?.ping(), this.cfg.pingIntervalMs);
    this.gapTimer = setInterval(() => this.checkGaps(), this.cfg.gapCheckIntervalMs);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.gapTimer) clearInterval(this.gapTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.gapTimer = this.reconnectTimer = null;
  }
}

/**
 * Pure parser for a Helius `transactionNotification` → its signature, slot, and the account keys the tx
 * touched (so the stream can route to the watched wallet[s] without a per-subscription map). Tolerates the
 * `jsonParsed` (accountKeys = `{ pubkey }[]`) and raw (accountKeys = `string[]`) shapes plus the loaded
 * address-table keys. Returns null when the message isn't a usable notification.
 */
export function parseTxNotification(msg: unknown): ParsedTxNotification | null {
  const params = (msg as { params?: unknown }).params as Record<string, unknown> | undefined;
  const result = params?.result as Record<string, unknown> | undefined;
  if (!result) return null;
  const signature = result.signature;
  const slot = result.slot;
  if (typeof signature !== 'string' || typeof slot !== 'number') return null;
  return { signature, slot, accounts: accountsOf(result) };
}

/** Collect every account key referenced by a notification's transaction (static + loaded), de-duplicated. */
function accountsOf(result: Record<string, unknown>): string[] {
  const tx = result.transaction as Record<string, unknown> | undefined;
  const inner = tx?.transaction as Record<string, unknown> | undefined;
  const message = inner?.message as Record<string, unknown> | undefined;
  const meta = tx?.meta as Record<string, unknown> | undefined;
  const out = new Set<string>();
  pushKeys(out, message?.accountKeys);
  // v0 transactions resolve extra writable/readonly accounts from address-lookup tables (in meta).
  const loaded = meta?.loadedAddresses as Record<string, unknown> | undefined;
  pushKeys(out, loaded?.writable);
  pushKeys(out, loaded?.readonly);
  return [...out];
}

function pushKeys(out: Set<string>, keys: unknown): void {
  if (!Array.isArray(keys)) return;
  for (const k of keys) {
    if (typeof k === 'string') out.add(k);
    else if (k && typeof k === 'object' && typeof (k as { pubkey?: unknown }).pubkey === 'string') {
      out.add((k as { pubkey: string }).pubkey);
    }
  }
}
