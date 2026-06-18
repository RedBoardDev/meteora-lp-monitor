import type { Candle } from '@meteora/shared';
import type { Logger } from 'pino';

export type { Candle };

// Supported timeframes → GeckoTerminal (path segment, aggregate count).
const TIMEFRAMES: Record<string, { tf: 'minute' | 'hour' | 'day'; aggregate: number }> = {
  '1m': { tf: 'minute', aggregate: 1 },
  '5m': { tf: 'minute', aggregate: 5 },
  '15m': { tf: 'minute', aggregate: 15 },
  '1h': { tf: 'hour', aggregate: 1 },
  '4h': { tf: 'hour', aggregate: 4 },
  '1d': { tf: 'day', aggregate: 1 },
};

export const GECKOTERMINAL_TIMEFRAMES = Object.keys(TIMEFRAMES);

/**
 * OHLCV candles for a Solana pool from GeckoTerminal (free, no key). Prices are requested with
 * `currency=token&token=base`, i.e. the base token quoted in the pool's quote token (SOL for our
 * SOL pairs) — the SAME unit as a position's stored bin min/max, so the range band overlays exactly.
 * Best-effort: returns [] on any failure or when a brand-new pool isn't indexed yet (the caller then
 * falls back to the dexscreener embed). 404 is the normal "not indexed" signal and is not logged.
 */
export class GeckoTerminalGateway {
  constructor(
    private readonly logger: Logger,
    private readonly baseUrl = 'https://api.geckoterminal.com/api/v2',
  ) {}

  async ohlcv(pool: string, timeframe: string): Promise<Candle[]> {
    const spec = TIMEFRAMES[timeframe];
    if (!spec) return [];
    const url =
      `${this.baseUrl}/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/${spec.tf}` +
      `?aggregate=${spec.aggregate}&limit=1000&currency=token&token=base`;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status !== 404) {
          this.logger.warn({ pool, status: res.status }, 'GeckoTerminal OHLCV non-OK');
        }
        return [];
      }
      const body = (await res.json()) as {
        data?: { attributes?: { ohlcv_list?: number[][] } };
      };
      const list = body.data?.attributes?.ohlcv_list ?? [];
      // GeckoTerminal returns newest-first; charts need strictly ascending time. Skip any short or
      // malformed row (would coerce undefined→NaN) rather than asserting it well-formed.
      return list
        .flatMap<Candle>((c) => {
          if (!Array.isArray(c) || c.length < 6) return [];
          const [time, open, high, low, close, volume] = c;
          const fin = (n: number | undefined): n is number =>
            typeof n === 'number' && Number.isFinite(n);
          if (!fin(time) || !fin(open) || !fin(high) || !fin(low) || !fin(close) || !fin(volume)) {
            return [];
          }
          return [{ time, open, high, low, close, volume }];
        })
        .sort((a, b) => a.time - b.time);
    } catch (err) {
      this.logger.warn({ err, pool }, 'GeckoTerminal OHLCV fetch failed');
      return [];
    }
  }
}
