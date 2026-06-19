import { SOL_MINT } from '@binsight/shared';
import type { Logger } from 'pino';
import type { HealthReporter, PriceGateway } from '@/domain/ports';

const MAX_IDS = 50; // Jupiter Price API v3 caps ids per request

/**
 * Token prices in SOL via Jupiter Price API v3 (the v2 API is deprecated).
 * v3 returns USD prices; we derive SOL by dividing by SOL's own USD price.
 * Best-effort: on any failure the map is empty and callers keep the pool-price mark.
 */
export class JupiterPriceGateway implements PriceGateway {
  constructor(
    private readonly logger: Logger,
    private readonly baseUrl: string,
    private readonly health?: HealthReporter,
  ) {}

  async getPricesSol(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const unique = [...new Set(mints.filter((m) => m && m !== SOL_MINT))];
    if (unique.length === 0) return out;

    for (let i = 0; i < unique.length; i += MAX_IDS) {
      const chunk = unique.slice(i, i + MAX_IDS);
      try {
        const res = await fetch(`${this.baseUrl}?ids=${[...chunk, SOL_MINT].join(',')}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Jupiter ${res.status}`);
        const data = (await res.json()) as Record<string, { usdPrice?: number } | null>;
        const solUsd = data[SOL_MINT]?.usdPrice;
        if (!solUsd || solUsd <= 0) continue;
        for (const mint of chunk) {
          const usd = data[mint]?.usdPrice;
          if (usd && usd > 0) out.set(mint, usd / solUsd);
        }
        this.health?.record('jupiter', true);
      } catch (err) {
        this.health?.record('jupiter', false, err instanceof Error ? err.message : String(err));
        this.logger.warn({ err }, 'Jupiter price fetch failed (keeping pool price)');
      }
    }
    return out;
  }

  async getSolUsd(): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}?ids=${SOL_MINT}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Jupiter ${res.status}`);
      const data = (await res.json()) as Record<string, { usdPrice?: number } | null>;
      const usd = data[SOL_MINT]?.usdPrice;
      this.health?.record('jupiter', true);
      return usd && usd > 0 ? usd : null;
    } catch (err) {
      this.health?.record('jupiter', false, err instanceof Error ? err.message : String(err));
      this.logger.warn({ err }, 'Jupiter SOL/USD fetch failed');
      return null;
    }
  }
}
