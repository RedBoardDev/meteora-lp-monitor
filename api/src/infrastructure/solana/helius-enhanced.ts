import { DLMM_PROGRAM_ID, SOL_MINT } from '@binsight/shared';
import type { Logger } from 'pino';
import { classifyTradingByType, type WalletTxFlow } from '@/domain/cashflow';
import type { ResidualSell, WalletFlowRow } from '@/domain/dlmm';
import type { EnhancedTxGateway } from '@/domain/ports';
import { TokenBucket } from '@/util/cache';

export interface EnhancedTx {
  timestamp: number;
  signature: string;
  type: string;
  tokenTransfers?: {
    mint: string;
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
  }[];
  nativeTransfers?: { fromUserAccount: string; toUserAccount: string; amount: number }[];
  accountData?: {
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges?: {
      userAccount: string;
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
    }[];
  }[];
  instructions?: { programId: string; innerInstructions?: { programId: string }[] }[];
}

/** Purely on-chain reconstruction of a closed position's SOL legs + net residual, from its txs. */
export interface PositionFlow {
  /** wallet's net SOL across the position's txs (deposits −, SOL-side withdrawals + fees + rent +). */
  solLegSol: number;
  /** NET non-SOL token the wallet took out of the position (received − sent) = the residual to sell. */
  residualAmount: number;
}

const LAMPORTS_PER_SOL = 1e9;
const PAGE_SIZE = 100;
const INTER_PAGE_MS = 120; // gentle on the free-tier Enhanced endpoint

/**
 * Reads a wallet's realized token→SOL sells from the Helius Enhanced Transactions API
 * (`/v0/addresses/<wallet>/transactions?type=SWAP`) — the cheap, parsed, batched source of actual
 * fill prices (no per-tx RPC). Only CLEAN single-token sells are returned (exactly one non-SOL mint
 * leaves the wallet and SOL comes back), so each sell's SOL is unambiguously attributable to that
 * token; multi-token (batched) swaps are skipped (their per-token split is not recoverable here).
 *
 * Used by the residual reconstructor to value a closed position's residual at what it was REALLY
 * sold for — strictly more truthful than the pool-spot mark, which overstates large/illiquid exits.
 */
export class HeliusEnhancedGateway implements EnhancedTxGateway {
  private readonly apiKey: string | null;

  constructor(
    solanaHttpUrl: string,
    private readonly logger: Logger,
    // page budget for a full-history sweep — 5000×100 = 500k txs covers even very active multi-year
    // wallets (a paid plan pages this fast); `complete=false` is flagged if a wallet still exceeds it.
    private readonly maxPages = 5000,
    // The Enhanced REST endpoint bypasses the Connection rate-limiter, so it gets its OWN token bucket
    // to coordinate concurrent cold curve requests (different wallets) instead of bursting uncapped.
    enhancedRps = 5,
  ) {
    this.bucket = new TokenBucket(enhancedRps, enhancedRps);
    let key: string | null = null;
    try {
      key = new URL(solanaHttpUrl).searchParams.get('api-key');
    } catch {
      key = null;
    }
    this.apiKey = key;
  }

  private readonly bucket: TokenBucket;

  /** Enabled only when the Helius URL carries an api-key (the Enhanced API needs one). */
  get enabled(): boolean {
    return this.apiKey != null;
  }

  /**
   * All clean token→SOL sells since `sinceMs`, newest-first paging until the floor or history end.
   * `complete` is false when the history was NOT fully traversed (a page kept failing after retries,
   * or the maxPages cap was hit) — pages are newest-first, so an early stop drops the OLDEST sells.
   * The caller MUST treat an unmatched residual as unreliable (not "held") when complete is false for
   * positions older than the oldest sell actually fetched, instead of overwriting their PnL.
   */
  async fetchSells(
    wallet: string,
    sinceMs: number,
  ): Promise<{ sells: ResidualSell[]; complete: boolean; oldestTs: number }> {
    if (!this.apiKey) return { sells: [], complete: false, oldestTs: Number.POSITIVE_INFINITY };
    const sinceSec = sinceMs / 1000;
    const sells: ResidualSell[] = [];
    let before: string | undefined;
    let reachedFloor = false;
    let complete = false;
    let oldestTs = Number.POSITIVE_INFINITY;
    let page = 0;

    for (; page < this.maxPages && !reachedFloor; page++) {
      const url =
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
        `?api-key=${this.apiKey}&type=SWAP&limit=${PAGE_SIZE}${before ? `&before=${before}` : ''}`;
      const txs = await this.fetchPageWithRetry(url, wallet, page);
      if (txs == null) {
        // page failed after retries → history is incomplete (oldest sells missing). Stop, flag it.
        this.logger.warn({ wallet, page }, 'enhanced API page failed after retries — INCOMPLETE');
        break;
      }
      if (txs.length === 0) {
        complete = true; // genuine end of history
        break;
      }
      for (const tx of txs) {
        oldestTs = Math.min(oldestTs, tx.timestamp);
        if (tx.timestamp < sinceSec) {
          reachedFloor = true; // walked back past the window → we have everything in-window
          continue;
        }
        const sell = parseSwapSell(tx, wallet);
        if (sell) sells.push(sell);
      }
      const last = txs[txs.length - 1];
      if (!last) {
        complete = true;
        break;
      }
      before = last.signature;
      if (INTER_PAGE_MS) await new Promise((r) => setTimeout(r, INTER_PAGE_MS));
    }
    if (reachedFloor) complete = true;
    if (page >= this.maxPages && !complete) {
      this.logger.warn(
        { wallet, maxPages: this.maxPages },
        'enhanced API hit maxPages — INCOMPLETE',
      );
    }
    this.logger.info({ wallet, sells: sells.length, complete }, 'enhanced: residual sells fetched');
    return { sells, complete, oldestTs };
  }

  /** Same paging as fetchSells but extracts BUYS (token in, SOL out) — the real SOL entry cost of
   *  pre-bought deposited tokens. Returns the ResidualSell shape (solReceived = SOL spent). */
  async fetchBuys(
    wallet: string,
    sinceMs: number,
  ): Promise<{ buys: ResidualSell[]; complete: boolean; oldestTs: number }> {
    if (!this.apiKey) return { buys: [], complete: false, oldestTs: Number.POSITIVE_INFINITY };
    const sinceSec = sinceMs / 1000;
    const buys: ResidualSell[] = [];
    let before: string | undefined;
    let reachedFloor = false;
    let complete = false;
    let oldestTs = Number.POSITIVE_INFINITY;
    let page = 0;
    for (; page < this.maxPages && !reachedFloor; page++) {
      const url =
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
        `?api-key=${this.apiKey}&type=SWAP&limit=${PAGE_SIZE}${before ? `&before=${before}` : ''}`;
      const txs = await this.fetchPageWithRetry(url, wallet, page);
      if (txs == null) break;
      if (txs.length === 0) {
        complete = true;
        break;
      }
      for (const tx of txs) {
        oldestTs = Math.min(oldestTs, tx.timestamp);
        if (tx.timestamp < sinceSec) {
          reachedFloor = true;
          continue;
        }
        const buy = parseSwapBuy(tx, wallet);
        if (buy) buys.push(buy);
      }
      const last = txs[txs.length - 1];
      if (!last) {
        complete = true;
        break;
      }
      before = last.signature;
      if (INTER_PAGE_MS) await new Promise((r) => setTimeout(r, INTER_PAGE_MS));
    }
    if (reachedFloor) complete = true;
    this.logger.info({ wallet, buys: buys.length, complete }, 'enhanced: buys fetched');
    return { buys, complete, oldestTs };
  }

  /**
   * Page the WALLET's own txs since `sinceMs` and reduce each to its net SOL+WSOL flow + a trading
   * flag (SWAP or DLMM-touching). Feeds the wallet PnL curve. `complete=false` on a fetch failure.
   */
  async fetchWalletFlows(
    wallet: string,
    sinceMs: number,
  ): Promise<{ flows: WalletTxFlow[]; complete: boolean }> {
    if (!this.apiKey) return { flows: [], complete: false };
    const sinceSec = sinceMs / 1000;
    const flows: WalletTxFlow[] = [];
    let before: string | undefined;
    let reachedFloor = false;
    let complete = false;
    for (let page = 0; page < this.maxPages && !reachedFloor; page++) {
      const url =
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
        `?api-key=${this.apiKey}&limit=${PAGE_SIZE}${before ? `&before=${before}` : ''}`;
      const txs = await this.fetchPageWithRetry(url, wallet, page);
      if (txs == null) break; // incomplete
      if (txs.length === 0) {
        complete = true;
        break;
      }
      for (const tx of txs) {
        if (tx.timestamp < sinceSec) {
          reachedFloor = true;
          continue;
        }
        flows.push({
          timestamp: tx.timestamp,
          type: tx.type ?? 'UNKNOWN',
          solFlow: walletSolFlow(tx, wallet),
          isTrading: classifyTradingByType(tx.type ?? '', touchesDlmm(tx)),
        });
      }
      const last = txs[txs.length - 1];
      if (!last) {
        complete = true;
        break;
      }
      before = last.signature;
      if (INTER_PAGE_MS) await new Promise((r) => setTimeout(r, INTER_PAGE_MS));
    }
    if (reachedFloor) complete = true;
    this.logger.info({ wallet, flows: flows.length, complete }, 'enhanced: wallet flows fetched');
    return { flows, complete };
  }

  /**
   * Page a wallet's FULL tx stream for PERSISTENCE (no time floor), newest → genesis, handing each page
   * to `onPage` so the caller persists incrementally (bounded memory + restart-resilient — a crash keeps
   * the pages already stored, and the idempotent upsert makes a re-run a no-op for them). Each tx is
   * reduced to its net SOL+WSOL flow + trading flag, tagged with its signature. Two modes via `untilSig`:
   *  - untilSig = null  → full backfill: page until genesis (empty / short page).
   *  - untilSig = sig   → top-up: page newest → until that previously-ingested signature, then stop.
   * `startBefore` resumes an interrupted backfill from the last oldest signature reached.
   * `complete` is true only when genesis was reached (full traversal); false on a page failure.
   */
  async pageFlows(
    wallet: string,
    opts: {
      untilSig?: string | null;
      startBefore?: string | null;
      onPage: (flows: WalletFlowRow[]) => Promise<void>;
    },
  ): Promise<{
    added: number;
    complete: boolean;
    newestSig: string | null;
    oldestSig: string | null;
  }> {
    if (!this.apiKey) return { added: 0, complete: false, newestSig: null, oldestSig: null };
    const stopSig = opts.untilSig ?? null;
    let added = 0;
    let before: string | undefined = opts.startBefore ?? undefined;
    let newestSig: string | null = null;
    let oldestSig: string | null = opts.startBefore ?? null;
    let complete = false;
    let hitKnownTop = false;
    let page = 0;
    for (; page < this.maxPages; page++) {
      const url =
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
        `?api-key=${this.apiKey}&limit=${PAGE_SIZE}${before ? `&before=${before}` : ''}`;
      const txs = await this.fetchPageWithRetry(url, wallet, page);
      if (txs == null) break; // retries exhausted → incomplete; keep what we have, cursor won't advance
      if (txs.length === 0) {
        complete = true; // genesis (full) or nothing new (top-up)
        break;
      }
      if (newestSig === null) newestSig = txs[0]!.signature;
      const pageFlows: WalletFlowRow[] = [];
      for (const tx of txs) {
        if (stopSig && tx.signature === stopSig) {
          hitKnownTop = true;
          break;
        }
        pageFlows.push({
          signature: tx.signature,
          timestamp: tx.timestamp,
          type: tx.type ?? 'UNKNOWN',
          solFlow: walletSolFlow(tx, wallet),
          isTrading: classifyTradingByType(tx.type ?? '', touchesDlmm(tx)),
        });
      }
      await opts.onPage(pageFlows);
      added += pageFlows.length;
      oldestSig = txs[txs.length - 1]!.signature;
      before = oldestSig;
      if (hitKnownTop) break; // reached previously-ingested top → caught up
      // NOTE: do NOT treat a short page (< PAGE_SIZE) as genesis. Unlike getSignaturesForAddress, the
      // Helius Enhanced API returns short pages MID-history; stopping there silently drops the older
      // tail (it cost ~15 SOL of older losses in testing). Only a truly EMPTY page marks genesis.
      if (INTER_PAGE_MS) await new Promise((r) => setTimeout(r, INTER_PAGE_MS));
    }
    if (page >= this.maxPages && !complete) {
      this.logger.warn({ wallet, maxPages: this.maxPages }, 'pageFlows hit maxPages — INCOMPLETE');
    }
    this.logger.info({ wallet, added, complete }, 'enhanced: wallet flows paged');
    return { added, complete, newestSig, oldestSig };
  }

  /** Fetch one page; retry with backoff on 429/5xx/throw. Returns null when it keeps failing. */
  private async fetchPageWithRetry(
    url: string,
    wallet: string,
    page: number,
  ): Promise<EnhancedTx[] | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await this.bucket.acquire();
        const res = await fetch(url, { headers: { 'User-Agent': 'binsight/1.0' } });
        if (res.ok) return (await res.json()) as EnhancedTx[];
        // Retry EVERY non-200 (Helius intermittently returns 5xx/4xx mid-pagination on deep history);
        // giving up on the first blip would drop the whole tail of older sells. Only an auth 401/403
        // is truly fatal.
        if (res.status === 401 || res.status === 403) {
          this.logger.warn({ wallet, page, status: res.status }, 'enhanced API auth failure');
          return null;
        }
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        const backoff = Math.min(8000, 500 * 2 ** attempt); // cap so a long tail doesn't stall the run
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : backoff;
        this.logger.debug({ wallet, page, status: res.status, attempt }, 'enhanced API retry');
        await new Promise((r) => setTimeout(r, wait));
      } catch (err) {
        this.logger.warn({ err, wallet, page, attempt }, 'enhanced API page error — retrying');
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      }
    }
    return null;
  }

  /**
   * Reconstruct a closed position's SOL legs + net residual PURELY from its on-chain txs (no Meteora).
   * Used to recover positions older than Meteora's ~7-month financial retention. Pages the POSITION
   * address (a position has few txs). Returns null if a page keeps failing — never a partial flow.
   */
  async reconstructPosition(
    positionAddress: string,
    wallet: string,
    mint: string,
  ): Promise<PositionFlow | null> {
    if (!this.apiKey) return null;
    const all: EnhancedTx[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url =
        `https://api.helius.xyz/v0/addresses/${positionAddress}/transactions` +
        `?api-key=${this.apiKey}&limit=${PAGE_SIZE}${before ? `&before=${before}` : ''}`;
      const txs = await this.fetchPageWithRetry(url, positionAddress, page);
      if (txs == null) return null; // incomplete → don't trust a partial reconstruction
      if (txs.length === 0) break;
      all.push(...txs);
      const last = txs[txs.length - 1];
      if (!last) break;
      before = last.signature;
      if (INTER_PAGE_MS) await new Promise((r) => setTimeout(r, INTER_PAGE_MS));
    }
    if (all.length === 0) return null;
    return accumulatePositionFlow(all, wallet, mint);
  }
}

/**
 * Sum a position's on-chain flow: the wallet's net SOL (native balance change + WSOL token-balance
 * change, which together capture deposits, SOL-side withdrawals, claimed SOL fees and net rent) and
 * the NET residual token it took out (received − sent, so multi add/remove cycles don't over-count).
 */
export function accumulatePositionFlow(
  txs: EnhancedTx[],
  wallet: string,
  mint: string,
): PositionFlow {
  let lamports = 0;
  let wsol = 0;
  let received = 0;
  let sent = 0;
  for (const tx of txs) {
    for (const ad of tx.accountData ?? []) {
      if (ad.account === wallet) lamports += ad.nativeBalanceChange ?? 0;
      for (const tb of ad.tokenBalanceChanges ?? []) {
        if (tb.userAccount === wallet && tb.mint === SOL_MINT) {
          wsol += Number(tb.rawTokenAmount.tokenAmount) / 10 ** tb.rawTokenAmount.decimals;
        }
      }
    }
    for (const tt of tx.tokenTransfers ?? []) {
      if (tt.mint !== mint) continue;
      if (tt.toUserAccount === wallet) received += tt.tokenAmount;
      if (tt.fromUserAccount === wallet) sent += tt.tokenAmount;
    }
  }
  return {
    solLegSol: lamports / LAMPORTS_PER_SOL + wsol,
    residualAmount: Math.max(0, received - sent),
  };
}

/** The wallet's net SOL+WSOL change in a tx (native balance change + WSOL token-balance change). */
function walletSolFlow(tx: EnhancedTx, wallet: string): number {
  let lamports = 0;
  let wsol = 0;
  for (const ad of tx.accountData ?? []) {
    if (ad.account === wallet) lamports += ad.nativeBalanceChange ?? 0;
    for (const tb of ad.tokenBalanceChanges ?? []) {
      if (tb.userAccount === wallet && tb.mint === SOL_MINT) {
        wsol += Number(tb.rawTokenAmount.tokenAmount) / 10 ** tb.rawTokenAmount.decimals;
      }
    }
  }
  return lamports / LAMPORTS_PER_SOL + wsol;
}

/** True if the tx invokes the DLMM program at top level or via a CPI (inner instruction). */
function touchesDlmm(tx: EnhancedTx): boolean {
  for (const ix of tx.instructions ?? []) {
    if (ix.programId === DLMM_PROGRAM_ID) return true;
    for (const inner of ix.innerInstructions ?? []) {
      if (inner.programId === DLMM_PROGRAM_ID) return true;
    }
  }
  return false;
}

const MIN_NET_FRACTION = 0.01; // a mint counts as SOLD only if net-out exceeds 1% of its gross out

/**
 * Parse a SWAP into a clean token→SOL sell, or null if not cleanly attributable. Everything is NET of
 * same-account round-trips: (1) the SOLD mint is the single non-SOL mint with a real NET outflow —
 * intermediates a Jupiter route transits through the wallet's own ATA (e.g. USDC: received then sent
 * onward, out≈back) net to ~0 and are excluded, so such routes aren't wrongly dropped as "batched";
 * (2) the token amount is its net out−back; (3) SOL proceeds are net WSOL in−out (else net native),
 * which strips routing/fee WSOL hops (validated to the lamport against nativeBalanceChange). Returns
 * null for a genuine multi-token sell (2+ mints with real net outflow → unattributable) or no SOL in.
 */
export function parseSwapSell(tx: EnhancedTx, wallet: string): ResidualSell | null {
  const tts = tx.tokenTransfers ?? [];
  const candidates = [
    ...new Set(
      tts
        .filter((t) => t.mint !== SOL_MINT && t.fromUserAccount === wallet && t.tokenAmount > 0)
        .map((t) => t.mint),
    ),
  ];
  const netOut = (mint: string) => {
    const out = tts
      .filter((t) => t.mint === mint && t.fromUserAccount === wallet)
      .reduce((s, t) => s + t.tokenAmount, 0);
    const back = tts
      .filter((t) => t.mint === mint && t.toUserAccount === wallet)
      .reduce((s, t) => s + t.tokenAmount, 0);
    return { out, net: out - back };
  };
  // Keep only mints genuinely SOLD (net outflow), dropping pass-through intermediates (net ≈ 0).
  const sold = candidates
    .map((mint) => ({ mint, ...netOut(mint) }))
    .filter((x) => x.net > 0 && x.net > x.out * MIN_NET_FRACTION);
  if (sold.length !== 1) return null; // 0 = pure transit; 2+ = real batched sell → unattributable
  const { mint, net: tokenAmount } = sold[0]!;

  // NET SOL proceeds — a multi-hop route makes the wallet's WSOL ATA both receive and send WSOL.
  const wsolIn = tts
    .filter((t) => t.mint === SOL_MINT && t.toUserAccount === wallet)
    .reduce((s, t) => s + t.tokenAmount, 0);
  const wsolOut = tts
    .filter((t) => t.mint === SOL_MINT && t.fromUserAccount === wallet)
    .reduce((s, t) => s + t.tokenAmount, 0);
  const netWsol = wsolIn - wsolOut;
  const nat = tx.nativeTransfers ?? [];
  const nativeIn = nat.filter((t) => t.toUserAccount === wallet).reduce((s, t) => s + t.amount, 0);
  const nativeOut = nat
    .filter((t) => t.fromUserAccount === wallet)
    .reduce((s, t) => s + t.amount, 0);
  const netNative = (nativeIn - nativeOut) / LAMPORTS_PER_SOL;
  const solReceived = netWsol > 1e-9 ? netWsol : netNative;
  if (tokenAmount <= 0 || solReceived <= 0) return null;
  return { ts: tx.timestamp, mint, tokenAmount, solReceived };
}

/**
 * Mirror of parseSwapSell for BUYS: the wallet RECEIVES a token (net inflow) and SPENDS SOL. Returns
 * the ResidualSell shape with solReceived = SOL SPENT, so reconstructRealized can FIFO-attribute buys
 * to a position's deposited tokens exactly like it attributes sells to residuals — i.e. the real SOL
 * entry cost of pre-bought deposited tokens (the missing piece for token/mixed-deposit positions).
 */
function parseSwapBuy(tx: EnhancedTx, wallet: string): ResidualSell | null {
  const tts = tx.tokenTransfers ?? [];
  const candidates = [
    ...new Set(
      tts
        .filter((t) => t.mint !== SOL_MINT && t.toUserAccount === wallet && t.tokenAmount > 0)
        .map((t) => t.mint),
    ),
  ];
  const netIn = (mint: string) => {
    const inn = tts
      .filter((t) => t.mint === mint && t.toUserAccount === wallet)
      .reduce((s, t) => s + t.tokenAmount, 0);
    const back = tts
      .filter((t) => t.mint === mint && t.fromUserAccount === wallet)
      .reduce((s, t) => s + t.tokenAmount, 0);
    return { inn, net: inn - back };
  };
  const bought = candidates
    .map((mint) => ({ mint, ...netIn(mint) }))
    .filter((x) => x.net > 0 && x.net > x.inn * MIN_NET_FRACTION);
  if (bought.length !== 1) return null;
  const { mint, net: tokenAmount } = bought[0]!;

  const wsolOut = tts
    .filter((t) => t.mint === SOL_MINT && t.fromUserAccount === wallet)
    .reduce((s, t) => s + t.tokenAmount, 0);
  const wsolIn = tts
    .filter((t) => t.mint === SOL_MINT && t.toUserAccount === wallet)
    .reduce((s, t) => s + t.tokenAmount, 0);
  const netWsolOut = wsolOut - wsolIn;
  const nat = tx.nativeTransfers ?? [];
  const nativeOut = nat
    .filter((t) => t.fromUserAccount === wallet)
    .reduce((s, t) => s + t.amount, 0);
  const nativeIn = nat.filter((t) => t.toUserAccount === wallet).reduce((s, t) => s + t.amount, 0);
  const netNativeOut = (nativeOut - nativeIn) / LAMPORTS_PER_SOL;
  const solSpent = netWsolOut > 1e-9 ? netWsolOut : netNativeOut;
  if (tokenAmount <= 0 || solSpent <= 0) return null;
  return { ts: tx.timestamp, mint, tokenAmount, solReceived: solSpent };
}
