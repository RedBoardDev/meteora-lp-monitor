import type {
  ClosedPosition,
  LiveEvent,
  NotifRule,
  OpenPosition,
  WalletState,
} from '@binsight/shared';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigRepository, NotificationChannel, PresenceReader } from '@/domain/ports';
import { EventBus } from '../event-bus';
import { NotificationManager } from './manager';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

// STARTUP_GRACE_MS in the manager is 10s; pick boot + a clearly-past-grace instant.
const BOOT = new Date('2026-01-01T00:00:00Z');
const PAST_GRACE = new Date('2026-01-01T00:00:11Z');

/** Build a NotifRule with sane defaults; only the discriminating fields need to be passed. */
function makeRule(over: Partial<NotifRule> & Pick<NotifRule, 'eventKind'>): NotifRule {
  return {
    wallet: null, // global default
    enabled: true,
    mode: 'single',
    threshold: null,
    oorMinutes: null,
    ...over,
  };
}

const pnlRule: NotifRule = makeRule({ eventKind: 'pnl_threshold', threshold: 1 });

/** A minimal open position; only the fields the manager's gating logic reads are meaningful. */
function openPos(over: Partial<OpenPosition> & { positionAddress: string }): OpenPosition {
  return {
    wallet: 'W',
    tokenX: 'AAA',
    tokenY: 'SOL',
    pnlSol: 0,
    unclaimedFeesSol: 0,
    outOfRangeSince: null,
    ...over,
  } as unknown as OpenPosition;
}

function stateOf(positions: OpenPosition[], scope = 'W'): WalletState {
  return { scope, openPositions: positions } as unknown as WalletState;
}

/** A focused-scope (not 'all') state with one open position breaching the pnl threshold. */
function breachState(positionAddress: string, pnlSol: number): WalletState {
  return stateOf([openPos({ positionAddress, pnlSol })]);
}

/** A fully-formed raw LiveEvent (the kind that flows through `handle`). */
function rawEvent(over: Partial<LiveEvent> & Pick<LiveEvent, 'kind'>): LiveEvent {
  return {
    id: 'e1',
    wallet: 'W',
    positionAddress: 'P',
    pair: 'AAA/SOL',
    title: 'title',
    body: 'body',
    data: {},
    createdAt: 0,
    ...over,
  };
}

// `deliver` awaits pushChannel before consulting presence → flush microtasks to observe notify/bark.
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function makeManager(rules: NotifRule[], opts: { active?: boolean } = {}) {
  const bus = new EventBus();
  const config = { listNotifRules: () => rules } as unknown as ConfigRepository;
  const presence: PresenceReader = { isAnyClientActive: () => opts.active ?? false };
  const push = { name: 'push', deliver: vi.fn(async (_e: LiveEvent) => {}) };
  const bark = { name: 'bark', deliver: vi.fn(async (_e: LiveEvent) => {}) };
  const notify = vi.fn();
  bus.on('notify', notify);
  const mgr = new NotificationManager(
    bus,
    config,
    presence,
    bark as unknown as NotificationChannel,
    push as unknown as NotificationChannel,
    noopLogger,
  );
  return { bus, mgr, push, bark, notify };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NotificationManager — startup grace (R02)', () => {
  it('fires a breach that existed at boot once grace passes (not suppressed forever)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const { bus, mgr, push } = makeManager([pnlRule]);
    mgr.start(); // startAt = now → in grace

    // In grace: held AND not marked (the bug marked it here, suppressing it forever).
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).not.toHaveBeenCalled();

    // Past grace (> 10s): the still-breached state must now alert exactly once.
    vi.setSystemTime(PAST_GRACE);
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).toHaveBeenCalledTimes(1);

    // The once-guard holds on subsequent identical ticks.
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationManager — threshold key reclamation (R07)', () => {
  it('forgets a position threshold key on close so the Set does not leak', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const { bus, mgr, push } = makeManager([pnlRule]);
    mgr.start();
    vi.setSystemTime(PAST_GRACE); // past grace

    bus.emit('state', breachState('P', 2));
    bus.emit('state', breachState('P', 2)); // once-guarded → still a single alert
    expect(push.deliver).toHaveBeenCalledTimes(1);

    // Closing the position must reclaim its 'pnl:P' key (no leak). The close event itself has no rule.
    bus.emit('closed', {
      wallet: 'W',
      positionAddress: 'P',
      tokenX: 'AAA',
      tokenY: 'SOL',
      pnlSol: 0,
      feesSol: 0,
    } as unknown as ClosedPosition);
    expect(push.deliver).toHaveBeenCalledTimes(1);

    // Proof the key was forgotten: an identical breach can fire again (the stale key no longer suppresses).
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationManager — rule gating (ruleFor)', () => {
  it('a per-wallet rule overrides the global default (disabled wallet rule suppresses an enabled global)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const globalOn = makeRule({ eventKind: 'position_open', wallet: null, enabled: true });
    const walletOff = makeRule({ eventKind: 'position_open', wallet: 'W', enabled: false });
    const { bus, mgr, push } = makeManager([globalOn, walletOff]);
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    // ruleFor must pick the more-specific wallet rule (disabled) over the enabled global → no delivery.
    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled();
  });

  it('no matching rule → no delivery (events for unconfigured kinds are dropped)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    // Only a pnl rule configured; a position_open event has no rule.
    const { bus, mgr, push } = makeManager([pnlRule]);
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled();
  });

  it('a disabled rule → no delivery even when the kind matches', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const disabled = makeRule({ eventKind: 'position_open', enabled: false });
    const { bus, mgr, push } = makeManager([disabled]);
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled();
  });
});

describe('NotificationManager — bulk vs single routing (handle)', () => {
  it('a bulk-mode event is coalesced (not delivered immediately) and flushed once after the window', () => {
    vi.useFakeTimers(); // fake Date + timers (BulkBuffer uses setTimeout)
    vi.setSystemTime(BOOT);
    const bulkOpen = makeRule({ eventKind: 'position_open', mode: 'bulk' });
    const { bus, mgr, push } = makeManager([bulkOpen]);
    mgr.start();
    vi.advanceTimersByTime(11_000); // clear startup grace without firing anything

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled(); // held in the bulk buffer, not delivered inline

    vi.advanceTimersByTime(8_000); // BulkBuffer window elapses → flush
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationManager — deriveFromState gating', () => {
  it("the aggregated 'all' scope never derives notifications (avoids per-wallet double counting)", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const { bus, mgr, push } = makeManager([pnlRule]);
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    // Same breaching position, but under the aggregated 'all' scope → must short-circuit.
    bus.emit('state', stateOf([openPos({ positionAddress: 'P', pnlSol: 5 })], 'all'));
    expect(push.deliver).not.toHaveBeenCalled();
  });

  it('a fees_threshold breach fires once and stays deduped on repeat ticks', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const feeRule = makeRule({ eventKind: 'fees_threshold', threshold: 0.5 });
    const { bus, mgr, push } = makeManager([feeRule]);
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    const tick = () =>
      bus.emit('state', stateOf([openPos({ positionAddress: 'P', unclaimedFeesSol: 0.9 })]));
    tick();
    tick();
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });

  it('dropping back below the threshold re-arms the alert (a later re-breach fires again)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const { bus, mgr, push } = makeManager([pnlRule]); // threshold 1
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    bus.emit('state', breachState('P', 2)); // breach → fire
    expect(push.deliver).toHaveBeenCalledTimes(1);

    bus.emit('state', breachState('P', 0)); // below threshold → key cleared (re-armed), no fire
    expect(push.deliver).toHaveBeenCalledTimes(1);

    bus.emit('state', breachState('P', 2)); // breach again → fires a second time
    expect(push.deliver).toHaveBeenCalledTimes(2);
  });

  it('oor_duration fires only once the position has been out of range long enough', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const oorRule = makeRule({ eventKind: 'oor_duration', oorMinutes: 30 });
    const { bus, mgr, push } = makeManager([oorRule]);
    mgr.start();
    vi.setSystemTime(PAST_GRACE);
    const now = PAST_GRACE.getTime();

    // Out of range for only 10 min < 30 → no alert.
    bus.emit('state', stateOf([openPos({ positionAddress: 'P', outOfRangeSince: now - 10 * 60_000 })]));
    expect(push.deliver).not.toHaveBeenCalled();

    // A different position out of range for 31 min ≥ 30 → fires once; repeat tick stays deduped.
    const longState = stateOf([
      openPos({ positionAddress: 'Q', outOfRangeSince: now - 31 * 60_000 }),
    ]);
    bus.emit('state', longState);
    bus.emit('state', longState);
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationManager — delivery routing (deliver)', () => {
  it('raw events inside the startup grace are held (no boot alert storm)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const openRule = makeRule({ eventKind: 'position_open' });
    const { bus, mgr, push } = makeManager([openRule]);
    mgr.start(); // in grace

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).not.toHaveBeenCalled(); // held by deliver's grace gate

    // Past grace the very same event delivers → proves it was the grace gate, not gating/dedup.
    vi.setSystemTime(PAST_GRACE);
    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });

  it('with a client actively viewing: web-push + in-app notify, NO Bark fallback', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const openRule = makeRule({ eventKind: 'position_open' });
    const { bus, mgr, push, bark, notify } = makeManager([openRule], { active: true });
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    await flush();

    expect(push.deliver).toHaveBeenCalledTimes(1); // universal channel always fires
    expect(notify).toHaveBeenCalledTimes(1); // active client → in-app banner
    expect(bark.deliver).not.toHaveBeenCalled(); // external fallback suppressed
  });

  it('with no client active: web-push + Bark fallback, NO in-app notify', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const openRule = makeRule({ eventKind: 'position_open' });
    const { bus, mgr, push, bark, notify } = makeManager([openRule], { active: false });
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    bus.emit('event', rawEvent({ kind: 'position_open', wallet: 'W' }));
    await flush();

    expect(push.deliver).toHaveBeenCalledTimes(1); // universal channel always fires
    expect(bark.deliver).toHaveBeenCalledTimes(1); // no viewer → external fallback
    expect(notify).not.toHaveBeenCalled(); // no in-app banner without a viewer
  });
});

describe('NotificationManager — close fan-out (handleClosed)', () => {
  it('emits a position_close event with the settled PnL/fees body and routes it via the close rule', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BOOT);
    const closeRule = makeRule({ eventKind: 'position_close' });
    const { bus, mgr, push } = makeManager([closeRule]);
    mgr.start();
    vi.setSystemTime(PAST_GRACE);

    bus.emit('closed', {
      wallet: 'W',
      positionAddress: 'P',
      tokenX: 'AAA',
      tokenY: 'SOL',
      pnlSol: 1,
      feesSol: 0.5,
    } as unknown as ClosedPosition);
    await flush();

    expect(push.deliver).toHaveBeenCalledTimes(1);
    const delivered = push.deliver.mock.calls[0]![0] as LiveEvent;
    expect(delivered.kind).toBe('position_close');
    expect(delivered.title).toBe('AAA/SOL closed');
    expect(delivered.body).toContain('PnL +1.0000 SOL');
    expect(delivered.body).toContain('fees +0.5000 SOL');
  });
});
