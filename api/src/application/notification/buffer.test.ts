import type { LiveEvent } from '@binsight/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkBuffer } from './buffer';

const WINDOW_MS = 8000;
const ev = (over: { id?: string; kind: LiveEvent['kind']; pair?: string }): LiveEvent =>
  ({ id: 'e', title: 't', body: 'b', pair: 'SOL/USDC', ...over }) as unknown as LiveEvent;
const flushFn = () => vi.fn((_e: LiveEvent): Promise<void> => Promise.resolve());

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

// BulkBuffer debounces same-kind notifications over an 8s window so a burst of N closes becomes ONE summary banner
// instead of N. The behavior that matters: a lone event flushes verbatim; a burst coalesces into "N × kind"; each
// kind has its own independent window; and a fresh event after a flush opens a NEW window.
describe('BulkBuffer — same-kind notification coalescing', () => {
  it('a single event flushes AS-IS after the window (no summary)', async () => {
    const onFlush = flushFn();
    const buf = new BulkBuffer(onFlush);
    const e = ev({ id: '1', kind: 'position_close', pair: 'SOL/USDC' });
    buf.add(e);
    expect(onFlush).not.toHaveBeenCalled(); // debounced — nothing fires before the window elapses
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(e); // unchanged — a lone event is not rewritten into a summary
  });

  it('a burst of the same kind coalesces into ONE summary ("N × kind", joined pairs, count)', async () => {
    const onFlush = flushFn();
    const buf = new BulkBuffer(onFlush);
    buf.add(ev({ id: '1', kind: 'position_close', pair: 'SOL/USDC' }));
    buf.add(ev({ id: '2', kind: 'position_close', pair: 'JUP/SOL' }));
    buf.add(ev({ id: '3', kind: 'position_close', pair: undefined })); // missing pair → '?' in the body
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(onFlush).toHaveBeenCalledTimes(1);
    const arg = onFlush.mock.calls[0]?.[0] as LiveEvent;
    expect(arg.title).toBe('3 × position close'); // underscores → spaces
    expect(arg.body).toBe('SOL/USDC, JUP/SOL, ?');
    expect(arg.data).toEqual({ count: 3 });
  });

  it('different kinds buffer independently and each flushes its own window', async () => {
    const onFlush = flushFn();
    const buf = new BulkBuffer(onFlush);
    buf.add(ev({ id: '1', kind: 'position_close' }));
    buf.add(ev({ id: '2', kind: 'position_open' }));
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(onFlush).toHaveBeenCalledTimes(2); // one flush per distinct kind
    const kinds = onFlush.mock.calls.map((c) => (c[0] as LiveEvent).kind);
    expect(new Set(kinds)).toEqual(new Set(['position_close', 'position_open']));
  });

  it('a new event after a flush opens a FRESH window (the timer resets per kind)', async () => {
    const onFlush = flushFn();
    const buf = new BulkBuffer(onFlush);
    buf.add(ev({ id: '1', kind: 'position_close' }));
    await vi.advanceTimersByTimeAsync(WINDOW_MS); // window 1 flushes
    expect(onFlush).toHaveBeenCalledTimes(1);
    buf.add(ev({ id: '2', kind: 'position_close' })); // a later same-kind event must NOT be dropped
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });
});
