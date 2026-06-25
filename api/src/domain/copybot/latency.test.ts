import { describe, expect, it, vi } from 'vitest';
import { runParallel, withTimeout } from './latency';

describe('withTimeout', () => {
  it('promise resolved before the delay → the value', async () => {
    expect(await withTimeout(Promise.resolve(42), 1000)).toBe(42);
  });

  it('promise that rejects → undefined (a failed check does not take down the decision)', async () => {
    expect(await withTimeout(Promise.reject(new Error('boom')), 1000)).toBeUndefined();
  });

  it('delay exceeded → undefined', async () => {
    vi.useFakeTimers();
    const never = new Promise<number>(() => {});
    const r = withTimeout(never, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await r).toBeUndefined();
    vi.useRealTimers();
  });

  it('resolution AFTER the timeout → ignored (the timeout already settled it as undefined)', async () => {
    // WHY: a late response must not "wake up" a decision already made (anti-double-settlement guard).
    vi.useFakeTimers();
    const slow = new Promise<number>((res) => setTimeout(() => res(5), 200));
    const r = withTimeout(slow, 100);
    await vi.advanceTimersByTimeAsync(200); // timeout at 100, then late resolution at 200
    expect(await r).toBeUndefined();
    vi.useRealTimers();
  });
});

describe('runParallel', () => {
  it('collects all results in order; undefined for failures', async () => {
    const r = await runParallel(
      [() => Promise.resolve(1), () => Promise.reject(new Error()), () => Promise.resolve(3)],
      1000,
    );
    expect(r).toEqual([1, undefined, 3]);
  });

  it('catches a SYNCHRONOUS throw from a task → undefined (no global rejection)', async () => {
    const r = await runParallel(
      [
        () => {
          throw new Error('sync');
        },
        () => Promise.resolve(2),
      ],
      1000,
    );
    expect(r).toEqual([undefined, 2]);
  });

  it('runs IN PARALLEL: 3 tasks of 100ms resolve after ~100ms (not 300)', async () => {
    vi.useFakeTimers();
    const delayed = (v: number) => () => new Promise<number>((res) => setTimeout(() => res(v), 100));
    const p = runParallel([delayed(1), delayed(2), delayed(3)], 1000);
    await vi.advanceTimersByTimeAsync(100); // a single 100ms tick is enough for all 3 → parallel
    expect(await p).toEqual([1, 2, 3]);
    vi.useRealTimers();
  });
});
