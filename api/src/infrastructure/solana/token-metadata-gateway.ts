import { SOL_MINT, USDC_MINT, USDT_MINT } from '@binsight/shared';
import type { Logger } from 'pino';
import type { TokenMeta, TokenMetadataGateway } from '@/domain/ports';
import { singleFlight, TokenBucket, TtlCache } from '@/util/cache';

const DAS_BATCH = 1000; // getAssetBatch id cap
const META_TTL_MS = 24 * 60 * 60 * 1000; // metadata is ~immutable → cache a full day
const MAX_CACHED = 50_000;

/** Stable mints served locally — never spend a DAS call (or risk a miss) on these. */
const KNOWN: Readonly<Record<string, TokenMeta>> = {
  [SOL_MINT]: { symbol: 'SOL' },
  [USDC_MINT]: { symbol: 'USDC' },
  [USDT_MINT]: { symbol: 'USDT' },
};

/** Never render a blank token: an unknown mint shows as a truncated address. */
const fallback = (mint: string): TokenMeta => ({ symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}` });

interface DasAsset {
  id?: string;
  content?: {
    metadata?: { symbol?: string };
    links?: { image?: string };
    files?: { uri?: string }[];
  };
}

/** Fetches one batch of mints → mint→meta (only mints that actually carry a symbol). Throws on transport error. */
export type DasTransport = (mints: string[]) => Promise<Map<string, TokenMeta>>;

function heliusTransport(httpUrl: string, bucket: TokenBucket): DasTransport {
  return async (mints) => {
    await bucket.acquire();
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'token-meta',
        method: 'getAssetBatch',
        params: { ids: mints },
      }),
    });
    if (!res.ok) throw new Error(`getAssetBatch HTTP ${res.status}`);
    const json = (await res.json()) as { result?: DasAsset[] };
    const map = new Map<string, TokenMeta>();
    for (const a of json.result ?? []) {
      if (!a?.id) continue;
      const symbol = a.content?.metadata?.symbol?.trim();
      if (!symbol) continue;
      const icon = a.content?.links?.image ?? a.content?.files?.[0]?.uri;
      map.set(a.id, icon ? { symbol, icon } : { symbol });
    }
    return map;
  };
}

/**
 * Token display metadata via Helius DAS `getAssetBatch`, mint-keyed (dedups across users/positions) with a
 * day-long cache. Stable mints (SOL/USDC/USDT) are served locally; unknown mints get a truncated-address
 * fallback so a row never renders blank. A transport failure degrades to fallbacks — `resolve` never throws.
 */
export class HeliusTokenMetadataGateway implements TokenMetadataGateway {
  private readonly cache = new TtlCache<TokenMeta>(META_TTL_MS, MAX_CACHED);
  private readonly flight = singleFlight<Map<string, TokenMeta>>();
  private readonly transport: DasTransport;

  constructor(
    httpUrl: string,
    private readonly logger: Logger,
    dasRps = 2,
    transport?: DasTransport,
  ) {
    const rps = Math.max(1, dasRps);
    this.transport = transport ?? heliusTransport(httpUrl, new TokenBucket(rps, rps));
  }

  async resolve(mints: string[]): Promise<Map<string, TokenMeta>> {
    const out = new Map<string, TokenMeta>();
    const missing: string[] = [];
    for (const mint of new Set(mints)) {
      const known = KNOWN[mint];
      if (known) {
        out.set(mint, known);
        continue;
      }
      const hit = this.cache.get(mint);
      if (hit) {
        out.set(mint, hit);
        continue;
      }
      missing.push(mint);
    }

    for (let i = 0; i < missing.length; i += DAS_BATCH) {
      const chunk = missing.slice(i, i + DAS_BATCH);
      let fetched: Map<string, TokenMeta>;
      try {
        // Key on the FULL sorted mint set — `${chunk[0]}:${len}` collided across wallets sharing the
        // first mint + length, collapsing two distinct fetches into one and caching the loser's mints
        // with truncated fallback symbols for 24h.
        fetched = await this.flight([...chunk].sort().join(','), () => this.transport(chunk));
      } catch (err) {
        this.logger.warn(
          { err, n: chunk.length },
          'token metadata fetch failed — using fallback symbols',
        );
        fetched = new Map();
      }
      for (const mint of chunk) {
        // cache the fallback too: a metadata-less memecoin must not be re-fetched every sync (bounded cost).
        const meta = fetched.get(mint) ?? fallback(mint);
        this.cache.set(mint, meta);
        out.set(mint, meta);
      }
    }
    return out;
  }
}
