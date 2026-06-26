import type { Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { RawRpc } from './gpa-v2';
import { OnchainDlmmGateway } from './onchain-gateway';

const OWNER = 'So11111111111111111111111111111111111111112';

/** getMultipleAccounts stubs (empty/null infos) — enough to exercise the discovery-gating path. */
class FakeConn {
  async getMultipleAccountsInfoAndContext(keys: unknown[]) {
    return { context: { slot: 100 }, value: keys.map(() => null) };
  }
  async getMultipleAccountsInfo(keys: unknown[]) {
    return keys.map(() => null);
  }
}

/** A getProgramAccountsV2 raw-RPC spy: records the method names it's asked for, returns ONE empty page. */
function fakeRawRpc(): RawRpc & { calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const fn = vi.fn(async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    // V2 envelope: no accounts, last page (paginationKey null).
    return { result: { accounts: [], paginationKey: null } };
  }) as unknown as RawRpc & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe('OnchainDlmmGateway — Layer A discovery gating', () => {
  it('discovers via getProgramAccountsV2, and skips it when a cached plan is reused', async () => {
    const conn = new FakeConn();
    const raw = fakeRawRpc();
    const g = new OnchainDlmmGateway(conn as unknown as Connection, raw);

    const fresh = await g.snapshotWallet(OWNER);
    expect(raw.calls).toHaveLength(1); // discovery ran on the fresh path…
    expect(raw.calls[0]!.method).toBe('getProgramAccountsV2'); // …as the 1-credit V2 method (asserted)
    expect(fresh.complete).toBe(true); // no positions → nothing could be under-counted

    const reused = await g.snapshotWallet(OWNER, fresh.plan);
    expect(raw.calls).toHaveLength(1); // discovery SKIPPED — no extra V2 call on the cached-plan path

    expect(reused.positions).toEqual(fresh.positions);
    expect(reused.nativeLamports).toBe(fresh.nativeLamports);
    expect(reused.idleTokens).toEqual(fresh.idleTokens);
  });

  it('re-discovers (one getProgramAccountsV2) every time when no plan is passed', async () => {
    const conn = new FakeConn();
    const raw = fakeRawRpc();
    const g = new OnchainDlmmGateway(conn as unknown as Connection, raw);
    await g.snapshotWallet(OWNER);
    await g.snapshotWallet(OWNER);
    expect(raw.calls).toHaveLength(2);
    expect(raw.calls.every((c) => c.method === 'getProgramAccountsV2')).toBe(true);
  });
});

describe('OnchainDlmmGateway — decimals cache', () => {
  it('does not poison decimals at 0 on a transient RPC null, and heals on retry', async () => {
    const data = new Uint8Array(82); // SPL Mint layout — decimals byte @ offset 44
    data[44] = 6;
    let calls = 0;
    const conn = {
      async getMultipleAccountsInfo() {
        calls++;
        return calls === 1 ? [null] : [{ data }]; // first call: transient miss; then the real mint
      },
    } as unknown as Connection;
    const g = new OnchainDlmmGateway(conn);

    // A transient null falls back to 0 for THIS call but must NOT be cached…
    expect(await g.decimalsOf(OWNER)).toBe(0);
    // …so the retry hits the RPC again and heals to the real decimals (would stay 0 if 0 were cached).
    expect(await g.decimalsOf(OWNER)).toBe(6);
    expect(calls).toBe(2); // both reached the RPC — proves the null was never cached
    // Now the real value is cached: a third read serves from memory, no extra RPC.
    expect(await g.decimalsOf(OWNER)).toBe(6);
    expect(calls).toBe(2);
  });
});
