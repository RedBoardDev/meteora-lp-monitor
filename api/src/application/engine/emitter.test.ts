import type { Health } from '@binsight/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/application/event-bus';
import { HealthMonitor } from '@/application/health-monitor';
import type { RpcSubscriber } from '@/domain/ports';
import { StateEmitter } from './emitter';
import { makeRuntime, type WalletRuntime } from './runtime';

/** Minimal RpcSubscriber stub — emitHealth only reads isConnected(). */
function fakeSubscriber(connected: () => boolean): RpcSubscriber {
  return {
    isConnected: connected,
    start: () => {},
    stop: () => {},
    watch: () => {},
    unwatch: () => {},
    onReconnect: () => {},
    onConnectionChange: () => {},
  } as unknown as RpcSubscriber;
}

function setup(connected: () => boolean = () => true) {
  const wallets = new Map<string, WalletRuntime>();
  const bus = new EventBus();
  const health = new HealthMonitor();
  const emitter = new StateEmitter(wallets, fakeSubscriber(connected), bus, health);
  const emits: Health[] = [];
  bus.on('health', (h) => emits.push(h));
  return { wallets, bus, health, emitter, emits };
}

describe('StateEmitter.emitHealth — emit-on-change', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits on the first tick then dedups identical ticks (no idle per-second churn)', () => {
    // WHY: the WS layer re-sorts/filters/stringifies the health frame per distinct watched-set on every
    // emit — O(users × wallets). A tick where nothing a client renders changed must not re-broadcast.
    const { emitter, emits } = setup();
    emitter.emitHealth(0);
    emitter.emitHealth(0);
    emitter.emitHealth(0);
    expect(emits).toHaveLength(1);
  });

  it('does NOT re-emit when only uptime advances (monotonic field excluded from the signature)', () => {
    // WHY: uptimeSeconds ticks every second; if it counted toward the change signature it would defeat
    // the dedup and the O(users × wallets) churn would come straight back.
    const uptime = vi.spyOn(process, 'uptime');
    const { emitter, emits } = setup();
    uptime.mockReturnValue(10);
    emitter.emitHealth(0);
    uptime.mockReturnValue(45);
    emitter.emitHealth(0);
    expect(emits).toHaveLength(1);
  });

  it('re-emits immediately when a rendered field changes (chain tip, rps, ws, wallet set)', () => {
    // WHY: freshness must be preserved — a real status/value change reaches viewers on the next tick.
    const connected = { v: true };
    const { emitter, emits, health, wallets } = setup(() => connected.v);
    emitter.emitHealth(0);
    expect(emits).toHaveLength(1);

    health.setChainTip(1000); // chain tip advanced → new frame
    emitter.emitHealth(0);
    expect(emits).toHaveLength(2);

    emitter.emitHealth(5); // effectiveRps changed → new frame
    expect(emits).toHaveLength(3);

    connected.v = false; // ws dropped → new frame
    emitter.emitHealth(5);
    expect(emits).toHaveLength(4);

    wallets.set('W', makeRuntime('W', [])); // wallet set changed → new frame
    emitter.emitHealth(5);
    expect(emits).toHaveLength(5);
  });

  it('snapshotHealth() returns the full payload (uptime + sources) without emitting', () => {
    // WHY: a freshly-connected WS client must be handed the CURRENT health on connect (emit-on-change
    // means it wouldn't otherwise get a frame until the next real change).
    vi.spyOn(process, 'uptime').mockReturnValue(88);
    const { emitter, emits } = setup();
    const snap = emitter.snapshotHealth(4);
    expect(snap).toMatchObject({ ok: true, wsConnected: true, effectiveRps: 4, uptimeSeconds: 88 });
    expect(Array.isArray(snap.sources)).toBe(true);
    expect(emits).toHaveLength(0); // pure read — it must NOT emit
  });

  it('snapshotHealth() does not touch the dedup state (a following emit still fires)', () => {
    // WHY: the connect-time snapshot must be side-effect-free — it must not make the next emitHealth
    // skip by pre-seeding lastHealthSig.
    const { emitter, emits } = setup();
    emitter.snapshotHealth();
    emitter.snapshotHealth();
    emitter.emitHealth(0);
    expect(emits).toHaveLength(1); // the emit still happened despite prior snapshots
  });

  it('snapshotHealth() defaults effectiveRps to the last value seen by emitHealth', () => {
    // WHY: at connect time the WS layer has no effectiveRps to pass; the snapshot must reflect the
    // engine's most recent tick value rather than a bogus 0.
    const { emitter } = setup();
    emitter.emitHealth(7);
    expect(emitter.snapshotHealth().effectiveRps).toBe(7);
  });

  it('keeps the health payload shape identical (uptimeSeconds still present in the emitted frame)', () => {
    // WHY: the dedup must be transparent to consumers — the emitted frame is byte-for-byte what it was.
    vi.spyOn(process, 'uptime').mockReturnValue(77);
    const { emitter, emits } = setup();
    emitter.emitHealth(3);
    expect(emits[0]).toMatchObject({
      ok: true,
      wsConnected: true,
      meteoraOk: true,
      effectiveRps: 3,
      chainTipSlot: null,
      wallets: [],
      uptimeSeconds: 77,
    });
    expect(Array.isArray(emits[0]?.sources)).toBe(true);
  });
});
