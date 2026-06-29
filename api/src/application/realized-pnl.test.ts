import { SOL_MINT } from '@binsight/shared';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import type { LoadedPoolMeta, ResidualSell, StoredLeg } from '@/domain/dlmm';
import type { EnhancedTxGateway, PriceGateway } from '@/domain/ports';
import {
  mergeFlows,
  type RealizedLegSource,
  RealizedPnlEngine,
  type RealizedPositionSource,
} from './realized-pnl';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const MINT = 'MintMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM';
const POOL = 'PoolPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
const LAMPORTS = 1e9;

// solSide = 'Y' → mintX = the token, mintY = SOL → a leg's amountX is raw token, amountY is lamports.
const POOL_META: LoadedPoolMeta = { binStep: 1, solSide: 'Y', mintX: MINT, mintY: SOL_MINT };

let seq = 0;
/** A token-side DLMM leg (decimals=0 → raw amount = human amount). */
function leg(
  position: string,
  kind: StoredLeg['kind'],
  tokenQty: number,
  sol: number,
  blockTime: number,
): StoredLeg {
  return {
    signature: `sig${String(seq++).padStart(4, '0')}`,
    position,
    lbPair: POOL,
    kind,
    activeBinId: 0, // bin price = 1 → SOL per raw token = 1 (×10^0 / 1e9 = 1e-9 SOL/token at decimals 0)
    amountX: BigInt(tokenQty),
    amountY: BigInt(Math.round(sol * LAMPORTS)),
    blockTime,
  };
}

function makeEngine(opts: {
  legs: StoredLeg[];
  status: Map<string, { status: string; closedAt: number | null }>;
  buys: ResidualSell[];
  sells: ResidualSell[];
  prices?: Map<string, number>;
  buysComplete?: boolean;
  sellsComplete?: boolean;
}): RealizedPnlEngine {
  const legSource: RealizedLegSource = {
    legsByWallet: async () => opts.legs,
    getPoolMetas: async () => new Map([[POOL, POOL_META]]),
  };
  const posSource: RealizedPositionSource = {
    positionStatusForWallet: async () => opts.status,
  };
  const enhanced = {
    enabled: true,
    fetchBuys: async () => ({ buys: opts.buys, complete: opts.buysComplete ?? true, oldestTs: 0 }),
    fetchSells: async () => ({
      sells: opts.sells,
      complete: opts.sellsComplete ?? true,
      oldestTs: 0,
    }),
  } as unknown as EnhancedTxGateway;
  const prices = {
    getPricesSol: async () => opts.prices ?? new Map<string, number>(),
    getSolUsd: async () => null,
  } as unknown as PriceGateway;
  // decimals 0 → human == raw, keeps the hand math exact.
  return new RealizedPnlEngine(legSource, posSource, enhanced, prices, async () => 0, noopLogger);
}

describe('RealizedPnlEngine — chained FIFO cost-basis', () => {
  it('routes the realized gain to the producing position across a deposit→withdraw→re-deposit→sell chain', async () => {
    // Timeline on mint M (all amounts human; decimals 0):
    //  buy 100 @0.1 SOL  → lot {100,0.1,null}
    //  P1 deposit 100, 10 SOL → solLeg -10, entryCost 10 (consumes the buy)
    //  P1 withdraw 100, 5 SOL → solLeg -5, exitCredit 10, lot {100,0.1,P1}
    //  P2 deposit 100, 5 SOL  → solLeg -5, entryCost 10 (consumes P1's withdrawn lot)
    //  P2 withdraw 100, 8 SOL → solLeg 3, exitCredit 10, lot {100,0.1,P2}
    //  sell 100 for 20 SOL    → gain 20 − 10 = 10 → realizedGain[P2]
    // PnL(P1) = -5 − 10 + 10 + 0 + 0 = -5 ; PnL(P2) = 3 − 10 + 10 + 10 + 0 = 13
    const legs = [
      leg('P1', 'deposit', 100, 10, 1000),
      leg('P1', 'withdraw', 100, 5, 2000),
      leg('P2', 'deposit', 100, 5, 3000),
      leg('P2', 'withdraw', 100, 8, 4000),
    ];
    const status = new Map([
      ['P1', { status: 'closed', closedAt: 2000_000 }],
      ['P2', { status: 'closed', closedAt: 4000_000 }],
    ]);
    const engine = makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
    });

    const out = await engine.computeForWallet('W');
    expect(out).not.toBeNull();
    expect(out!.get('P1')).toBeCloseTo(-5, 9);
    expect(out!.get('P2')).toBeCloseTo(13, 9);
    // Wallet conservation: Σ PnL = Σ solLeg + (Σ sells − Σ buys) when nothing is still held.
    expect((out!.get('P1') ?? 0) + (out!.get('P2') ?? 0)).toBeCloseTo(-2 + (20 - 10), 9);
  });

  it('marks a still-held residual at min(current price, close-bin) and only reports closed positions', async () => {
    // P2 locks bought tokens (no SOL side), withdraws them, never sells → a still-held bag. The buy cost
    // and the withdraw credit cancel WITHIN P2 (it was basis-neutral); only the held mark remains.
    //  buy 100 @0.1 → lot{100,0.1,null}
    //  P2 deposit 100, 0 SOL → solLeg 0, entryCost 10 (consumes the buy lot)
    //  P2 withdraw 100, 0 SOL → solLeg 0, exitCredit 10, lot{100,0.1,P2}  (held)
    // bin price = 1, solSide Y, decimals 0 → bin mark per token = (1 × 10^0)/1e9 = 1e-9 SOL.
    // current price (gateway) = 5e-9 SOL → min(5e-9, 1e-9) = 1e-9 → heldValue = 100 × 1e-9 = 1e-7.
    // PnL(P2) = 0 − 10 + 10 + 0 + 1e-7 = 1e-7
    const legs = [leg('P2', 'deposit', 100, 0, 1000), leg('P2', 'withdraw', 100, 0, 2000)];
    const status = new Map([
      ['P2', { status: 'closed', closedAt: Date.now() - 1000 }], // fresh (<7d) → current-price branch
    ]);
    const engine = makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [],
      prices: new Map([[MINT, 5e-9]]), // above the bin → capped at the bin mark
    });

    const out = await engine.computeForWallet('W');
    expect(out).not.toBeNull();
    expect(out!.size).toBe(1);
    expect(out!.get('P2')).toBeCloseTo(1e-7, 12);
  });

  it('returns null (skip persist) when the sell history is incomplete', async () => {
    // A flaky Helius fetch returns complete=false. The engine must NOT hand back values to persist —
    // returning them would overwrite good market_pnl_sol with inflated, under-consumed held residuals.
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 5, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const engine = makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
      sellsComplete: false, // incomplete history → skip signal
    });

    expect(await engine.computeForWallet('W')).toBeNull();
  });

  it('returns an empty map when the Enhanced API is disabled', async () => {
    const legSource: RealizedLegSource = {
      legsByWallet: async () => [leg('P1', 'deposit', 100, 10, 1000)],
      getPoolMetas: async () => new Map([[POOL, POOL_META]]),
    };
    const posSource: RealizedPositionSource = {
      positionStatusForWallet: async () => new Map(),
    };
    const enhanced = { enabled: false } as unknown as EnhancedTxGateway;
    const prices = {
      getPricesSol: async () => new Map(),
      getSolUsd: async () => null,
    } as unknown as PriceGateway;
    const engine = new RealizedPnlEngine(
      legSource,
      posSource,
      enhanced,
      prices,
      async () => 0,
      noopLogger,
    );
    const out = await engine.computeForWallet('W');
    expect(out).not.toBeNull();
    expect(out!.size).toBe(0);
  });
});

describe('mergeFlows', () => {
  const s = (ts: number, tok = 1, sol = 1): ResidualSell => ({
    ts,
    mint: MINT,
    tokenAmount: tok,
    solReceived: sol,
  });

  it('appends only rows not already present (dedup by value key)', () => {
    // WHY: an incremental refetch overlaps the cached window to avoid gaps, so the same swap reappears —
    // it must not be double-counted (that would inflate realized proceeds).
    const base = [s(100), s(200)];
    const merged = mergeFlows(base, [s(200) /* dup */, s(300) /* new */]);
    expect(merged.map((f) => f.ts).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('returns the base array untouched when the delta is empty (no-op refresh)', () => {
    const base = [s(100)];
    expect(mergeFlows(base, [])).toBe(base);
  });

  it('treats same-ts/mint swaps of different size as distinct (not a dup)', () => {
    const merged = mergeFlows([s(100, 5, 1)], [s(100, 7, 1)]);
    expect(merged).toHaveLength(2);
  });
});

describe('RealizedPnlEngine — incremental refresh', () => {
  it('re-pages only the delta and merges the late residual sell (same FIFO result)', async () => {
    // A position closes holding its residual; the close-time (full) pass runs BEFORE the dump is indexed,
    // so it marks the residual as held (~0 here). An incremental refresh must page only the NEWER window
    // and pick up the now-visible sell — converging to the realized value WITHOUT re-paging all history.
    const T = 1_700_000_000; // realistic unix seconds so the delta window is meaningfully narrower
    const legs = [
      leg('P1', 'deposit', 100, 10, T + 1000),
      leg('P1', 'withdraw', 100, 5, T + 2000),
    ];
    const status = new Map([['P1', { status: 'closed', closedAt: (T + 2000) * 1000 }]]);
    const buys: ResidualSell[] = [{ ts: T, mint: MINT, tokenAmount: 100, solReceived: 10 }];
    let sellsNow: ResidualSell[] = []; // residual not yet sold/indexed at close time
    const sellSince: number[] = [];
    const enhanced = {
      enabled: true,
      fetchBuys: async () => ({ buys, complete: true, oldestTs: 0 }),
      fetchSells: async (_w: string, sinceMs: number) => {
        sellSince.push(sinceMs);
        return { sells: sellsNow, complete: true, oldestTs: 0 };
      },
    } as unknown as EnhancedTxGateway;
    const legSource: RealizedLegSource = {
      legsByWallet: async () => legs,
      getPoolMetas: async () => new Map([[POOL, POOL_META]]),
    };
    const posSource: RealizedPositionSource = { positionStatusForWallet: async () => status };
    const prices = {
      getPricesSol: async () => new Map<string, number>(),
      getSolUsd: async () => null,
    } as unknown as PriceGateway;
    const engine = new RealizedPnlEngine(legSource, posSource, enhanced, prices, async () => 0, noopLogger);

    // 1) Cold full pass — residual still held (≈0 mark), no realized sale yet.
    const first = await engine.computeForWallet('W');
    expect(first!.get('P1')).toBeCloseTo(-5, 4);

    // 2) The dump lands; an INCREMENTAL refresh must converge to the realized value (-7).
    sellsNow = [{ ts: T + 2100, mint: MINT, tokenAmount: 100, solReceived: 8 }];
    const second = await engine.computeForWallet('W', { incremental: true });
    expect(second!.get('P1')).toBeCloseTo(-7, 4);

    // And it paged a NEWER (narrower) window than the cold full fetch — i.e. only the delta.
    expect(sellSince).toHaveLength(2);
    expect(sellSince[1]).toBeGreaterThan(sellSince[0]!);
  });
});
