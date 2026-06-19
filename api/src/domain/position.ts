import type { RangeStatus } from '@binsight/shared';

/** Pure domain helpers for position math. No I/O. */

export function resolveRangeStatus(
  poolPrice: number | null,
  minPrice: number,
  maxPrice: number,
): RangeStatus {
  if (poolPrice == null || !Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
    return 'unknown';
  }
  const low = Math.min(minPrice, maxPrice);
  const high = Math.max(minPrice, maxPrice);
  if (poolPrice < low) return 'out_down';
  if (poolPrice > high) return 'out_up';
  return 'in';
}

export function isOutOfRange(status: RangeStatus): boolean {
  return status === 'out_up' || status === 'out_down';
}
