import { describe, expect, it } from 'vitest';
import { createPositionQueue } from './position-queue';

/** A promise you resolve/reject manually — lets a test hold a task "in flight" and assert ordering deterministically. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush ALL pending microtasks by yielding to a macrotask — deterministic regardless of how many microtask hops
// the internal promise chain takes (avoids counting ticks). A task suspended on an unresolved deferred stays
// suspended across a flush, so "in flight" assertions remain valid.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('PositionQueue — per-position serial dispatch (duplicate-open guard)', () => {
  it('runs same-key tasks STRICTLY serially: task2 starts only after task1 SETTLES', async () => {
    const q = createPositionQueue();
    const order: string[] = [];
    const d1 = deferred();

    q.run('K', async () => {
      order.push('t1:start');
      await d1.promise;
      order.push('t1:end');
    });
    q.run('K', async () => {
      order.push('t2:start');
    });

    await tick();
    // task1 is in flight (awaiting d1); task2 MUST NOT have started — this is the property that stops a second
    // handleOpen from running while the first open's registry.open has not yet executed.
    expect(order).toEqual(['t1:start']);

    d1.resolve();
    await d1.promise;
    await tick();
    await tick();
    expect(order).toEqual(['t1:start', 't1:end', 't2:start']);
  });

  it('runs DIFFERENT keys concurrently (independent chains)', async () => {
    const q = createPositionQueue();
    const order: string[] = [];
    const dA = deferred();

    q.run('A', async () => {
      order.push('A:start');
      await dA.promise; // A stays in flight
      order.push('A:end');
    });
    q.run('B', async () => {
      order.push('B:start'); // B is a different key → must run without waiting for A
    });

    await tick();
    expect(order).toEqual(['A:start', 'B:start']);
    dA.resolve();
    await dA.promise;
    await tick();
    expect(order).toEqual(['A:start', 'B:start', 'A:end']);
  });

  it('a THROWING task does not block the next task for that key (queue never drops an event)', async () => {
    const q = createPositionQueue();
    const order: string[] = [];

    q.run('K', async () => {
      order.push('t1');
      throw new Error('boom'); // a handler failure must not stall the position's queue
    });
    q.run('K', async () => {
      order.push('t2');
    });

    await tick();
    await tick();
    await tick();
    expect(order).toEqual(['t1', 't2']);
  });

  it('a task that throws SYNCHRONOUSLY still lets the next task run', async () => {
    const q = createPositionQueue();
    const order: string[] = [];
    // Not async on purpose: throwing before returning a promise must be caught by the chain, not crash it.
    q.run('K', () => {
      order.push('t1');
      throw new Error('sync boom');
    });
    q.run('K', async () => {
      order.push('t2');
    });

    await tick();
    await tick();
    await tick();
    expect(order).toEqual(['t1', 't2']);
  });

  it('drains the internal map after a key goes idle (no unbounded growth)', async () => {
    const q = createPositionQueue();
    const d1 = deferred();
    q.run('K', async () => {
      await d1.promise;
    });
    expect(q.size()).toBe(1); // chain live while the task is queued/in-flight
    d1.resolve();
    await d1.promise;
    await tick();
    await tick();
    expect(q.size()).toBe(0); // drained once the queue emptied
  });

  it('keeps the chain live while later tasks are still queued, then drains', async () => {
    const q = createPositionQueue();
    const d1 = deferred();
    const d2 = deferred();
    q.run('K', async () => {
      await d1.promise;
    });
    q.run('K', async () => {
      await d2.promise;
    });
    expect(q.size()).toBe(1);
    d1.resolve();
    await d1.promise;
    await tick();
    expect(q.size()).toBe(1); // task2 still in flight → chain not dropped
    d2.resolve();
    await d2.promise;
    await tick();
    await tick();
    expect(q.size()).toBe(0);
  });
});
