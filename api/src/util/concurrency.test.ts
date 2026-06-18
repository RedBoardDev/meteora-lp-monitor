import { describe, expect, it } from 'vitest';
import { KeyedSerializer, Semaphore } from './concurrency';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Semaphore', () => {
  it('never exceeds the cap under many concurrent run()s', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active--;
      });
    await Promise.all(Array.from({ length: 10 }, task));
    expect(maxActive).toBe(2); // cap held; never 3+
    expect(sem.activeCount).toBe(0); // all permits released
  });

  it('releases the permit even when the task throws (no leak / deadlock)', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await sem.run(async () => 42)).toBe(42); // permit freed → next acquire proceeds
  });
});

describe('KeyedSerializer', () => {
  it('serializes same-key work but runs different keys in parallel', async () => {
    const ks = new KeyedSerializer();
    const order: string[] = [];
    const job = (key: string, id: string, ms: number) =>
      ks.run(key, async () => {
        order.push(`${id}-start`);
        await sleep(ms);
        order.push(`${id}-end`);
      });
    await Promise.all([job('A', 'a1', 15), job('A', 'a2', 1), job('B', 'b1', 1)]);
    // same key A: a1 fully precedes a2 (no overlap)
    expect(order.indexOf('a1-end')).toBeLessThan(order.indexOf('a2-start'));
    // different key B overlaps A's first job (started before a1 finished)
    expect(order.indexOf('b1-start')).toBeLessThan(order.indexOf('a1-end'));
  });

  it('a rejected job does not wedge the key chain', async () => {
    const ks = new KeyedSerializer();
    await expect(
      ks.run('A', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(await ks.run('A', async () => 7)).toBe(7); // chain still flows after a rejection
  });
});
