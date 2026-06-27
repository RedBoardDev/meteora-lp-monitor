import type { Connection } from '@solana/web3.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { LegRepository } from '@/domain/ports';
import { DlmmIngest } from './dlmm-ingest';

const WALLET = 'So11111111111111111111111111111111111111112';
const logger = pino({ level: 'silent' });

/** A minimal parsed tx (no DLMM legs) — the decoder yields [], so the test isolates the FETCH fallback. */
const fakeTx = (sig: string) =>
  ({
    slot: 1,
    blockTime: 100,
    transaction: { signatures: [sig], message: { accountKeys: [], instructions: [] } },
    meta: { err: null, innerInstructions: [], preBalances: [], postBalances: [] },
  }) as unknown as Record<string, unknown>;

class FakeRepo implements Partial<LegRepository> {
  replaced: { sigs: string[]; legs: unknown[] }[] = [];
  async getCursor() {
    return null;
  }
  async replaceForSignatures(_w: string, sigs: string[], legs: unknown[]) {
    this.replaced.push({ sigs, legs });
  }
  async setCursor() {}
}

describe('DlmmIngest — free-tier single-call fallback', () => {
  it('falls back to single getParsedTransaction when the RPC rejects BATCH requests (free tier)', async () => {
    // WHY: free Helius keys 403 batch JSON-RPC ("Batch requests are only available for paid plans").
    // getParsedTransactions sends a batch, so without a fallback the leg ingest ABORTS the page = missed
    // legs (no-miss broken) on a free key. The fallback must fetch each sig with a SINGLE call and ingest
    // the page normally.
    let batchCalls = 0;
    let singleCalls = 0;
    const conn = {
      async getSignaturesForAddress(_owner: unknown, opts: { before?: string }) {
        // one page (2 sigs) then nothing; <1000 rows ends the backfill at genesis.
        return opts?.before
          ? []
          : [
              { signature: 'sigA', err: null, blockTime: 100 },
              { signature: 'sigB', err: null, blockTime: 99 },
            ];
      },
      async getParsedTransactions() {
        batchCalls++;
        throw new Error(
          '403 Forbidden: {"jsonrpc":"2.0","error":{"code":-32403,"message":"Batch requests are only available for paid plans. Please upgrade"}}',
        );
      },
      async getParsedTransaction(sig: string) {
        singleCalls++;
        return fakeTx(sig);
      },
    } as unknown as Connection;

    const repo = new FakeRepo();
    const ingest = new DlmmIngest(conn, repo as unknown as LegRepository, logger);
    const res = await ingest.ingest(WALLET);

    expect(batchCalls).toBeGreaterThanOrEqual(1); // it TRIED the batch…
    expect(singleCalls).toBe(2); // …then fell back to ONE single call per sig
    expect(res.txs).toBe(2); // both txs decoded (page not aborted)
    // the page was persisted (replaceForSignatures), NOT dropped — no missed legs on a free key.
    expect(repo.replaced).toHaveLength(1);
    expect(repo.replaced[0]!.sigs).toEqual(['sigA', 'sigB']);
    expect(res.complete).toBe(true);
  });
});
