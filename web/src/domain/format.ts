/** Pure presentation formatters. No React, no side effects — safe on server and client. */

/** Bare SOL amount — the unit (◎) is shown contextually (hero/labels), not on every number. */
export function fmtSol(value: number, decimals = 3): string {
  return value.toFixed(decimals);
}

/** Hero SOL amount with thousands separators (e.g. "1,234.567") for large headline figures. */
export function fmtSolHero(value: number, decimals = 3): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Signed SOL amount with an explicit + for gains (PnL, fees). */
export function fmtSolSigned(value: number, decimals = 3): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}`;
}

export function fmtPct(value: number, decimals = 1): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

/** Adaptive token amount: more precision for small numbers, thousands separators for large. */
export function fmtAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 0.0001) return value.toFixed(4);
  return value.toExponential(2);
}

/** Compact duration from seconds: "2d 4h", "3h 12m", "45m", "12s". */
export function fmtDuration(totalSeconds: number | null): string {
  if (totalSeconds == null || totalSeconds < 0) return '—';
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Relative time from an epoch-ms instant: "just now", "5m ago", "3h ago", "2d ago". */
export function fmtRelative(epochMs: number | null, nowMs: number): string {
  if (epochMs == null) return '—';
  const diff = Math.max(0, nowMs - epochMs);
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtDateTime(epochMs: number | null): string {
  if (epochMs == null) return '—';
  return new Date(epochMs).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtDate(epochMs: number | null): string {
  if (epochMs == null) return '—';
  return new Date(epochMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Like fmtDate but with the year — used in chart tooltips, whose curves span multiple years. */
export function fmtDateFull(epochMs: number | null): string {
  if (epochMs == null) return '—';
  return new Date(epochMs).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Truncate a base58 address for display: "HXUi…E5a6y". */
export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

const RANGE_LABEL: Record<string, string> = {
  in: 'In range',
  out_up: 'Above range',
  out_down: 'Below range',
  unknown: '—',
};

export function rangeLabel(status: string): string {
  return RANGE_LABEL[status] ?? '—';
}
