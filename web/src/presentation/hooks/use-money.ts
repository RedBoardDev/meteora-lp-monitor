'use client';

import { AMOUNT_MASK, usePrefs } from '@/application/stores/prefs-store';
import { useSolUsd } from '@/application/stores/sol-usd-store';
import { fmtPct, fmtSol, fmtSolHero, fmtSolSigned } from '@/domain/format';

/** USD money string: "$45.20" / "-$45.20" / "+$45.20" / "$1,234" (no decimals for large). */
function fmtUsd(n: number, opts?: { signed?: boolean }): string {
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : 2;
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const sign = n < 0 ? '-' : opts?.signed ? '+' : '';
  return `${sign}$${body}`;
}

/**
 * The reactive money-formatting seam. Every on-screen money value renders through this so the
 * "hide amounts" privacy toggle AND the SOL⇄USD display switch apply everywhere, consistently.
 * Returns plain strings (USD bakes in the "$"); `showGlyph` tells callers when to render the ◎ mark.
 */
export function useMoney() {
  const hide = usePrefs((s) => s.hideAmounts);
  const currency = usePrefs((s) => s.currency);
  const rate = useSolUsd((s) => s.rate);
  const usd = currency === 'USD' && rate != null && rate > 0;
  const r = rate ?? 0;
  return {
    hide,
    usd,
    /** render the ◎ unit mark only in SOL mode — in USD the "$" is already in the string. */
    showGlyph: currency === 'SOL',
    /** Bare amount (optionally signed), in the active currency. */
    sol: (n: number, opts?: { signed?: boolean; decimals?: number }): string =>
      hide
        ? AMOUNT_MASK
        : usd
          ? fmtUsd(n * r, { signed: opts?.signed })
          : opts?.signed
            ? fmtSolSigned(n, opts.decimals)
            : fmtSol(n, opts?.decimals),
    /** Hero amount with thousands separators, in the active currency. */
    hero: (n: number): string => (hide ? AMOUNT_MASK : usd ? fmtUsd(n * r) : fmtSolHero(n)),
    /** Percentage (currency-agnostic; masked under hide). */
    pct: (n: number): string => (hide ? AMOUNT_MASK : fmtPct(n)),
  };
}
