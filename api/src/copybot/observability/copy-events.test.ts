/**
 * Copy-bot · observability — `CopyEvents` emitter. These tests encode the WHY:
 *  - `assemble` denormalizes the registry facets and threads `correlationId = commandId ?? eventKey` (the dedup
 *    key + lifecycle thread) — a wrong correlation would break dedup AND the per-lifecycle admin query;
 *  - `emit` mirrors to pino at the code's severity and routes pinned→durable / else→fire-and-forget — a pinned
 *    alert that took the non-durable path could be lost (the copy-bot's no-miss cardinal sin);
 *  - the in-process LRU collapses a WS + cursor-poll double-detect to ONE row (SPEC §6);
 *  - emit NEVER throws — a logging hiccup must never break the hot path.
 */
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { CopyEvent, CopyEventContext } from '@/domain/copybot/observability/event';
import { assemble, CopyEvents, serializeCause } from './copy-events';
import type { EventStore } from './event-store';

const BASE: CopyEventContext = { userId: 'system', wallet: 'WALLETxyz', process: 'brain' };

function fakeStore(): { store: EventStore; persisted: CopyEvent[]; durable: CopyEvent[] } {
  const persisted: CopyEvent[] = [];
  const durable: CopyEvent[] = [];
  const store = {
    persist: (e: CopyEvent) => void persisted.push(e),
    persistDurable: async (e: CopyEvent) => void durable.push(e),
  } as unknown as EventStore;
  return { store, persisted, durable };
}

function fakeLog(): Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

describe('assemble (pure)', () => {
  it('denormalizes severity/category/audience/pinned from the registry and stamps ts/eventTs/ctx', () => {
    const e = assemble('lifecycle.open_failed', { stage: 'open', outcome: 'failed', commandId: 'CMD' }, BASE, 1000);
    expect(e.code).toBe('lifecycle.open_failed');
    expect(e.severity).toBe('error');
    expect(e.category).toBe('LIFECYCLE');
    expect(e.audience).toBe('feed');
    expect(e.pinned).toBe(true);
    expect(e.ts).toBe(1000);
    expect(e.eventTs).toBe(1000); // defaults to ts when no business time observed
    expect(e.ctx).toBe(BASE);
  });

  it('threads correlationId = commandId ?? eventKey (commandId wins)', () => {
    expect(assemble('detect.observed', { stage: 'detect', outcome: 'detected', commandId: 'C', eventKey: 'K' }, BASE, 1).correlationId).toBe('C');
    expect(assemble('detect.observed', { stage: 'detect', outcome: 'detected', eventKey: 'K' }, BASE, 1).correlationId).toBe('K');
  });

  it('honors an explicit eventTs (business/observed time) over the stamp', () => {
    expect(assemble('detect.observed', { stage: 'detect', outcome: 'detected', eventTs: 42 }, BASE, 1000).eventTs).toBe(42);
  });
});

describe('CopyEvents.emit · routing + mirror', () => {
  it('mirrors a non-pinned event to pino at its severity and fire-and-forget persists it', () => {
    const { store, persisted, durable } = fakeStore();
    const log = fakeLog();
    new CopyEvents(store, log, BASE).emit('detect.observed', { stage: 'detect', outcome: 'detected', commandId: 'A' });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(1);
    expect(durable).toHaveLength(0);
    expect(persisted[0]!.code).toBe('detect.observed');
    expect(persisted[0]!.ctx.wallet).toBe('WALLETxyz'); // tenancy back-filled
  });

  it('routes a pinned event to the DURABLE path (so a critical alert is never lost) at error level', () => {
    const { store, persisted, durable } = fakeStore();
    const log = fakeLog();
    new CopyEvents(store, log, BASE).emit('lifecycle.open_failed', { stage: 'open', outcome: 'failed', commandId: 'B' });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(durable).toHaveLength(1);
    expect(persisted).toHaveLength(0);
  });
});

describe('CopyEvents.emit · dedup (SPEC §6)', () => {
  it('collapses a repeat of the same (correlationId, code) to ONE row (WS + cursor-poll double-detect)', () => {
    const { store, persisted } = fakeStore();
    const events = new CopyEvents(store, fakeLog(), BASE);
    events.emit('detect.observed', { stage: 'detect', outcome: 'detected', commandId: 'SAME' });
    events.emit('detect.observed', { stage: 'detect', outcome: 'detected', commandId: 'SAME' });
    expect(persisted).toHaveLength(1);
  });

  it('does NOT dedup a different code on the same correlation (distinct lifecycle steps are distinct rows)', () => {
    const { store, persisted } = fakeStore();
    const events = new CopyEvents(store, fakeLog(), BASE);
    events.emit('detect.observed', { stage: 'detect', outcome: 'detected', commandId: 'SAME' });
    events.emit('detect.routed', { stage: 'detect', outcome: 'detected', commandId: 'SAME' });
    expect(persisted).toHaveLength(2);
  });
});

describe('CopyEvents.emit · never throws (the cardinal guarantee)', () => {
  it('swallows a store/assembly failure and logs loud rather than breaking the hot path', () => {
    const log = fakeLog();
    const throwingStore = {
      persist: () => {
        throw new Error('boom');
      },
      persistDurable: async () => undefined,
    } as unknown as EventStore;
    const events = new CopyEvents(throwingStore, log, BASE);
    expect(() => events.emit('detect.observed', { stage: 'detect', outcome: 'detected', commandId: 'X' })).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(1); // failed loud...
  });
});

describe('serializeCause', () => {
  it('serializes an Error to a JSON-safe {name,message,stack} (NOT a live Error)', () => {
    const c = serializeCause(new Error('nope'));
    expect(c).toMatchObject({ name: 'Error', message: 'nope' });
    expect(typeof c!.stack).toBe('string');
  });

  it('serializes a non-Error throw deterministically', () => {
    expect(serializeCause('weird')).toEqual({ name: 'NonError', message: 'weird' });
  });
});
