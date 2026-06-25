/**
 * Copy-bot · I/O adapter — Jupiter Tokens API v2 `search` → our normalized `TokenSnapshot`. ONE call returns
 * organicScore, holderCount, mcap, firstPool, 24h stats AND audit (authority) → feeds up to 6 filters at once
 * (spec `19` §5). Best-effort like `infrastructure/jupiter/jupiter-price.ts`: any failure (non-OK / parse /
 * network / timeout) ⇒ `null` so the enabled filters skip rather than throw on the open path.
 */
import { z } from 'zod';
import type { TokenSnapshot, TokenSnapshotProvider } from '../source';

/** lite-api = keyless (rate-limited; fine for the PoC). `api.jup.ag` needs an `x-api-key` (scale). */
export const DEFAULT_JUPITER_TOKEN_BASE_URL = 'https://lite-api.jup.ag';
const TOKEN_SEARCH_PATH = '/tokens/v2/search';
const DEFAULT_TIMEOUT_MS = 2_000; // bounded so a slow Jupiter never blocks the open (spec 19 §5)

const StatsSchema = z
  .object({ priceChange: z.number().nullish(), buyVolume: z.number().nullish(), sellVolume: z.number().nullish() })
  .passthrough();
const AuditSchema = z
  .object({
    mintAuthorityDisabled: z.boolean().nullish(),
    freezeAuthorityDisabled: z.boolean().nullish(),
    topHoldersPercentage: z.number().nullish(),
  })
  .passthrough();
const TokenSchema = z
  .object({
    id: z.string(),
    organicScore: z.number().nullish(),
    holderCount: z.number().nullish(),
    mcap: z.number().nullish(),
    firstPool: z.object({ createdAt: z.string().nullish() }).nullish(),
    stats24h: StatsSchema.nullish(),
    audit: AuditSchema.nullish(),
  })
  .passthrough();
/** Jupiter v2 `search` returns an array of token objects; we match by mint. */
const SearchResponseSchema = z.array(TokenSchema);

type TokenRaw = z.infer<typeof TokenSchema>;

export interface JupiterTokenGatewayOpts {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Called on any failure so the brain can log + record health (decoupled from this adapter). */
  onError?: (err: unknown, mint: string) => void;
}

export class JupiterTokenGateway {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: JupiterTokenGatewayOpts = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_JUPITER_TOKEN_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** A `TokenSnapshotProvider` — bind as `(m) => gateway.getSnapshot(m)`. */
  readonly getSnapshot: TokenSnapshotProvider = async (mint) => {
    try {
      const headers = this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : undefined;
      const url = `${this.baseUrl}${TOKEN_SEARCH_PATH}?query=${encodeURIComponent(mint)}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`Jupiter tokens ${res.status}`);
      const token = SearchResponseSchema.parse(await res.json()).find((t) => t.id === mint);
      return token ? normalize(token) : null;
    } catch (err) {
      this.opts.onError?.(err, mint);
      return null;
    }
  };
}

/** Map Jupiter's raw token to our normalized snapshot (24h volume = buy + sell; age parsed from firstPool). */
function normalize(t: TokenRaw): TokenSnapshot {
  const buy = t.stats24h?.buyVolume ?? null;
  const sell = t.stats24h?.sellVolume ?? null;
  const createdMs = t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : Number.NaN;
  return {
    organicScore: t.organicScore ?? null,
    holders: t.holderCount ?? null,
    marketCapUsd: t.mcap ?? null,
    volume24hUsd: buy == null && sell == null ? null : (buy ?? 0) + (sell ?? 0),
    priceChange24hPercent: t.stats24h?.priceChange ?? null,
    firstPoolCreatedAtMs: Number.isNaN(createdMs) ? null : createdMs,
    mintAuthorityDisabled: t.audit?.mintAuthorityDisabled ?? null,
    freezeAuthorityDisabled: t.audit?.freezeAuthorityDisabled ?? null,
    topHoldersPercent: t.audit?.topHoldersPercentage ?? null,
  };
}
