import type { ClosedPosition, NotifRule, WalletState } from '@binsight/shared';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigRepository, NotificationChannel, PresenceReader } from '@/domain/ports';
import { EventBus } from '../event-bus';
import { NotificationManager } from './manager';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const pnlRule: NotifRule = {
  wallet: null, // global default
  eventKind: 'pnl_threshold',
  enabled: true,
  mode: 'single',
  threshold: 1,
  oorMinutes: null,
};

/** A focused-scope (not 'all') state with one open position breaching the pnl threshold. */
function breachState(positionAddress: string, pnlSol: number): WalletState {
  return {
    scope: 'W',
    openPositions: [
      {
        wallet: 'W',
        positionAddress,
        tokenX: 'AAA',
        tokenY: 'SOL',
        pnlSol,
        unclaimedFeesSol: 0,
        outOfRangeSince: null,
      },
    ],
  } as unknown as WalletState;
}

function makeManager(rules: NotifRule[]) {
  const bus = new EventBus();
  const config = { listNotifRules: () => rules } as unknown as ConfigRepository;
  const presence: PresenceReader = { isAnyClientActive: () => false };
  const push = { deliver: vi.fn(async () => {}) };
  const bark = { deliver: vi.fn(async () => {}) };
  const mgr = new NotificationManager(
    bus,
    config,
    presence,
    bark as unknown as NotificationChannel,
    push as unknown as NotificationChannel,
    noopLogger,
  );
  return { bus, mgr, push };
}

describe('NotificationManager — startup grace (R02)', () => {
  it('fires a breach that existed at boot once grace passes (not suppressed forever)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { bus, mgr, push } = makeManager([pnlRule]);
    mgr.start(); // startAt = now → in grace

    // In grace: held AND not marked (the bug marked it here, suppressing it forever).
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).not.toHaveBeenCalled();

    // Past grace (> 10s): the still-breached state must now alert exactly once.
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'));
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).toHaveBeenCalledTimes(1);

    // The once-guard holds on subsequent identical ticks.
    bus.emit('state', breachState('P', 2));
    expect(push.deliver).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('NotificationManager — threshold key reclamation (R07)', () => {
  it('forgets a position threshold key on close so the Set does not leak', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { bus, mgr, push } = makeManager([pnlRule]);
    mgr.start();
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z')); // past grace

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
    vi.useRealTimers();
  });
});
