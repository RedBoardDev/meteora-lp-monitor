import { PGlite } from '@electric-sql/pglite';
import { SOL_MINT } from '@binsight/shared';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedPoolMeta, ResidualSell, StoredLeg, SwapFlowRow, SwapSide } from '@/domain/dlmm';
import type { PriceGateway } from '@/domain/ports';
import type { Database } from '@/infrastructure/persistence/database';
import * as schema from '@/infrastructure/persistence/schema';
import { SwapFlowRepository } from '@/infrastructure/persistence/swap-flow-repository';
import {
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
const WALLET = 'W';

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

// Real SwapFlowRepository over an in-memory Postgres (PGlite) — NO network — so the engine exercises the
// REAL DB read path (byWallet ordering + side→buys/sells mapping + the cursor completeness gate), not a
// mocked source. This is the realized-PnL FIFO's only input source after Step 4.
async function newSwapRepo(): Promise<SwapFlowRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new SwapFlowRepository(db as unknown as Database);
}

let swapSeq = 0;
/** Map a fixture buy/sell (ResidualSell shape) to a persisted swap_flows row: solReceived = solAmount
 *  (SOL SPENT for a buy, SOL RECEIVED for a sell); unique signature satisfies the (wallet,sig,mint) PK. */
function toRows(side: SwapSide, flows: ResidualSell[]): SwapFlowRow[] {
  return flows.map((f) => ({
    wallet: WALLET,
    signature: `swap${String(swapSeq++).padStart(4, '0')}`,
    ts: f.ts,
    mint: f.mint,
    tokenAmount: f.tokenAmount,
    solAmount: f.solReceived,
    side,
  }));
}

async function seedSwaps(
  repo: SwapFlowRepository,
  opts: { buys: ResidualSell[]; sells: ResidualSell[]; complete?: boolean; noCursor?: boolean },
): Promise<void> {
  await repo.upsertMany([...toRows('buy', opts.buys), ...toRows('sell', opts.sells)]);
  if (!opts.noCursor) {
    // A seeded, completed cursor = the realized FIFO may read the persisted history as whole.
    await repo.setCursor(WALLET, {
      oldestSig: 'genesis',
      newestSig: 'top',
      complete: opts.complete ?? true,
    });
  }
}

async function makeEngine(opts: {
  legs: StoredLeg[];
  status: Map<string, { status: string; closedAt: number | null }>;
  buys: ResidualSell[];
  sells: ResidualSell[];
  prices?: Map<string, number>;
  complete?: boolean;
  noCursor?: boolean;
}): Promise<{ engine: RealizedPnlEngine; repo: SwapFlowRepository }> {
  const repo = await newSwapRepo();
  await seedSwaps(repo, opts);
  const legSource: RealizedLegSource = {
    legsByWallet: async () => opts.legs,
    getPoolMetas: async () => new Map([[POOL, POOL_META]]),
  };
  const posSource: RealizedPositionSource = {
    positionStatusForWallet: async () => opts.status,
  };
  const prices = {
    getPricesSol: async () => opts.prices ?? new Map<string, number>(),
    getSolUsd: async () => null,
  } as unknown as PriceGateway;
  // decimals 0 → human == raw, keeps the hand math exact. Batched fetch (one call for all mints).
  const engine = new RealizedPnlEngine(
    legSource,
    posSource,
    repo,
    prices,
    async (mints: string[]) => new Map<string, number>(mints.map((m) => [m, 0])),
    noopLogger,
  );
  return { engine, repo };
}

describe('RealizedPnlEngine — chained FIFO cost-basis (persisted swap_flows)', () => {
  it('routes the realized gain to the producing position across a deposit→withdraw→re-deposit→sell chain', async () => {
    // Timeline on mint M (all amounts human; decimals 0):
    //  buy 100 @0.1 SOL  → lot {100,0.1,null}
    //  P1 deposit 100, 10 SOL → solLeg -10, entryCost 10 (consumes the buy)
    //  P1 withdraw 100, 5 SOL → solLeg -5, exitCredit 10, lot {100,0.1,P1}
    //  P2 deposit 100, 5 SOL  → solLeg -5, entryCost 10 (consumes P1's withdrawn lot)
    //  P2 withdraw 100, 8 SOL → solLeg 3, exitCredit 10, lot {100,0.1,P2}
    //  sell 100 for 20 SOL    → gain 20 − 10 = 10 → realizedGain[P2]
    // PnL(P1) = -5 − 10 + 10 + 0 + 0 = -5 ; PnL(P2) = 3 − 10 + 10 + 10 + 0 = 13
    // Same fixtures as before, but buys/sells now come from the seeded swap_flows DB rows, not a fetch.
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
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
    });

    const out = await engine.computeForWallet(WALLET);
    expect(out).not.toBeNull();
    expect(out!.get('P1')).toBeCloseTo(-5, 9);
    expect(out!.get('P2')).toBeCloseTo(13, 9);
    // Wallet conservation: Σ PnL = Σ solLeg + (Σ sells − Σ buys) when nothing is still held.
    expect((out!.get('P1') ?? 0) + (out!.get('P2') ?? 0)).toBeCloseTo(-2 + (20 - 10), 9);
  });

  it('marks a FRESH still-held residual at the CLOSE-bin price, NOT the current market price (died-token regression)', async () => {
    // WHY (regression): a token that DIED after close has a current price ~0. The OLD code marked the held
    // residual at min(currentPrice, close-bin) → ~0 → a spurious full -deposit loss (SOLANGELES showed -13
    // where LPAgent shows 0.00). Mark-to-market-AT-CLOSE (LPAgent's model) uses the CLOSE-bin price and
    // ignores the current price entirely; the later residual sells are wallet-level trading, not this close.
    // P2 locks bought tokens (no SOL side), withdraws them, never sells → a still-held bag. The buy cost
    // and the withdraw credit cancel WITHIN P2 (basis-neutral); only the held mark remains.
    //  buy 100 @0.1 → lot{100,0.1,null}; P2 deposit 100,0 → entryCost 10; P2 withdraw 100,0 → exitCredit 10, held lot{100,0.1,P2}
    // bin price = 1, solSide Y, decimals 0 → close-bin mark = (1 × 10^0)/1e9 = 1e-9 SOL/token.
    // current price = 1e-10 (token DIED, BELOW the bin): OLD min(1e-10,1e-9)=1e-10 → held 1e-8 → PnL 1e-8.
    //   NEW: ignore current, mark at the close-bin 1e-9 → held = 100 × 1e-9 = 1e-7 → PnL(P2) = 0−10+10+1e-7 = 1e-7.
    const legs = [leg('P2', 'deposit', 100, 0, 1000), leg('P2', 'withdraw', 100, 0, 2000)];
    const status = new Map([
      ['P2', { status: 'closed', closedAt: Date.now() - 1000 }], // fresh (<7d) → close-bin mark, no current price
    ]);
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [],
      prices: new Map([[MINT, 1e-10]]), // token died: current << close-bin → MUST be ignored for the mark
    });

    const out = await engine.computeForWallet(WALLET);
    expect(out).not.toBeNull();
    expect(out!.size).toBe(1);
    expect(out!.get('P2')).toBeCloseTo(1e-7, 12); // close-bin mark (1e-9), NOT the current 1e-10
  });

  it('returns null (skip persist) when the swap_flow cursor is incomplete (seed unfinished)', async () => {
    // A still-seeding wallet has a cursor with complete=false → the persisted swap history is partial.
    // The engine must NOT hand back values to persist — an under-consumed FIFO would leave too much "held"
    // residual and overwrite good market_pnl_sol with inflated values. Same protection the old
    // incomplete-Enhanced-fetch guard gave, now driven by the cursor.
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 5, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
      complete: false, // seed unfinished → skip signal
    });

    expect(await engine.computeForWallet(WALLET)).toBeNull();
  });

  it('returns null (skip persist) when the wallet has no swap_flow cursor yet (never seeded)', async () => {
    // No cursor at all = the swap seed has not started (e.g. Enhanced API disabled, or a brand-new
    // wallet). The persisted history is necessarily partial → skip persist, never inflate.
    const legs = [leg('P1', 'deposit', 100, 10, 1000), leg('P1', 'withdraw', 100, 5, 2000)];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
      noCursor: true,
    });

    expect(await engine.computeForWallet(WALLET)).toBeNull();
  });

  it('returns an empty map (not null) when the wallet has no DLMM legs (callers untouched)', async () => {
    // Distinct from the null guard: no legs at all → nothing to compute, return an EMPTY map (not null)
    // so callers leave existing values untouched without treating it as a skip-on-incomplete-history.
    // The no-legs short-circuit fires BEFORE the cursor read, so a missing cursor is irrelevant here.
    const { engine } = await makeEngine({
      legs: [],
      status: new Map(),
      buys: [],
      sells: [],
      noCursor: true,
    });
    const out = await engine.computeForWallet(WALLET);
    expect(out).not.toBeNull();
    expect(out!.size).toBe(0);
  });

  it('sources buys/sells exclusively from the persisted swap_flows repo (no Enhanced API in the realized path)', async () => {
    // Proves the realized engine reads its FIFO inputs from the DB: getCursor (completeness) + byWallet
    // (the rows) are the ONLY input source. The constructor no longer accepts an EnhancedTxGateway, so
    // there is no fetch to make — this asserts the DB read actually happens and feeds the result.
    const legs = [
      leg('P1', 'deposit', 100, 10, 1000),
      leg('P1', 'withdraw', 100, 5, 2000),
    ];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine, repo } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [{ ts: 5000, mint: MINT, tokenAmount: 100, solReceived: 20 }],
    });
    const getCursorSpy = vi.spyOn(repo, 'getCursor');
    const byWalletSpy = vi.spyOn(repo, 'byWallet');

    const out = await engine.computeForWallet(WALLET);

    expect(getCursorSpy).toHaveBeenCalledWith(WALLET);
    expect(byWalletSpy).toHaveBeenCalledWith(WALLET);
    // Single position: solLeg(-5) − entryCost(10) + exitCredit(10) + realizedGain(20−10) = +5. The
    // persisted buy (cost basis) AND sell (proceeds) both came from swap_flows, so a non-trivial value
    // proves the DB rows actually drove the FIFO result (not an empty/mocked source).
    expect(out!.get('P1')).toBeCloseTo(5, 9);
  });

  it('recomputes from the persisted swaps + a freshly-ingested delta, not a re-fetch (a late sell converges)', async () => {
    // A position closes holding its residual; the close-time pass runs BEFORE the dump is persisted, so it
    // marks the residual as held (≈0). Once the residual sell is INGESTED into swap_flows (the delta that
    // SwapFlowIngest persists), a re-read of the SAME table must pick it up and converge to the realized
    // value — no full re-page, just the persisted delta. WHY: this is what makes a restart/close ~0-credit.
    const legs = [
      leg('P1', 'deposit', 100, 10, 1000),
      leg('P1', 'withdraw', 100, 5, 2000),
    ];
    const status = new Map([['P1', { status: 'closed', closedAt: 2000_000 }]]);
    const { engine, repo } = await makeEngine({
      legs,
      status,
      buys: [{ ts: 500, mint: MINT, tokenAmount: 100, solReceived: 10 }],
      sells: [], // residual not yet sold/indexed at close time
    });

    // 1) Cold pass — residual still held (≈0 mark), no realized sale yet.
    const first = await engine.computeForWallet(WALLET);
    expect(first!.get('P1')).toBeCloseTo(-5, 4);

    // 2) The dump lands and SwapFlowIngest persists it (the delta) — a re-read converges to -7.
    await repo.upsertMany(toRows('sell', [{ ts: 2100, mint: MINT, tokenAmount: 100, solReceived: 8 }]));
    const second = await engine.computeForWallet(WALLET);
    expect(second!.get('P1')).toBeCloseTo(-7, 4);
  });
});
