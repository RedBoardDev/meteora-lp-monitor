import { describe, expect, it, vi } from 'vitest';
import { PriorityFeeOracle } from './priority-fee-oracle';

type FetchInit = { method: string; headers: Record<string, string>; body: string };
const HTTP = 'https://helius.example';
const ACCT = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'; // DLMM program (scope key)
const LEVELS = { min: 0, low: 10_000, medium: 120_000, high: 900_000, veryHigh: 5_000_000, unsafeMax: 50_000_000 };
const okFetch = (levels = LEVELS): ((u: string, i: FetchInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) =>
  (_u, _i) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: { priorityFeeLevels: levels } }) });

describe('priority-fee-oracle · PriorityFeeOracle', () => {
  it('returns null before it is primed (caller falls back to the static tier)', () => {
    const oracle = new PriorityFeeOracle(HTTP, ACCT, 0, okFetch());
    expect(oracle.get('medium')).toBeNull();
  });

  it('maps each tier to its Helius level after a successful refresh', async () => {
    const oracle = new PriorityFeeOracle(HTTP, ACCT, 0, okFetch());
    await oracle.refresh();
    expect(oracle.get('low')).toBe(LEVELS.low);
    expect(oracle.get('medium')).toBe(LEVELS.medium);
    expect(oracle.get('high')).toBe(LEVELS.high);
  });

  it('POSTs getPriorityFeeEstimate scoped to the account, asking for all levels', async () => {
    const fetchFn = vi.fn(okFetch());
    await new PriorityFeeOracle(HTTP, ACCT, 0, fetchFn).refresh();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(HTTP);
    const body = JSON.parse(init.body);
    expect(body.method).toBe('getPriorityFeeEstimate');
    expect(body.params[0].accountKeys).toEqual([ACCT]);
    expect(body.params[0].options.includeAllPriorityFeeLevels).toBe(true);
  });

  it('keeps the last good value when a later poll fails (a transient blip must not blank the cache)', async () => {
    // WHY: the oracle feeds the live fee floor — blanking it on one bad poll would silently drop us to the static
    // tier mid-congestion. The last good estimate must survive a transient RPC error.
    let calls = 0;
    const flaky = (_u: string, _i: FetchInit) => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: { priorityFeeLevels: LEVELS } }) })
        : Promise.reject(new Error('network'));
    };
    const oracle = new PriorityFeeOracle(HTTP, ACCT, 0, flaky);
    await oracle.refresh();
    await oracle.refresh(); // throws internally → swallowed
    expect(oracle.get('high')).toBe(LEVELS.high);
  });

  it('returns null for a non-2xx response (kept un-primed → static tier)', async () => {
    const oracle = new PriorityFeeOracle(HTTP, ACCT, 0, () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) }));
    await oracle.refresh();
    expect(oracle.get('medium')).toBeNull();
  });

  it('returns null for a zero/garbage level (so the caller never sets a zero fee)', async () => {
    const oracle = new PriorityFeeOracle(HTTP, ACCT, 0, okFetch({ ...LEVELS, medium: 0 }));
    await oracle.refresh();
    expect(oracle.get('medium')).toBeNull();
    expect(oracle.get('high')).toBe(LEVELS.high); // siblings unaffected
  });

  it('start() primes then refreshes on the timer; stop() halts further refreshes', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(okFetch());
      const oracle = new PriorityFeeOracle(HTTP, ACCT, 1_000, fetchFn);
      await oracle.start(); // primes immediately (1 fetch)
      expect(oracle.get('medium')).toBe(LEVELS.medium);
      await vi.advanceTimersByTimeAsync(1_000); // one background tick
      expect(fetchFn).toHaveBeenCalledTimes(2);
      oracle.stop();
      await vi.advanceTimersByTimeAsync(3_000); // no more ticks after stop
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
