import { sleep } from '@/util/sleep';

const CHUNK = 5;
const CHUNK_GAP_MS = 100;

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export async function chunked<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(...(await Promise.all(items.slice(i, i + CHUNK).map(fn))));
    if (i + CHUNK < items.length) await sleep(CHUNK_GAP_MS);
  }
  return out;
}

export function symmetricDiffSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const k of a) if (!b.has(k)) n++;
  for (const k of b) if (!a.has(k)) n++;
  return n;
}

/**
 * Decide whether to re-run the authoritative realized-PnL pass for a wallet right now.
 *
 * WHY this exists: the realized pass (which writes `market_pnl_sol` from the wallet's REAL Helius
 * buys/sells) is normally only (re)triggered when the wallet's closed-position COUNT changes. But a
 * freshly-closed position's residual is typically market-sold a few seconds after close, and Helius
 * needs time to index that swap. The first pass therefore runs BEFORE the sell is visible and marks the
 * residual as still-held at pool-spot — overstating PnL (e.g. shows −0.11 instead of the real −0.42).
 * Without a re-trigger that stale value would persist until the wallet's NEXT close.
 *
 * This keeps the pass running on the snapshot cadence for a bounded window after each close (throttled
 * to one pass per interval) so the value converges to the real sale proceeds on its own. It is
 * deliberately time-bounded: once `windowMs` has elapsed since the close, indexing is assumed settled
 * and we stop, so a quiet-but-viewed wallet never re-fetches Helius indefinitely.
 */
export function shouldRefreshRealized(args: {
  now: number;
  lastCloseAt: number;
  lastRealizedRunAt: number;
  windowMs: number;
  intervalMs: number;
}): boolean {
  const { now, lastCloseAt, lastRealizedRunAt, windowMs, intervalMs } = args;
  if (lastCloseAt <= 0) return false; // no close ever seen → nothing to converge
  if (now - lastCloseAt > windowMs) return false; // past the indexing-lag window → stop refreshing
  return now - lastRealizedRunAt >= intervalMs; // throttle to at most one pass per interval
}
