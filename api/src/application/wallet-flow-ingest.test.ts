import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { FlowCursor, WalletFlowRow } from '@/domain/dlmm';
import type { EnhancedTxGateway, WalletFlowRepository } from '@/domain/ports';
import { WalletFlowIngest } from './wallet-flow-ingest';

const noopLogger = { info: () => {}, warn: () => {} } as unknown as Logger;

type PageResult = {
  flows: WalletFlowRow[];
  complete: boolean;
  hitKnownTop?: boolean;
  newestSig: string | null;
  oldestSig: string | null;
};

/** In-memory repo capturing the cursor + the flows that were upserted. */
function fakeRepo(initial: FlowCursor | null) {
  let cursor = initial;
  const upserted: WalletFlowRow[] = [];
  return {
    upserted,
    cursor: () => cursor,
    repo: {
      getCursor: async () => cursor,
      setCursor: async (_w: string, c: FlowCursor) => {
        cursor = c;
      },
      upsertFlows: async (_w: string, flows: WalletFlowRow[]) => {
        upserted.push(...flows);
      },
    } as unknown as WalletFlowRepository,
  };
}

type PageOpts = {
  untilSig?: string | null;
  startBefore?: string | null;
  onPage: (flows: WalletFlowRow[]) => Promise<void>;
};

// Wraps a canned page result into the real pageFlows contract: hand the flows to onPage (so the repo
// persists them), then report `added` + boundaries. Lets each test declare its data plainly.
const gateway = (page: (w: string, o: PageOpts) => Promise<PageResult>) =>
  ({
    enabled: true,
    pageFlows: vi.fn(async (w: string, o: PageOpts) => {
      const r = await page(w, o);
      await o.onPage(r.flows);
      return {
        added: r.flows.length,
        complete: r.complete,
        hitKnownTop: r.hitKnownTop ?? false,
        newestSig: r.newestSig,
        oldestSig: r.oldestSig,
      };
    }),
  }) as unknown as EnhancedTxGateway & { pageFlows: ReturnType<typeof vi.fn> };

const row = (signature: string): WalletFlowRow => ({
  signature,
  timestamp: 1,
  type: 'SWAP',
  solFlow: 1,
  isTrading: true,
});

describe('WalletFlowIngest — cursor modes', () => {
  it('fresh backfill: no cursor → pages full history and records the boundaries', async () => {
    const { repo, cursor, upserted } = fakeRepo(null);
    const gw = gateway(async () => ({
      flows: [row('s1'), row('s2')],
      complete: true,
      newestSig: 's1',
      oldestSig: 's2',
    }));
    const res = await new WalletFlowIngest(gw, repo, noopLogger).ingest('w');

    expect(gw.pageFlows).toHaveBeenCalledWith('w', {
      untilSig: null,
      startBefore: null,
      onPage: expect.any(Function),
    });
    expect(upserted.map((f) => f.signature)).toEqual(['s1', 's2']);
    expect(cursor()).toEqual({ newestSig: 's1', oldestSig: 's2', complete: true });
    expect(res).toEqual({ added: 2, complete: true });
  });

  it('top-up that reaches the prior top (hitKnownTop) advances newest, keeping oldest', async () => {
    const { repo, cursor } = fakeRepo({
      newestSig: 'old-top',
      oldestSig: 'genesis',
      complete: true,
    });
    // Realistic caught-up top-up: it stopped at the known top (hitKnownTop), NOT at genesis.
    const gw = gateway(async () => ({
      flows: [row('new-top')],
      complete: false,
      hitKnownTop: true,
      newestSig: 'new-top',
      oldestSig: 'old-top',
    }));
    await new WalletFlowIngest(gw, repo, noopLogger).ingest('w');

    expect(gw.pageFlows).toHaveBeenCalledWith('w', {
      untilSig: 'old-top',
      startBefore: null,
      onPage: expect.any(Function),
    });
    // newest advances to the fresh top; oldest (genesis) is preserved, not clobbered by the top-up.
    expect(cursor()).toEqual({ newestSig: 'new-top', oldestSig: 'genesis', complete: true });
  });

  it('R01: a top-up that FAILS mid-page (no hitKnownTop) does NOT advance newest past the gap', async () => {
    const { repo, cursor } = fakeRepo({
      newestSig: 'old-top',
      oldestSig: 'genesis',
      complete: true,
    });
    // Page failure before reaching the prior top: ingested some new txs but a gap remains above 'old-top'.
    const gw = gateway(async () => ({
      flows: [row('new-top'), row('mid')],
      complete: false,
      hitKnownTop: false,
      newestSig: 'new-top',
      oldestSig: 'mid',
    }));
    await new WalletFlowIngest(gw, repo, noopLogger).ingest('w');

    // newest stays 'old-top' so the NEXT top-up re-pages new-top → old-top and closes the gap; advancing
    // to 'new-top' here would skip the un-ingested mid→old-top window forever (silent data loss).
    expect(cursor()).toEqual({ newestSig: 'old-top', oldestSig: 'genesis', complete: true });
  });

  it('resume: incomplete cursor → continues from oldestSig and keeps the recorded newest', async () => {
    const { repo, cursor } = fakeRepo({ newestSig: 'top', oldestSig: 'mid', complete: false });
    const gw = gateway(async () => ({
      flows: [row('older')],
      complete: true,
      newestSig: 'older', // pageFlows' newest from a resumed page is NOT the wallet's true top
      oldestSig: 'genesis',
    }));
    await new WalletFlowIngest(gw, repo, noopLogger).ingest('w');

    expect(gw.pageFlows).toHaveBeenCalledWith('w', {
      untilSig: null,
      startBefore: 'mid',
      onPage: expect.any(Function),
    });
    // newest stays 'top' (the true top recorded on the first page), oldest reaches genesis, now complete.
    expect(cursor()).toEqual({ newestSig: 'top', oldestSig: 'genesis', complete: true });
  });

  it('does nothing when the Enhanced API is disabled (no api key)', async () => {
    const { repo, upserted } = fakeRepo(null);
    const gw = { enabled: false, pageFlows: vi.fn() } as unknown as EnhancedTxGateway & {
      pageFlows: ReturnType<typeof vi.fn>;
    };
    const res = await new WalletFlowIngest(gw, repo, noopLogger).ingest('w');
    expect(gw.pageFlows).not.toHaveBeenCalled();
    expect(upserted).toEqual([]);
    expect(res).toEqual({ added: 0, complete: false });
  });
});
