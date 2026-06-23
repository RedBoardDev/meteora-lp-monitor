import type { Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { OnchainDlmmGateway } from './onchain-gateway';

const OWNER = 'So11111111111111111111111111111111111111112';

/** Records RPC calls; returns empty/null accounts (enough to exercise the discovery-gating path). */
class FakeConn {
  gpaCalls = 0;
  async getProgramAccounts(): Promise<unknown[]> {
    this.gpaCalls++;
    return [];
  }
  async getMultipleAccountsInfoAndContext(keys: unknown[]) {
    return { context: { slot: 100 }, value: keys.map(() => null) };
  }
  async getMultipleAccountsInfo(keys: unknown[]) {
    return keys.map(() => null);
  }
}

describe('OnchainDlmmGateway — Layer A discovery gating', () => {
  it('skips getProgramAccounts when a cached plan is reused, with an identical snapshot', async () => {
    const conn = new FakeConn();
    const g = new OnchainDlmmGateway(conn as unknown as Connection);

    const fresh = await g.snapshotWallet(OWNER);
    expect(conn.gpaCalls).toBe(1); // discovery (gPA) ran on the fresh path
    expect(fresh.complete).toBe(true); // no positions → nothing could be under-counted

    const reused = await g.snapshotWallet(OWNER, fresh.plan);
    expect(conn.gpaCalls).toBe(1); // discovery SKIPPED — the 10-credit gPA is gated away

    expect(reused.positions).toEqual(fresh.positions);
    expect(reused.nativeLamports).toBe(fresh.nativeLamports);
    expect(reused.idleTokens).toEqual(fresh.idleTokens);
  });

  it('re-discovers every time when no plan is passed', async () => {
    const conn = new FakeConn();
    const g = new OnchainDlmmGateway(conn as unknown as Connection);
    await g.snapshotWallet(OWNER);
    await g.snapshotWallet(OWNER);
    expect(conn.gpaCalls).toBe(2);
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
