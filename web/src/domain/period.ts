export type Period = '24h' | '7d' | '30d' | 'all';

const WINDOW_MS: Record<Period, number> = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
  all: 0,
};

/** Epoch-ms floor for a period (0 = all-time). Pass `now` from the caller (avoids render-time clocks). */
export function sinceMs(period: Period, now: number): number {
  const w = WINDOW_MS[period];
  return w === 0 ? 0 : now - w;
}

/** Window length in days for the wallet PnL curve (all-time capped to the on-chain history we page). */
export function periodDays(period: Period): number {
  switch (period) {
    case '24h':
      return 1;
    case '7d':
      return 7;
    case '30d':
      return 30;
    default:
      // 'all' — span the whole chain (~10y > Solana's age). The curve stops at the wallet's actual
      // first tx, so this is effectively "no limit": it covers ANY wallet whatever its age.
      return 3650;
  }
}

export const PERIOD_OPTIONS: { label: string; value: Period }[] = [
  { label: '24H', value: '24h' },
  { label: '7D', value: '7d' },
  { label: '30D', value: '30d' },
  { label: 'All', value: 'all' },
];
