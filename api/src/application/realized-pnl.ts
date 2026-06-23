import { SOL_MINT } from '@binsight/shared';
import type { Logger } from 'pino';
import type { LoadedPoolMeta, ResidualSell } from '@/domain/dlmm';
import { binPriceRaw, LAMPORTS_PER_SOL } from '@/domain/dlmm-pnl';
import type {
  EnhancedTxGateway,
  LegRepository,
  PositionRepository,
  PriceGateway,
} from '@/domain/ports';

/**
 * Per-position realized PnL via a CHAINED FIFO COST-BASIS engine — 100% on-chain (no Meteora datapi).
 * This is the authoritative `market_pnl_sol` writer for CLOSED positions and the production port of the
 * proven `scripts/fifo-cost-basis.ts` (its `--held current` path): the FIFO math is IDENTICAL, only the
 * I/O is routed through the application ports (leg repository, Helius Enhanced buys/sells, the shared
 * price gateway for the held-residual current mark) instead of raw SQL + DexScreener.
 *
 * MODEL (per non-SOL mint M, a global FIFO inventory of lots {qty, costPerUnit, origin}):
 *   Merge ALL events of M chronologically — buys (SOL→M), sells (M→SOL), and the wallet's DLMM legs
 *   (deposit/withdraw/claim) across every position on a SOL-paired pool with M on the non-SOL side.
 *     • buy      → push {qty, cost = SOL spent / qty, origin: null}            (real acquisition)
 *     • claim P  → push {qty, cost: 0, origin: P}; solLeg[P] += claimSol        (fee tokens, free)
 *     • withdraw → push {qty, cost: P's avg deposit cost, origin: P};           (tokens return to wallet
 *                  solLeg[P] += wSol; exitCredit[P] += qty*avg                    carrying their basis)
 *     • deposit  → consume FIFO qty → entryCost[P] += consumedCost;             (P pays the cost basis
 *                  solLeg[P] -= dSol; track P's running inQty/inCost for avg      of tokens it locks up)
 *     • sell     → consume FIFO qty → gain = proceedsShare − consumedCost,      (market gain routed to
 *                  routed to the consumed lot's origin position (or trading)      the producing position)
 *   Leftover inventory at the end = held residual, marked at min(current price, close-bin) for a fresh
 *   bag (<7d) or min(local realized price near close, close-bin) for an aged one.
 *
 *   PnL(P) = solLeg[P] − entryCost[P] + exitCredit[P] + realizedGain[P] + heldValue[P]
 */

const EPS = 1e-9;
const DAY_MS = 86_400_000;
const CAP_WINDOW_SEC = 7 * 86_400;

/** One event on a mint's timeline, all token quantities in HUMAN (decimal-adjusted) units. */
interface Ev {
  ts: number; // seconds
  order: number; // tiebreak within equal ts: inflows before outflows
  kind: 'buy' | 'sell' | 'deposit' | 'withdraw' | 'claim';
  qty: number; // human token amount (>=0)
  sol: number; // SOL: spent (buy/deposit), received (sell/withdraw/claim)
  pos: string | null;
}

interface Lot {
  qty: number;
  costPerUnit: number; // SOL per human token unit
  origin: string | null; // position address, or null = bought (pure trading origin)
}

/** Per-position accumulators built by the FIFO walk. */
interface Acc {
  solLeg: number;
  entryCost: number;
  exitCredit: number;
  realizedGain: number;
  heldValue: number;
  inQty: number; // cumulative deposited token (human) — defines the avg deposit cost
  inCost: number; // cumulative SOL cost basis of deposited tokens
}

function newAcc(): Acc {
  return {
    solLeg: 0,
    entryCost: 0,
    exitCredit: 0,
    realizedGain: 0,
    heldValue: 0,
    inQty: 0,
    inCost: 0,
  };
}

/** Per-position static meta (mint, close-bin price inputs, closedAt) for held valuation + reporting. */
interface PosMeta {
  mint: string;
  solIsY: boolean;
  status: string;
  closedAt: number | null;
  lastBinId: number;
  lastBlockTime: number | null;
  binStep: number;
}

// Inflows must be in inventory before a same-ts deposit/sell consumes them.
const KIND_ORDER: Record<Ev['kind'], number> = {
  buy: 0,
  claim: 1,
  withdraw: 2,
  deposit: 3,
  sell: 4,
};

/** The leg repository surface this engine needs (narrowed for testability). */
export type RealizedLegSource = Pick<LegRepository, 'legsByWallet' | 'getPoolMetas'>;
/** The position repository surface this engine needs (status + closedAt of every position). */
export type RealizedPositionSource = Pick<PositionRepository, 'positionStatusForWallet'>;

/**
 * Computes the chained-FIFO realized PnL of a wallet's CLOSED positions, fully on-chain. All inputs come
 * through ports; the only injected primitive is `decimalsOf` (token decimals by mint, cached upstream).
 */
export class RealizedPnlEngine {
  constructor(
    private readonly legs: RealizedLegSource,
    private readonly positions: RealizedPositionSource,
    private readonly enhanced: EnhancedTxGateway,
    private readonly prices: PriceGateway,
    private readonly decimalsOf: (mint: string) => Promise<number>,
    private readonly logger: Logger,
  ) {}

  /**
   * Realized `market_pnl_sol` per CLOSED position of `wallet` (open positions feed the inventory but are
   * not reported). Empty map when the Enhanced API is disabled (no api-key) or the wallet has no legs on
   * a SOL-paired pool — callers leave existing values untouched in that case. Returns `null` when the
   * buy/sell history came back INCOMPLETE (a Helius page kept failing, or the maxPages cap was hit): an
   * incomplete buy OR sell history makes FIFO under-consume inventory → too much leftover "held" →
   * inflation, so the engine must NOT hand back values to persist (it would overwrite good data with
   * inflated ones). Both legs matter: missing buys lose cost basis, missing sells leave residual unsold.
   */
  async computeForWallet(wallet: string): Promise<Map<string, number> | null> {
    const out = new Map<string, number>();
    if (!this.enhanced.enabled) {
      this.logger.warn({ wallet }, 'realized-pnl: skipped (no Helius api-key for Enhanced API)');
      return out;
    }

    // 1. ALL legs for the wallet + their pool meta. Only SOL-paired pools (sol_side != null) — non-SOL
    //    pools' SOL economics are ~flat and a two-token FIFO is out of scope (mirrors the script's join
    //    `where dp.sol_side is not null`).
    const allLegs = await this.legs.legsByWallet(wallet);
    if (allLegs.length === 0) {
      this.logger.warn({ wallet }, 'realized-pnl: no DLMM legs for this wallet');
      return out;
    }
    const poolMetas = await this.legs.getPoolMetas([...new Set(allLegs.map((l) => l.lbPair))]);
    const legRows = allLegs.filter((l) => {
      const m = poolMetas.get(l.lbPair);
      return m != null && m.solSide != null;
    });
    if (legRows.length === 0) {
      this.logger.warn({ wallet }, 'realized-pnl: no legs on SOL-paired pools for this wallet');
      return out;
    }
    // Time-order (block_time asc, signature as a stable secondary key) — the script orders by
    // block_time then leg id; signature is the closest stable per-leg surrogate available off-chain.
    legRows.sort(
      (a, b) =>
        (a.blockTime ?? Number.POSITIVE_INFINITY) - (b.blockTime ?? Number.POSITIVE_INFINITY) ||
        a.signature.localeCompare(b.signature),
    );

    // Per-position status + closedAt (open positions matter for inventory; only closed are reported).
    const statusByPos = await this.positions.positionStatusForWallet(wallet);

    // 2. Per-position static meta + the set of non-SOL mints this wallet LP'd.
    const posMeta = new Map<string, PosMeta>();
    const mints = new Set<string>();
    for (const l of legRows) {
      const pm = poolMetas.get(l.lbPair) as LoadedPoolMeta; // filtered to solSide != null above
      const solIsY = pm.mintY === SOL_MINT;
      const mint = solIsY ? pm.mintX : pm.mintY;
      mints.add(mint);
      const st = statusByPos.get(l.position);
      const existing = posMeta.get(l.position);
      if (!existing) {
        posMeta.set(l.position, {
          mint,
          solIsY,
          status: st?.status ?? 'open',
          closedAt: st?.closedAt ?? null,
          lastBinId: l.activeBinId,
          lastBlockTime: l.blockTime,
          binStep: pm.binStep,
        });
      } else {
        existing.lastBinId = l.activeBinId; // rows are time-ordered → last seen = close-time bin
        existing.lastBlockTime = l.blockTime;
      }
    }

    // 3. Token decimals (decimalsOf is cached upstream).
    const decMap = new Map<string, number>();
    for (const mint of mints) decMap.set(mint, await this.decimalsOf(mint));
    const dec = (mint: string) => decMap.get(mint) ?? 9;

    // 4. Buys + sells from the wallet's earliest leg minus a day.
    // O(n) reduce, NOT Math.min(...spread): at ~15k closed × ≥2 legs the spread crosses V8's argument
    // ceiling (~124k) and throws RangeError, rejecting the whole pass for the heaviest wallets.
    const oldestLegSec = legRows.reduce(
      (m, l) => Math.min(m, l.blockTime ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );
    const sinceMs = (Number.isFinite(oldestLegSec) ? oldestLegSec : 0) * 1000 - DAY_MS;
    const [{ buys, complete: buysComplete }, { sells, complete: sellsComplete }] =
      await Promise.all([
        this.enhanced.fetchBuys(wallet, sinceMs),
        this.enhanced.fetchSells(wallet, sinceMs),
      ]);
    this.logger.info(
      {
        wallet,
        legs: legRows.length,
        positions: posMeta.size,
        mints: mints.size,
        buys: buys.length,
        sells: sells.length,
        buysComplete,
        sellsComplete,
      },
      'realized-pnl: data loaded',
    );

    // Completeness guard: an incomplete buy/sell history makes the FIFO under-consume inventory, leaving
    // too much "held" residual that then gets valued and inflates closed PnL. Returning these to the
    // caller would PERSIST inflated values over good ones — so skip the whole pass instead.
    if (!buysComplete || !sellsComplete) {
      this.logger.warn(
        { wallet, buysComplete, sellsComplete },
        'realized-pnl: incomplete buy/sell history — skipping persist to avoid overwriting with inflated held values',
      );
      return null;
    }

    // 5. Build per-mint event timelines.
    const evByMint = new Map<string, Ev[]>();
    const push = (mint: string, e: Ev) => {
      const a = evByMint.get(mint) ?? [];
      a.push(e);
      evByMint.set(mint, a);
    };
    for (const l of legRows) {
      const m = posMeta.get(l.position);
      if (!m) continue;
      if (l.kind !== 'deposit' && l.kind !== 'withdraw' && l.kind !== 'claim') continue;
      const tokRaw = Number(m.solIsY ? l.amountX : l.amountY);
      const solLamports = Number(m.solIsY ? l.amountY : l.amountX);
      const qty = tokRaw / 10 ** dec(m.mint);
      const solAmt = solLamports / LAMPORTS_PER_SOL;
      const ts = l.blockTime ?? 0;
      push(m.mint, {
        ts,
        order: KIND_ORDER[l.kind],
        kind: l.kind,
        qty,
        sol: solAmt,
        pos: l.position,
      });
    }
    for (const b of buys) {
      if (b.tokenAmount <= 0 || b.solReceived <= 0) continue;
      if (!evByMint.has(b.mint)) continue; // only mints this wallet LP'd — ignore unrelated trading
      push(b.mint, {
        ts: b.ts,
        order: KIND_ORDER.buy,
        kind: 'buy',
        qty: b.tokenAmount,
        sol: b.solReceived,
        pos: null,
      });
    }
    for (const s of sells) {
      if (s.tokenAmount <= 0 || s.solReceived <= 0) continue;
      if (!evByMint.has(s.mint)) continue;
      push(s.mint, {
        ts: s.ts,
        order: KIND_ORDER.sell,
        kind: 'sell',
        qty: s.tokenAmount,
        sol: s.solReceived,
        pos: null,
      });
    }

    // 6. FIFO walk per mint.
    const acc = new Map<string, Acc>();
    const accOf = (pos: string) => {
      let a = acc.get(pos);
      if (!a) {
        a = newAcc();
        acc.set(pos, a);
      }
      return a;
    };
    let tradingPnL = 0;
    const leftoverByMint = new Map<string, Lot[]>();

    for (const [mint, evs] of evByMint) {
      evs.sort((a, b) => a.ts - b.ts || a.order - b.order);
      const inv: Lot[] = [];

      const consume = (need: number) => {
        let remaining = need;
        let cost = 0;
        let taken = 0;
        const perLot: { lot: Lot; take: number }[] = [];
        while (remaining > EPS && inv.length > 0) {
          const lot = inv[0]!;
          const take = Math.min(remaining, lot.qty);
          cost += take * lot.costPerUnit;
          taken += take;
          perLot.push({ lot, take });
          lot.qty -= take;
          remaining -= take;
          if (lot.qty <= EPS) inv.shift();
        }
        return { cost, taken, perLot, shortfall: remaining };
      };

      for (const e of evs) {
        if (e.kind === 'buy') {
          inv.push({ qty: e.qty, costPerUnit: e.sol / e.qty, origin: null });
        } else if (e.kind === 'claim') {
          const a = accOf(e.pos!);
          a.solLeg += e.sol;
          if (e.qty > EPS) inv.push({ qty: e.qty, costPerUnit: 0, origin: e.pos });
        } else if (e.kind === 'withdraw') {
          const a = accOf(e.pos!);
          a.solLeg += e.sol;
          if (e.qty > EPS) {
            const avg = a.inQty > EPS ? a.inCost / a.inQty : 0;
            inv.push({ qty: e.qty, costPerUnit: avg, origin: e.pos });
            a.exitCredit += e.qty * avg;
          }
        } else if (e.kind === 'deposit') {
          const a = accOf(e.pos!);
          a.solLeg -= e.sol;
          if (e.qty > EPS) {
            const { cost, taken } = consume(e.qty);
            a.entryCost += cost;
            a.inQty += taken; // only the part actually backed by inventory carries a basis
            a.inCost += cost;
          }
        } else {
          // sell: realize SOL against FIFO lots, route gain to each consumed lot's origin position.
          const { taken, perLot, shortfall } = consume(e.qty);
          if (taken > EPS) {
            const proceeds = e.sol * (taken / (taken + shortfall)); // proceeds for the backed part
            for (const { lot, take } of perLot) {
              const share = proceeds * (take / taken);
              const gain = share - take * lot.costPerUnit;
              if (lot.origin) accOf(lot.origin).realizedGain += gain;
              else tradingPnL += gain;
            }
          }
        }
      }
      if (inv.length > 0) leftoverByMint.set(mint, inv);
    }

    // 7. Held residual: value leftover inventory per origin position.
    //    • FRESH bag (<7d closed): min(current market price, close-bin) — fixes stale-bin overstatement.
    //    • AGED bag (>7d): min(local realized price near close, close-bin) — robust to since-died tokens.
    const sellsByMint = new Map<string, ResidualSell[]>();
    for (const s of sells) {
      if (s.tokenAmount > 0 && s.solReceived > 0) {
        const a = sellsByMint.get(s.mint) ?? [];
        a.push(s);
        sellsByMint.set(s.mint, a);
      }
    }
    for (const a of sellsByMint.values()) a.sort((x, y) => x.ts - y.ts);
    const priceNearClose = (mint: string, closeAtMs: number): number => {
      const a = sellsByMint.get(mint);
      if (!a) return 0;
      const c = closeAtMs / 1000;
      let sol = 0;
      let tok = 0;
      for (const s of a) {
        if (Math.abs(s.ts - c) <= CAP_WINDOW_SEC) {
          sol += s.solReceived;
          tok += s.tokenAmount;
        }
      }
      return tok > 0 ? sol / tok : 0;
    };
    const binMarkPerToken = (m: PosMeta): number => {
      const price = binPriceRaw(m.lastBinId, m.binStep);
      const lamportsPerRaw = m.solIsY ? price : 1 / price;
      // raw→human cancels: (lamports/raw)*(10^dec) / 1e9 per human unit
      return (lamportsPerRaw * 10 ** dec(m.mint)) / LAMPORTS_PER_SOL;
    };

    // Current market price (SOL per human token) of the held bags, via the shared price gateway (Jupiter).
    const heldMints = [
      ...new Set(
        [...leftoverByMint]
          .filter(([, lots]) => lots.some((l) => l.origin && l.qty > EPS))
          .map(([mint]) => mint),
      ),
    ];
    const curPrices =
      heldMints.length > 0 ? await this.prices.getPricesSol(heldMints) : new Map<string, number>();
    this.logger.info(
      {
        wallet,
        heldMints: heldMints.length,
        priced: [...curPrices.values()].filter((v) => v > 0).length,
      },
      'realized-pnl: current prices fetched',
    );

    const now = Date.now();
    for (const [mint, lots] of leftoverByMint) {
      for (const lot of lots) {
        if (!lot.origin || lot.qty <= EPS) continue;
        const m = posMeta.get(lot.origin);
        if (!m) continue;
        const binTok = Math.max(0, binMarkPerToken(m));
        const aged = m.closedAt != null && now - m.closedAt > CAP_WINDOW_SEC * 1000;
        let markPerTok: number;
        if (aged) {
          const localP = priceNearClose(mint, m.closedAt ?? now);
          markPerTok = Math.max(0, Math.min(localP, binTok));
        } else {
          const cp = curPrices.get(mint);
          markPerTok = cp != null ? Math.min(cp, binTok) : binTok;
        }
        accOf(lot.origin).heldValue += lot.qty * markPerTok;
      }
    }

    // 8. PnL per CLOSED position (open positions stay un-priced in the view).
    for (const [pos, m] of posMeta) {
      if (m.status !== 'closed') continue;
      const a = acc.get(pos) ?? newAcc();
      out.set(pos, a.solLeg - a.entryCost + a.exitCredit + a.realizedGain + a.heldValue);
    }
    this.logger.info(
      { wallet, closed: out.size, tradingPnL: Number(tradingPnL.toFixed(4)) },
      'realized-pnl: computed',
    );
    return out;
  }
}
