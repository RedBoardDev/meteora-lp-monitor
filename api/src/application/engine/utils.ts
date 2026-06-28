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
/**
 * Decide whether to re-run the authoritative realized-PnL pass for a wallet right now.
 *
 * WHY this exists: the realized pass (which writes `market_pnl_sol` from the wallet's REAL Helius
 * buys/sells) is normally only (re)triggered when the wallet's closed-position COUNT changes. But a
 * freshly-closed position's residual is typically market-sold within seconds of close, so the pass
 * fired at close-detection time can run BEFORE that sell exists and marks the residual as still-held at
 * pool-spot — overstating PnL (e.g. shows -0.11 instead of the real -0.42). Without a re-trigger that
 * stale value would persist until the wallet's NEXT close.
 *
 * Helius indexes parsed transactions within ~1-2s of confirmation (measured), so the bottleneck is the
 * close→sell delay, not indexing. We therefore re-run on a small FRONT-LOADED schedule of offsets after
 * the close (e.g. ~25s, ~60s, ~150s): the first pass already catches the common case, the later ones
 * cover a delayed sell or congestion. The schedule is finite → bounded cost (≤ offsets.length extra
 * passes per close); once the last offset has fired we stop, so a quiet-but-viewed wallet never
 * re-fetches Helius indefinitely.
 *
 * `lastRealizedRunAt` is set equal to `lastCloseAt` at close-detection time, so the close-time pass
 * counts as offset 0 and the first scheduled refresh is the first offset > 0.
 */
export function shouldRefreshRealized(args: {
  now: number;
  lastCloseAt: number;
  lastRealizedRunAt: number;
  offsetsMs: number[];
}): boolean {
  const { now, lastCloseAt, lastRealizedRunAt, offsetsMs } = args;
  if (lastCloseAt <= 0) return false; // no close ever seen → nothing to converge
  const ageNow = now - lastCloseAt; // ms since the close
  const ageLastRun = lastRealizedRunAt - lastCloseAt; // ms-after-close of the last pass (close pass = 0)
  // Fire iff a scheduled checkpoint falls in (ageLastRun, ageNow] — i.e. one we're due for but haven't
  // run yet. Past the last offset, none qualify → we stop.
  return offsetsMs.some((o) => o > ageLastRun && o <= ageNow);
}

/**
 * Decide whether to re-take an EXACT on-chain snapshot for a wallet's OPEN positions right now.
 *
 * WHY this exists: the 10s price-mark only RE-PRICES the cached snapshot's frozen token + fee amounts at
 * the live Jupiter price (zero RPC). It cannot grow unclaimed fees or re-balance bin liquidity — those
 * need a fresh on-chain read. In `onchainSource` mode an exact read (`doSnapshot`) otherwise fires only on
 * an event (WS position-set change, viewer-connect, detail view), so a quiet open position's unclaimed
 * fees stay pinned at their last-read value (≈0 right after open) — wrong for the UI, and the HTTP-polling
 * widget never even gets the viewer-connect read. This drives a slow periodic exact read so unclaimed fees
 * + true size converge; idle wallets (no open positions) still issue zero recurring RPC.
 *
 * Uses the SAME clock + threshold as `doSnapshot`'s internal open-refresh gate (`lastSyncAt`/`intervalMs`)
 * so that when this fires, that gate also passes and the freshly-read open set is actually persisted.
 */
export function shouldRefreshOpenSnapshot(args: {
  hasOpen: boolean;
  reconciled: boolean;
  snapshotting: boolean;
  lastSyncAt: number;
  now: number;
  intervalMs: number;
}): boolean {
  const { hasOpen, reconciled, snapshotting, lastSyncAt, now, intervalMs } = args;
  if (!hasOpen || !reconciled || snapshotting) return false;
  return now - lastSyncAt >= intervalMs;
}
