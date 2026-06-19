import type { Bucket, ProfitBucket } from '@binsight/shared';

export type { Bucket, ProfitBucket };

export const BUCKET_MS: Record<Bucket, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
};

export const isBucket = (b: string): b is Bucket => b in BUCKET_MS;

/** Past this many filled buckets we keep the sparse series (guards e.g. hourly buckets all-time). */
const MAX_FILLED_BUCKETS = 1000;

/**
 * Turn ALREADY-AGGREGATED per-bucket realized PnL (e.g. from a SQL `GROUP BY` — so we never transfer
 * the raw closed rows) into the chart series: a CONTINUOUS x-axis (empty periods filled at 0) with an
 * all-time running cumulative (the line). `sinceMs` only windows which buckets are RETURNED — the
 * cumulative stays all-time so a zoomed view still shows the true running total.
 *
 * Bucket keys must be floored to the period (`floor(t/size)*size`), the same flooring the SQL does.
 */
export function profitHistory(
  buckets: { t: number; realized: number }[],
  bucket: Bucket,
  sinceMs = 0,
): ProfitBucket[] {
  const size = BUCKET_MS[bucket];
  const realizedByBucket = new Map<number, number>();
  for (const b of buckets) realizedByBucket.set(b.t, (realizedByBucket.get(b.t) ?? 0) + b.realized);
  const keys = [...realizedByBucket.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return [];

  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  let cumulative = 0;
  const out: ProfitBucket[] = [];
  // Fill every bucket between first and last close; fall back to sparse only on a pathological span.
  if ((last - first) / size <= MAX_FILLED_BUCKETS) {
    for (let t = first; t <= last; t += size) {
      const realized = realizedByBucket.get(t) ?? 0;
      cumulative += realized;
      if (t >= sinceMs) out.push({ t, realized, cumulative });
    }
  } else {
    for (const t of keys) {
      const realized = realizedByBucket.get(t) ?? 0;
      cumulative += realized;
      if (t >= sinceMs) out.push({ t, realized, cumulative });
    }
  }
  return out;
}
