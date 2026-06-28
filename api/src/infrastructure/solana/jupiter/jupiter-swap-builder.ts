/**
 * Copy-bot · Jupiter swap builder (I/O). Builds the UNSIGNED legacy swap tx for two flows:
 *  - token→SOL SELL (residual / wallet sweep): `getJupiterQuote` (ExactIn), published as `kind:'sell'`.
 *  - SOL→token BUY (two-sided copy, fund the token leg): `getJupiterBuyQuote` (ExactOut — buy EXACTLY the token
 *    amount needed so the two-sided open can be built upfront), published as `kind:'buy'`.
 * Both share `buildJupiterSwapTx`. `asLegacyTransaction:true` keeps it on the vault's legacy sign path; Wall B
 * re-verifies; the vault signs+lands. External responses are validated (zod) — never trust a remote shape blindly.
 */
import { z } from 'zod';

/** Wrapped SOL — the swap output mint (we always sell the residual token back to SOL). */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Default Jupiter swap API base (free "lite" tier; the old quote-api.jup.ag/v6 host is decommissioned).
 *  Endpoints used: `${base}/quote` (GET) + `${base}/swap` (POST). Override via JUPITER_BASE_URL. */
export const DEFAULT_JUPITER_BASE_URL = 'https://lite-api.jup.ag/swap/v1';

interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type HttpFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<HttpResponse>;

const defaultFetch: HttpFetch = (url, init) => fetch(url, init);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]); // rate-limit / transient server / gateway
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 250;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fetch + parse JSON with retry/backoff on TRANSIENT failures (HTTP 429/5xx, network errors). A 4xx like 400
 *  (no route / bad request) is PERMANENT → thrown immediately (no point retrying). Jupiter's free tier
 *  rate-limits under bursts (the copy-bot's buy + sweep sells), so retrying is essential resilience. */
async function fetchJsonWithRetry(fetchFn: HttpFetch, url: string, init: Parameters<HttpFetch>[1], label: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: HttpResponse | undefined;
    try {
      res = await fetchFn(url, init);
    } catch {
      /* network error → retryable (res stays undefined) */
    }
    if (res?.ok) return res.json();
    const status = res?.status;
    if (status !== undefined && !RETRYABLE_STATUS.has(status)) throw new Error(`jupiter ${label} http ${status}`); // permanent
    if (attempt >= RETRY_ATTEMPTS - 1) throw new Error(`jupiter ${label} ${status === undefined ? 'network error' : `http ${status}`} (retries exhausted)`);
    await sleep(RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 100));
  }
}

// Jupiter returns far more than this; we validate the fields we rely on and pass the whole object back to /swap.
const QuoteResponseSchema = z.object({ inAmount: z.string(), outAmount: z.string() }).passthrough();
const SwapResponseSchema = z.object({ swapTransaction: z.string() }).passthrough();

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** the full quote object, forwarded verbatim to /swap. */
  raw: unknown;
}

/** Fetch a quote to swap `amountRaw` raw units of `inputMint` into SOL, tolerating `slippageBps`. Throws on no route. */
export async function getJupiterQuote(
  baseUrl: string,
  inputMint: string,
  amountRaw: bigint,
  slippageBps: number,
  fetchFn: HttpFetch = defaultFetch,
): Promise<JupiterQuote> {
  const url = `${baseUrl}/quote?inputMint=${inputMint}&outputMint=${WSOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}&asLegacyTransaction=true`;
  const raw = QuoteResponseSchema.parse(await fetchJsonWithRetry(fetchFn, url, undefined, 'quote'));
  return { inputMint, outputMint: WSOL_MINT, inAmount: raw.inAmount, outAmount: raw.outAmount, raw };
}

/** Fetch an ExactOut quote to BUY exactly `exactOutAmountRaw` of `outputMint`, paid in SOL (wrapped). Used by the
 *  two-sided copy to fund the token leg with a deterministic amount → the two-sided open can be built upfront.
 *  Throws on no route. `inAmount` (SOL spent) is the slippage-bounded max the swap may cost. */
export async function getJupiterBuyQuote(
  baseUrl: string,
  outputMint: string,
  exactOutAmountRaw: bigint,
  slippageBps: number,
  fetchFn: HttpFetch = defaultFetch,
): Promise<JupiterQuote> {
  const url = `${baseUrl}/quote?inputMint=${WSOL_MINT}&outputMint=${outputMint}&amount=${exactOutAmountRaw}&slippageBps=${slippageBps}&swapMode=ExactOut&asLegacyTransaction=true`;
  const raw = QuoteResponseSchema.parse(await fetchJsonWithRetry(fetchFn, url, undefined, 'buy quote'));
  return { inputMint: WSOL_MINT, outputMint, inAmount: raw.inAmount, outAmount: raw.outAmount, raw };
}


/**
 * ExactIn BUY: spend `solInLamports` WSOL → receive a VARIABLE token amount. ExactIn has FULL Jupiter routing,
 * whereas ExactOut has NO route for most memecoins (NO_ROUTES_FOUND) — so the two-sided copy MUST use this and then
 * deposit the ACTUAL token amount received (read on-chain post-swap), not a pre-planned exact amount.
 */
export async function getJupiterBuyQuoteExactIn(
  baseUrl: string,
  outputMint: string,
  solInLamports: bigint,
  slippageBps: number,
  fetchFn: HttpFetch = defaultFetch,
): Promise<JupiterQuote> {
  const url = `${baseUrl}/quote?inputMint=${WSOL_MINT}&outputMint=${outputMint}&amount=${solInLamports}&slippageBps=${slippageBps}&swapMode=ExactIn&asLegacyTransaction=true`;
  const raw = QuoteResponseSchema.parse(await fetchJsonWithRetry(fetchFn, url, undefined, 'buy quote (ExactIn)'));
  return { inputMint: WSOL_MINT, outputMint, inAmount: raw.inAmount, outAmount: raw.outAmount, raw };
}

/** Build the UNSIGNED legacy swap tx (base64) for `quote`, with `userPublicKey` as the signer/fee payer. */
export async function buildJupiterSwapTx(
  baseUrl: string,
  quote: JupiterQuote,
  userPublicKey: string,
  fetchFn: HttpFetch = defaultFetch,
): Promise<string> {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey,
      asLegacyTransaction: true, // stay on the vault's legacy sign path
      wrapAndUnwrapSol: true, // unwrap the WSOL output back to native SOL for the owner
      dynamicComputeUnitLimit: true,
    }),
  };
  const json = SwapResponseSchema.parse(await fetchJsonWithRetry(fetchFn, `${baseUrl}/swap`, init, 'swap'));
  return json.swapTransaction; // base64 legacy tx, unsigned
}
