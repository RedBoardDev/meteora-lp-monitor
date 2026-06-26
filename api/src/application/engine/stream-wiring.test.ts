import { DLMM_PROGRAM_ID, type RuntimeSettings } from '@binsight/shared';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/application/event-bus';
import { HealthMonitor } from '@/application/health-monitor';
import type { AppConfig } from '@/config/env';
import {
  TransactionStream,
  type WalletStreamCursorStore,
  type WsTransport,
} from '@/infrastructure/solana/transaction-stream';
import type { WalletStreamCursor } from '@/infrastructure/persistence/wallet-stream-cursor-repository';
import { Engine, type EngineDeps } from './index';

// Step 5b INTEGRATION test — proves the WIRING (engine ⇄ TransactionStream) with ZERO network: a real
// TransactionStream driven by a mock WS transport + an in-memory cursor store, plugged into a real Engine
// whose `dlmmIngest.ingest` is the spy. NO real Helius socket is ever opened (the real ws-transport adapter
// is never imported here). Two guarantees are locked:
//   1. a transactionSubscribe notification for a wallet funnels into the engine's triggerOnchainSync
//      (= the SAME cursor-based delta ingest the deleted BACKSTOP sweep used to drive), and registration
//      routes to the STREAM (not the legacy logsSubscribe subscriber);
//   2. the BACKSTOP_INGEST_MS fleet timer is GONE — idle time alone never triggers a periodic delta ingest.

const WALLET = 'Leader1111111111111111111111111111111111111';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
} as unknown as Logger;

/** A controllable WS transport — the test drives open/message; the stream never touches a socket. */
class FakeWsTransport implements WsTransport {
  readonly sent: string[] = [];
  private openCb?: () => void;
  private msgCb?: (data: string) => void;
  private closeCb?: () => void;

  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onError(): void {}
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {}
  close(): void {
    this.closeCb?.();
  }

  // ── test drivers ──
  open(): void {
    this.openCb?.();
  }
  emit(data: string): void {
    this.msgCb?.(data);
  }
}

/** In-memory durable cursor store (the WalletStreamCursorRepository's role) — no DB needed for the wiring. */
class FakeCursorStore implements WalletStreamCursorStore {
  private readonly store = new Map<string, WalletStreamCursor>();
  async get(wallet: string): Promise<WalletStreamCursor | null> {
    return this.store.get(wallet) ?? null;
  }
  async set(wallet: string, cursor: WalletStreamCursor): Promise<void> {
    this.store.set(wallet, { ...cursor });
  }
}

const settings: RuntimeSettings = {
  meteoraTargetRps: 15,
  pollMinMs: 1_000,
  pollMaxMs: 30_000,
  pollIdleMs: 300_000,
  barkKey: '',
  presenceTimeoutSeconds: 30,
};

/** A do-nothing async fn (resolved) — used for every dep method the onchain wiring path doesn't exercise. */
const noopAsync = () => Promise.resolve(undefined as never);

function makeEngine() {
  const transports: FakeWsTransport[] = [];
  const stream = new TransactionStream({
    transportFactory: () => {
      const t = new FakeWsTransport();
      transports.push(t);
      return t;
    },
    cursors: new FakeCursorStore(),
    logger,
    // Push ping/gap timers far out so they never fire mid-test (the gap detector is proven in Step 5a;
    // here we assert the engine wiring, not re-test the detector).
    config: { pingIntervalMs: 1e9, gapCheckIntervalMs: 1e9 },
  });

  // The single assertion target: triggerOnchainSync delta-ingests via dlmmIngest.ingest(wallet).
  const dlmmIngest = { ingest: vi.fn(async () => ({ legs: 0, txs: 0, complete: true })) };
  // Legacy logsSubscribe backbone — its watch MUST stay untouched in onchain mode (we assert this).
  const subscriberWatch = vi.fn();

  const appConfig = {
    POSITIONS_SOURCE: 'onchain',
    BACKFILL_CONCURRENCY: 3,
    REALIZED_PNL_ENABLED: false,
    historyDays: 365,
  } as unknown as AppConfig;

  const deps: EngineDeps = {
    gateway: {
      listOpenPools: vi.fn(),
      listClosedPools: vi.fn(),
      fetchOpenPositions: vi.fn(),
      fetchClosedPositions: vi.fn(),
    } as unknown as EngineDeps['gateway'],
    prices: {
      getPricesSol: vi.fn(async () => new Map()),
      getSolUsd: vi.fn(async () => null),
    } as unknown as EngineDeps['prices'],
    subscriber: {
      watch: subscriberWatch,
      unwatch: vi.fn(),
      isConnected: () => false,
      onReconnect: vi.fn(),
      onConnectionChange: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as EngineDeps['subscriber'],
    stream,
    onchain: {
      // Throws so doSnapshot takes its caught failure branch — we only need the ingest spy, not a valuation.
      snapshotWallet: vi.fn(async () => {
        throw new Error('no snapshot in wiring test');
      }),
      positionBins: vi.fn(),
      positionHistory: vi.fn(),
      decimalsOf: vi.fn(),
    } as unknown as EngineDeps['onchain'],
    health: new HealthMonitor(),
    strategy: { init: noopAsync, backfill: noopAsync } as unknown as EngineDeps['strategy'],
    repo: { getOpen: vi.fn(async () => []) } as unknown as EngineDeps['repo'],
    config: {
      getSettings: () => settings,
      listNotifRules: () => [],
      init: noopAsync,
    } as unknown as EngineDeps['config'],
    accounts: {
      monitoredWallets: vi.fn(async () => [WALLET]),
    } as unknown as EngineDeps['accounts'],
    bus: new EventBus(),
    logger,
    appConfig,
    dlmmIngest: dlmmIngest as unknown as EngineDeps['dlmmIngest'],
    positionSync: { sync: vi.fn(), refreshOpen: vi.fn() } as unknown as EngineDeps['positionSync'],
    walletFlowIngest: { ingest: noopAsync } as unknown as EngineDeps['walletFlowIngest'],
    swapFlowIngest: { ingest: noopAsync } as unknown as EngineDeps['swapFlowIngest'],
    realizedPnl: { computeForWallet: vi.fn() } as unknown as EngineDeps['realizedPnl'],
  };

  const engine = new Engine(deps);
  return { engine, stream, dlmmIngest, subscriberWatch, transport: () => transports.at(-1)! };
}

/** Build a transactionNotification (jsonParsed accountKeys = `{ pubkey }[]`) touching `wallet` + DLMM. */
function notification(sig: string, slot: number, wallet: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'transactionNotification',
    params: {
      subscription: 1,
      result: {
        signature: sig,
        slot,
        transaction: {
          transaction: { message: { accountKeys: [wallet, DLMM_PROGRAM_ID].map((pubkey) => ({ pubkey })) } },
          meta: { err: null },
        },
      },
    },
  });
}

/**
 * Start the engine, connect the stream, and settle the connect-time work (the historical backfill + the
 * onReconnect fleet resync both delta-ingest once on boot). Returns with `dlmmIngest.ingest` CLEARED, so any
 * subsequent call is unambiguously attributable to the action under test.
 */
async function startSettled(h: ReturnType<typeof makeEngine>) {
  await h.engine.start();
  h.transport().open();
  await h.stream.idle();
  await vi.advanceTimersByTimeAsync(2_000); // drain backfill + the on-connect resync + one engine tick
  h.dlmmIngest.ingest.mockClear();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Step 5b: TransactionStream is wired as the on-chain trigger', () => {
  it('a stream notification for a wallet funnels into triggerOnchainSync (delta ingest), via the STREAM not the legacy subscriber', async () => {
    // WHY: the no-miss design swapped the TRIGGER (was an unconditional fleet timer) for live WS activity.
    // The contract that must hold: a transactionSubscribe notification → the SAME cursor-based delta ingest
    // (triggerOnchainSync → dlmmIngest.ingest(wallet)). If this regresses, a leader open/close detected on
    // the socket would never reach ingestion — a forbidden miss.
    const h = makeEngine();
    await startSettled(h);

    // Registration went to the transactionSubscribe stream (the wallet is in a real subscribe frame), and
    // NOT to the legacy logsSubscribe subscriber.
    expect(h.transport().sent.some((s) => s.includes(WALLET))).toBe(true);
    expect(h.subscriberWatch).not.toHaveBeenCalled();

    // Drive a DLMM notification for the wallet → handler → onStreamActivity → triggerOnchainSync (after the
    // short settle lag the engine applies so the just-confirmed tx is visible to getSignaturesForAddress).
    h.transport().emit(notification('sigOpen', 1_000, WALLET));
    await h.stream.idle();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(h.dlmmIngest.ingest).toHaveBeenCalledTimes(1);
    expect(h.dlmmIngest.ingest).toHaveBeenCalledWith(WALLET);

    h.engine.stop();
  });

  it('the BACKSTOP_INGEST_MS fleet timer is GONE — idle time alone never triggers a periodic delta ingest', async () => {
    // WHY: the deleted backstop swept every wallet with a delta ingest every 5 min regardless of activity —
    // the cost that motivated this refactor. Removing it is only safe because live WS activity + the gap
    // detector cover no-miss. This test would FAIL (catch a re-introduced unconditional timer) if any
    // periodic ingest fired with no stream activity at all.
    const h = makeEngine();
    await startSettled(h);

    // Advance well past the old 300_000ms backstop interval with ZERO stream notifications.
    await vi.advanceTimersByTimeAsync(301_000);

    expect(h.dlmmIngest.ingest).not.toHaveBeenCalled();

    h.engine.stop();
  });
});
