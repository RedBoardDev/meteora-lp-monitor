import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletStreamCursor } from '@/infrastructure/persistence/wallet-stream-cursor-repository';
import {
  MAX_ADDRESSES_PER_FILTER,
  parseTxNotification,
  type StreamActivityReason,
  TransactionStream,
  type TransactionStreamConfig,
  type WalletStreamCursorStore,
  type WsTransport,
} from './transaction-stream';

// ── Test doubles ──────────────────────────────────────────────────────────────────────────────────────
// These prove the no-miss guarantees with ZERO network: a mock WS transport, an in-memory cursor store
// (the durability boundary), and a spy activity handler. No real Helius connection is ever opened.

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

/** A controllable WS transport — the test drives open/message/close; the stream never touches a socket. */
class FakeWsTransport implements WsTransport {
  readonly sent: string[] = [];
  pings = 0;
  closed = false;
  private openCb?: () => void;
  private msgCb?: (data: string) => void;
  private closeCb?: () => void;
  private errCb?: (err: unknown) => void;

  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onError(cb: (err: unknown) => void): void {
    this.errCb = cb;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings++;
  }
  close(): void {
    this.closed = true;
    this.closeCb?.();
  }

  // ── test drivers ──
  open(): void {
    this.openCb?.();
  }
  emit(data: string): void {
    this.msgCb?.(data);
  }
  /** Simulate a server-side drop (the socket dies under us). */
  drop(): void {
    this.closeCb?.();
  }
  error(err: unknown): void {
    this.errCb?.(err);
  }
}

/** In-memory durable cursor store — survives a "restart" iff a new stream reuses the same instance. */
class FakeCursorStore implements WalletStreamCursorStore {
  readonly store = new Map<string, WalletStreamCursor>();
  readonly setCalls: Array<{ wallet: string; cursor: WalletStreamCursor }> = [];

  async get(wallet: string): Promise<WalletStreamCursor | null> {
    return this.store.get(wallet) ?? null;
  }
  async set(wallet: string, cursor: WalletStreamCursor): Promise<void> {
    this.store.set(wallet, { ...cursor });
    this.setCalls.push({ wallet, cursor: { ...cursor } });
  }
}

interface Handled {
  wallet: string;
  reason: StreamActivityReason;
}

function harness(config?: Partial<TransactionStreamConfig>, cursors = new FakeCursorStore()) {
  const transports: FakeWsTransport[] = [];
  const handled: Handled[] = [];
  const clock = { now: 0 };
  const stream = new TransactionStream({
    transportFactory: () => {
      const t = new FakeWsTransport();
      transports.push(t);
      return t;
    },
    cursors,
    logger,
    now: () => clock.now,
    // Tiny backoff so a fake-timer tick reconnects instantly; loose ping/gap so they never fire mid-test.
    config: {
      backoffBaseMs: 1,
      backoffMaxMs: 1,
      pingIntervalMs: 1e9,
      gapCheckIntervalMs: 1e9,
      ...config,
    },
  });
  const handler = (wallet: string, reason: StreamActivityReason) =>
    handled.push({ wallet, reason });
  const current = () => transports[transports.length - 1]!;
  return { stream, cursors, transports, handled, handler, clock, current };
}

/** Build a realistic Helius `transactionNotification` (jsonParsed accountKeys = `{ pubkey }[]`). */
function notification(sig: string, slot: number, accounts: string[]): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'transactionNotification',
    params: {
      subscription: 1,
      result: {
        signature: sig,
        slot,
        transaction: {
          transaction: {
            message: { accountKeys: [...accounts, DLMM_PROGRAM_ID].map((pubkey) => ({ pubkey })) },
          },
          meta: { err: null },
        },
        transactionIndex: 0,
      },
    },
  });
}

function parseSub(json: string): {
  method: string;
  filter: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  const m = JSON.parse(json);
  return { method: m.method, filter: m.params[0], options: m.params[1] };
}

const handledFor = (handled: Handled[], wallet: string, reason: StreamActivityReason) =>
  handled.filter((h) => h.wallet === wallet && h.reason === reason);

const WALLET = 'Leader1111111111111111111111111111111111111';
const PACER = 'Pacer22222222222222222222222222222222222222';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ── Subscribe shape + chunking ──────────────────────────────────────────────────────────────────────

describe('transactionSubscribe request shape', () => {
  it('subscribes the watched wallet with the DLMM-required, no-vote/no-failed filter + correct options', async () => {
    const { stream, transports, handler } = harness();
    stream.watch(WALLET, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    expect(transports[0]!.sent).toHaveLength(1);
    const { method, filter, options } = parseSub(transports[0]!.sent[0]!);
    expect(method).toBe('transactionSubscribe');
    expect(filter.accountInclude).toEqual([WALLET]);
    // accountRequired = AND: the tx must touch the DLMM program, filtering the stream to DLMM activity
    // server-side (the only thing we trigger on) so we don't bill WS bytes for unrelated transfers.
    expect(filter.accountRequired).toEqual([DLMM_PROGRAM_ID]);
    expect(filter.vote).toBe(false);
    expect(filter.failed).toBe(false);
    expect(options.commitment).toBe('confirmed');
    expect(options.encoding).toBe('jsonParsed');
    expect(options.transactionDetails).toBe('full');
    expect(options.maxSupportedTransactionVersion).toBe(0);
    // No cursor yet ⇒ no replay floor; the initial seed owns completeness.
    expect(options.fromSlot).toBeUndefined();
    stream.stop();
  });

  it('chunks the watched set into multiple filters at the 50,000-address cap', async () => {
    expect(MAX_ADDRESSES_PER_FILTER).toBe(50_000);
    const { stream, transports, handler } = harness();
    const wallets = Array.from({ length: MAX_ADDRESSES_PER_FILTER + 1 }, (_, i) => `w${i}`);
    for (const w of wallets) stream.watch(w, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    // 50_001 addresses must split into two transactionSubscribe filters: 50_000 + 1 (never one >cap filter).
    const subs = transports[0]!.sent.map(parseSub);
    expect(subs).toHaveLength(2);
    expect((subs[0]!.filter.accountInclude as string[]).length).toBe(MAX_ADDRESSES_PER_FILTER);
    expect((subs[1]!.filter.accountInclude as string[]).length).toBe(1);
    stream.stop();
  });

  it('respects a smaller configured per-filter cap (exact chunk arithmetic)', async () => {
    const { stream, transports, handler } = harness({ addressesPerFilter: 2 });
    for (const w of ['a', 'b', 'c', 'd', 'e']) stream.watch(w, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    const sizes = transports[0]!.sent.map(
      (s) => (parseSub(s).filter.accountInclude as string[]).length,
    );
    expect(sizes).toEqual([2, 2, 1]);
    stream.stop();
  });
});

// ── NO-MISS suite (t1–t5) ───────────────────────────────────────────────────────────────────────────

describe('no-miss: t1 WS drop mid-stream → reconnect → fromSlot replay (close lands EXACTLY once)', () => {
  it('re-delivers the gap close once and dedups the replayed pre-drop tx', async () => {
    // WHY: a dropped socket must never lose a close. On reconnect the stream replays from the last
    // processed slot; the close that happened DURING the gap must reach the handler exactly once, while
    // pre-drop txs the replay re-delivers must be deduped (no double-count). A handler count other than
    // the expected value means either a miss or a double-fire — both forbidden.
    const { stream, cursors, transports, handled, handler, clock } = harness({
      replayWindowMs: 60_000,
    });
    stream.watch(WALLET, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    // A normal pre-drop tx is processed and durably checkpointed.
    transports[0]!.emit(notification('sigPre', 100, [WALLET]));
    await stream.idle();
    expect(handledFor(handled, WALLET, 'ws')).toHaveLength(1);
    expect(cursors.store.get(WALLET)).toEqual({ lastSignature: 'sigPre', lastSlot: 100 });

    // Socket drops; reconnect fires via backoff (fake timer). Outage stays within the replay window.
    clock.now = 1_000;
    transports[0]!.drop();
    await vi.advanceTimersByTimeAsync(1);
    clock.now = 1_500;
    transports[1]!.open();
    await stream.idle();

    // Reconnect must request fromSlot = min(lastSlot) so everything since the last processed slot replays.
    expect(transports[1]!.sent).toHaveLength(1);
    expect(parseSub(transports[1]!.sent[0]!).options.fromSlot).toBe(100);

    // Replay re-delivers the pre-drop tx (dup) AND the gap close — the close arrives twice (at-least-once).
    transports[1]!.emit(notification('sigPre', 100, [WALLET])); // replayed dup → must be deduped
    transports[1]!.emit(notification('sigClose', 101, [WALLET])); // the missed close
    transports[1]!.emit(notification('sigClose', 101, [WALLET])); // duplicate delivery of the close
    await stream.idle();

    // Exactly two real handler fires: sigPre (once) + sigClose (once). Not 1 (missed close), not 3+ (dup).
    expect(handledFor(handled, WALLET, 'ws')).toHaveLength(2);
    // The close is durably checkpointed; the cursor advanced monotonically to it.
    expect(cursors.store.get(WALLET)).toEqual({ lastSignature: 'sigClose', lastSlot: 101 });
    stream.stop();
  });
});

describe('no-miss: t2 slot gap with the socket UP → watermark gap detector → bounded backfill', () => {
  it('fires a bounded recovery for the lagging wallet once, never for a wallet keeping up', async () => {
    // WHY: transactionSubscribe can silently drop a notification under back-pressure while the socket
    // stays open. A wallet whose cursor falls far behind the live stream tip (advanced by other wallets'
    // activity) with no events is a suspected drop; the detector must trigger a bounded until-cursor
    // ingest for THAT wallet to recover the missed open/close — and must NOT sweep wallets that keep up.
    const { stream, transports, handled, handler } = harness({ gapSuspectSlots: 1_000 });
    stream.watch(WALLET, handler);
    stream.watch(PACER, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    transports[0]!.emit(notification('x1', 100, [WALLET])); // WALLET last seen at slot 100
    await stream.idle();
    transports[0]!.emit(notification('p1', 5_000, [PACER])); // other wallets push the observed tip to 5_000
    await stream.idle();

    // WALLET is 4_900 slots behind the tip with no events in between → suspected silent drop.
    stream.checkGaps();
    expect(handledFor(handled, WALLET, 'gap-backfill')).toHaveLength(1);
    // PACER is at the tip → no wasteful backfill.
    expect(handledFor(handled, PACER, 'gap-backfill')).toHaveLength(0);

    // Re-checking without the tip advancing must NOT re-fire — the detector is self-limiting (not a poll).
    stream.checkGaps();
    expect(handledFor(handled, WALLET, 'gap-backfill')).toHaveLength(1);
    stream.stop();
  });

  it('does not gap-sweep a merely-idle wallet whose cursor is within the suspect window', async () => {
    const { stream, transports, handled, handler } = harness({ gapSuspectSlots: 1_000 });
    stream.watch(WALLET, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    transports[0]!.emit(notification('x1', 4_500, [WALLET]));
    await stream.idle();
    transports[0]!.emit(notification('x2', 5_000, [WALLET])); // tip 5_000, cursor 5_000 → diff 0
    await stream.idle();

    stream.checkGaps();
    expect(handledFor(handled, WALLET, 'gap-backfill')).toHaveLength(0);
    stream.stop();
  });
});

describe('no-miss: t3 crash/restart → durable cursor resumes (no miss, no full re-seed)', () => {
  it('a fresh stream reusing the persisted cursor resumes from its slot and replays the downtime close', async () => {
    // WHY: a crash wipes in-memory state (the dedup set, cursor cache) but NOT the persisted cursor. On
    // restart the stream must resume fromSlot = persisted slot (a full re-seed would mean fromSlot
    // undefined and a costly re-page), and the close that landed while the process was down must replay.
    const cursors = new FakeCursorStore();

    // ── session 1: process a tx, then "crash" (no graceful flush — the cursor is already persisted) ──
    {
      const h1 = harness({}, cursors);
      h1.stream.watch(WALLET, h1.handler);
      h1.stream.start();
      h1.transports[0]!.open();
      await h1.stream.idle();
      h1.transports[0]!.emit(notification('sigBefore', 200, [WALLET]));
      await h1.stream.idle();
      expect(cursors.store.get(WALLET)).toEqual({ lastSignature: 'sigBefore', lastSlot: 200 });
      h1.stream.stop(); // clears fake timers; the durable cursor remains in `cursors`
    }

    // ── session 2: a brand-new stream (fresh dedup set) sharing only the durable cursor store ──
    const h2 = harness({}, cursors);
    h2.stream.watch(WALLET, h2.handler);
    h2.stream.start();
    h2.transports[0]!.open();
    await h2.stream.idle();

    // Resumed from the persisted slot — NOT a full re-seed (which would send no fromSlot).
    expect(parseSub(h2.transports[0]!.sent[0]!).options.fromSlot).toBe(200);

    // The close that occurred during downtime replays and is captured exactly once.
    h2.transports[0]!.emit(notification('sigAfterCrash', 201, [WALLET]));
    await h2.stream.idle();
    expect(handledFor(h2.handled, WALLET, 'ws')).toHaveLength(1);
    expect(cursors.store.get(WALLET)).toEqual({ lastSignature: 'sigAfterCrash', lastSlot: 201 });
    h2.stream.stop();
  });
});

describe('no-miss: t4 duplicate signatures (at-least-once) → dedup → handler once', () => {
  it('handles a signature delivered three times exactly once', async () => {
    // WHY: at-least-once delivery means the same close can arrive multiple times; the downstream copy/
    // ingest must fire once or it double-counts. Dedup by signature is the guard.
    const { stream, cursors, transports, handled, handler } = harness();
    stream.watch(WALLET, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    transports[0]!.emit(notification('dupSig', 300, [WALLET]));
    transports[0]!.emit(notification('dupSig', 300, [WALLET]));
    transports[0]!.emit(notification('dupSig', 300, [WALLET]));
    await stream.idle();

    expect(handledFor(handled, WALLET, 'ws')).toHaveLength(1);
    // The cursor was written for the one accepted delivery only (no redundant writes from the dups).
    expect(cursors.setCalls.filter((c) => c.wallet === WALLET)).toHaveLength(1);
    stream.stop();
  });
});

describe('no-miss: t5 outage longer than the replay window → RPC backfill fallback', () => {
  it('falls back to a bounded backfill for cursored wallets when fromSlot can no longer cover the gap', async () => {
    // WHY: the replay buffer is bounded. An outage longer than the window can't be recovered by fromSlot
    // replay, so relying on it would miss a close. The stream must detect the over-window outage and fall
    // back to the bounded getSignaturesForAddress(until=lastSig) backfill for every cursored wallet.
    const { stream, cursors, transports, handled, handler, clock } = harness({
      replayWindowMs: 1_000,
    });
    stream.watch(WALLET, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    transports[0]!.emit(notification('sigSeed', 400, [WALLET]));
    await stream.idle();
    expect(cursors.store.get(WALLET)?.lastSlot).toBe(400);

    // Drop, then reconnect AFTER more than the replay window has elapsed.
    clock.now = 10_000;
    transports[0]!.drop();
    await vi.advanceTimersByTimeAsync(1);
    clock.now = 10_000 + 1_001; // outage 1_001ms > replayWindowMs (1_000)
    transports[1]!.open();
    await stream.idle();

    // The over-window outage triggers the bounded RPC backfill (the recovery the downstream ingest runs).
    expect(handledFor(handled, WALLET, 'gap-backfill')).toHaveLength(1);
    stream.stop();
  });

  it('a short outage within the window relies on free fromSlot replay, NOT an RPC backfill', async () => {
    const { stream, transports, handled, handler, clock } = harness({ replayWindowMs: 5_000 });
    stream.watch(WALLET, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();
    transports[0]!.emit(notification('sigSeed', 400, [WALLET]));
    await stream.idle();

    clock.now = 10_000;
    transports[0]!.drop();
    await vi.advanceTimersByTimeAsync(1);
    clock.now = 10_000 + 2_000; // 2s outage < 5s window
    transports[1]!.open();
    await stream.idle();

    expect(handledFor(handled, WALLET, 'gap-backfill')).toHaveLength(0); // free replay, no RPC spend
    expect(parseSub(transports[1]!.sent[0]!).options.fromSlot).toBe(400);
    stream.stop();
  });
});

// ── Cursor monotonicity (a late/older sig never rewinds the replay floor) ────────────────────────────

describe('cursor advances monotonically', () => {
  it('a later (older-slot) signature never rewinds lastSlot/lastSignature', async () => {
    // WHY: replay + at-least-once can re-deliver an older tx after a newer one. If that rewound the
    // cursor, the next reconnect's fromSlot would drop back and re-replay (or, worse, a future advance
    // could skip ahead of an un-acked slot). The replay floor must only ever move forward.
    const { stream, cursors, transports, handler } = harness();
    stream.watch(WALLET, handler);
    stream.start();
    transports[0]!.open();
    await stream.idle();

    transports[0]!.emit(notification('sigHigh', 500, [WALLET]));
    await stream.idle();
    transports[0]!.emit(notification('sigOld', 490, [WALLET])); // older slot arrives afterwards
    await stream.idle();

    expect(cursors.store.get(WALLET)).toEqual({ lastSignature: 'sigHigh', lastSlot: 500 });
    stream.stop();
  });
});

// ── Pure notification parser ─────────────────────────────────────────────────────────────────────────

describe('parseTxNotification', () => {
  it('extracts signature, slot and jsonParsed account keys ({ pubkey })', () => {
    const parsed = parseTxNotification(JSON.parse(notification('s', 7, ['AcctA', 'AcctB'])));
    expect(parsed).not.toBeNull();
    expect(parsed!.signature).toBe('s');
    expect(parsed!.slot).toBe(7);
    expect(parsed!.accounts).toContain('AcctA');
    expect(parsed!.accounts).toContain('AcctB');
    expect(parsed!.accounts).toContain(DLMM_PROGRAM_ID);
  });

  it('handles raw string accountKeys and v0 loaded address-table keys', () => {
    const msg = {
      method: 'transactionNotification',
      params: {
        result: {
          signature: 's2',
          slot: 9,
          transaction: {
            transaction: { message: { accountKeys: ['Static1'] } },
            meta: { loadedAddresses: { writable: ['LutWrite'], readonly: ['LutRead'] } },
          },
        },
      },
    };
    const parsed = parseTxNotification(msg);
    expect(parsed!.accounts.sort()).toEqual(['LutRead', 'LutWrite', 'Static1']);
  });

  it('returns null for a malformed/non-notification message', () => {
    expect(parseTxNotification({ params: { result: { slot: 1 } } })).toBeNull(); // no signature
    expect(parseTxNotification({ params: { result: { signature: 's' } } })).toBeNull(); // no slot
    expect(parseTxNotification({ foo: 'bar' })).toBeNull();
  });
});
