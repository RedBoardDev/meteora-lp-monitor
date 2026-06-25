/**
 * Copy-bot · PURE projection: a normalized `TokenSnapshot` → the `FilterContext` fields the bricks read.
 * No I/O. `priceRangePercent` is intentionally NOT set here — it comes from the leader position shape
 * (leader-shape source), not from the token snapshot.
 */
import type { FilterContext } from '../filter';
import type { TokenSnapshot } from './source';

const MS_PER_HOUR = 3_600_000;

/** Project the snapshot onto the context fields. `nowMs` is used to derive token age from `firstPool`. Pure. */
export function snapshotToContext(s: TokenSnapshot, nowMs: number): Partial<FilterContext> {
  const out: Partial<FilterContext> = {};
  if (s.organicScore != null) out.organicScore = s.organicScore;
  if (s.holders != null) out.holders = s.holders;
  if (s.marketCapUsd != null) out.marketCapUsd = s.marketCapUsd;
  if (s.volume24hUsd != null) out.volume24hUsd = s.volume24hUsd;
  if (s.priceChange24hPercent != null) out.priceChangePercent = s.priceChange24hPercent;
  if (s.firstPoolCreatedAtMs != null) out.tokenAgeHours = (nowMs - s.firstPoolCreatedAtMs) / MS_PER_HOUR;
  return out;
}
