export type Period = '24h' | '7d' | '1m' | '3m' | '1y' | 'ytd' | 'all';

const DAY_MS = 86_400_000;

/** All-time window in days: ~10y > Solana's age, so it effectively means "no limit" — the curve stops
 *  at the wallet's first tx. Single source of truth (the API caps to the same value). */
export const ALL_TIME_DAYS = 3650;

/** Fixed look-back windows in ms. 'ytd' and 'all' are dynamic and resolved in `sinceMs`. */
const WINDOW_MS: Record<Exclude<Period, 'ytd' | 'all'>, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '1m': 30 * DAY_MS,
  '3m': 90 * DAY_MS,
  '1y': 365 * DAY_MS,
};

/** Epoch-ms of Jan 1 (UTC) for the year containing `now` — the YTD floor. UTC to match the curve's
 *  UTC day buckets (local time made the YTD baseline off by a day for non-UTC users). */
function startOfYearMs(now: number): number {
  return Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
}

/** Epoch-ms floor for a period (0 = all-time). Pass `now` from the caller (avoids render-time clocks). */
export function sinceMs(period: Period, now: number): number {
  if (period === 'all') return 0;
  if (period === 'ytd') return startOfYearMs(now);
  return now - WINDOW_MS[period];
}

/** Window length in days for the wallet PnL curve (all-time capped to the on-chain history we page). */
export function periodDays(period: Period, now: number): number {
  switch (period) {
    case '24h':
      return 1;
    case '7d':
      return 7;
    case '1m':
      return 30;
    case '3m':
      return 90;
    case '1y':
      return 365;
    case 'ytd':
      return Math.max(1, Math.ceil((now - startOfYearMs(now)) / DAY_MS));
    default:
      return ALL_TIME_DAYS; // 'all'
  }
}

export const PERIOD_OPTIONS: { label: string; value: Period }[] = [
  { label: '24H', value: '24h' },
  { label: '7D', value: '7d' },
  { label: '1M', value: '1m' },
  { label: '3M', value: '3m' },
  { label: '1Y', value: '1y' },
  { label: 'YTD', value: 'ytd' },
  { label: 'All', value: 'all' },
];
