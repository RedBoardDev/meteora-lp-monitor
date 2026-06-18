import { describe, expect, it } from 'vitest';
import { profitHistory } from './profit-history';

const day = 86_400_000;
// profitHistory now takes ALREADY-aggregated per-bucket rows (the SQL GROUP BY does the flooring/sum).
const b = (t: number, realized: number) => ({ t, realized });

describe('profitHistory', () => {
  it('sums same-bucket rows, fills empty buckets (continuous x-axis), runs an all-time cumulative', () => {
    const h = profitHistory([b(day, 2), b(day, 3), b(3 * day, -1)], 'day');
    // day-1 rows merge → 5; day-2 has no row → filled 0; day-3 → -1
    expect(h.map((x) => x.realized)).toEqual([5, 0, -1]);
    expect(h.map((x) => x.cumulative)).toEqual([5, 5, 4]);
  });

  it('windows the returned buckets but keeps the cumulative all-time', () => {
    const h = profitHistory([b(0, 10), b(5 * day, 3)], 'day', 5 * day);
    expect(h).toHaveLength(1);
    expect(h[0]?.realized).toBe(3);
    expect(h[0]?.cumulative).toBe(13); // 10 (before the window) + 3
  });

  it('returns empty when there are no buckets', () => {
    expect(profitHistory([], 'day')).toEqual([]);
  });
});
