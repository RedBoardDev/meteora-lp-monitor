import { describe, expect, it } from 'vitest';
import { rpcMethodOf, SolanaRpcRateLimiter, Spacer } from './rpc-rate-limiter';

describe('Spacer', () => {
  it('spaces reservations by 1000/rps with a frozen clock', () => {
    const s = new Spacer(10, () => 1000); // 100ms spacing
    expect(s.reserve()).toBe(1000);
    expect(s.reserve()).toBe(1100);
    expect(s.reserve()).toBe(1200);
  });

  it('never reserves in the past after an idle gap (no burst credit)', () => {
    let now = 1000;
    const s = new Spacer(10, () => now);
    expect(s.reserve()).toBe(1000);
    now = 5000; // long idle — the next slot is `now`, not lastAt+spacing
    expect(s.reserve()).toBe(5000);
  });
});

describe('rpcMethodOf', () => {
  it('reads the method from a JSON-RPC body', () => {
    expect(
      rpcMethodOf(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts' })),
    ).toBe('getProgramAccounts');
  });

  it('reads the first method of a batch', () => {
    expect(
      rpcMethodOf(JSON.stringify([{ method: 'getParsedTransaction' }, { method: 'getBalance' }])),
    ).toBe('getParsedTransaction');
  });

  it('returns undefined for non-string or unparseable bodies', () => {
    expect(rpcMethodOf(undefined)).toBeUndefined();
    expect(rpcMethodOf('not json')).toBeUndefined();
    expect(rpcMethodOf(JSON.stringify({ id: 1 }))).toBeUndefined();
  });
});

describe('SolanaRpcRateLimiter', () => {
  const limits = { rps: 10, gpaRps: 5, dasRps: 2, sendRps: 1 };

  it('applies the tighter method sub-limit: getProgramAccounts pays 5/s, not the overall 10/s', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 1000);
    expect(lim.reserveSlot('getProgramAccounts')).toBe(1000);
    // 2nd gPA waits 200ms (5/s) — the method bucket dominates the 100ms overall slot.
    expect(lim.reserveSlot('getProgramAccounts')).toBe(1200);
  });

  it('an unconstrained method only pays the overall 10/s', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 0);
    expect(lim.reserveSlot('getParsedTransaction')).toBe(100);
    expect(lim.reserveSlot('getParsedTransaction')).toBe(200);
  });

  it('keeps overall spacing across mixed methods — no coincident fire after a sub-limit wait', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 1000);
    expect(lim.reserveSlot('getProgramAccounts')).toBe(1000);
    expect(lim.reserveSlot('getProgramAccounts')).toBe(1200); // gPA pushed to 1200
    // A regular call must fire AFTER the last real fire (1200), not collide at 1200.
    expect(lim.reserveSlot('getBalance')).toBe(1300);
  });

  it('stats() breaks calls down by exact method — telemetry to find the credit-heavy call', () => {
    const lim = new SolanaRpcRateLimiter(limits, () => 0);
    lim.reserveSlot('getParsedTransaction');
    lim.reserveSlot('getParsedTransaction');
    lim.reserveSlot('getMultipleAccounts');
    lim.reserveSlot('getProgramAccounts');
    lim.reserveSlot(undefined);
    const s = lim.stats();
    expect(s.total).toBe(5);
    expect(s.byMethod).toEqual({
      getParsedTransaction: 2,
      getMultipleAccounts: 1,
      getProgramAccounts: 1,
      unknown: 1,
    });
    expect(s.gpa).toBe(1); // coarse class buckets still tracked alongside the per-method split
  });
});
