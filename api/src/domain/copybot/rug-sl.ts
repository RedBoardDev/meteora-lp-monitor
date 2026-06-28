/**
 * Copy-bot · rug-SL — PURE crash-detection decider (no I/O). The one safety exit independent of the leader: close
 * if the token price drops ≥ `dropPercent` within `windowSeconds`. Fed a rolling price window (collected by the
 * brain from the DLMM active-bin price — no extra RPC). See docs/reference/copybot-settings.md §7.
 */
export interface RugSlConfig {
  /** Master toggle for this safety exit (default on). */
  enabled: boolean;
  /** Drop threshold, percent of the recent-window high (e.g. 40 = a −40% crash). */
  dropPercent: number;
  /** Lookback window the drop is measured over, in seconds. */
  windowSeconds: number;
}

/** One observed price sample. */
export interface PricePoint {
  ts: number; // epoch ms
  price: number; // token price in SOL (or any consistent unit)
}

/**
 * Whether the price has crashed by ≥ `dropPercent` from its high over the last `windowSeconds`. Compares the latest
 * sample to the window's high (a drop FROM a recent high = a rug). Needs ≥ 2 samples in-window; a rising price or a
 * non-positive threshold never triggers. Pure.
 */
export function decideRugSl(window: PricePoint[], cfg: RugSlConfig, nowMs: number): boolean {
  if (!cfg.enabled || cfg.dropPercent <= 0) return false;
  const cutoff = nowMs - cfg.windowSeconds * 1000;
  const recent = window.filter((p) => p.ts >= cutoff);
  if (recent.length < 2) return false; // need a prior high to measure a drop against
  const high = Math.max(...recent.map((p) => p.price));
  if (high <= 0) return false;
  const latest = recent.reduce((a, b) => (b.ts >= a.ts ? b : a)).price;
  const dropFraction = (high - latest) / high;
  return dropFraction >= cfg.dropPercent / 100;
}

/**
 * Per-position rolling price windows + crash check. Pure (in-memory, no I/O): the brain feeds it the DLMM
 * active-bin price on a cadence (`record`), then asks `check` whether a position has rugged. Each window is pruned
 * to `retainMs` so it never grows unbounded; `forget` frees a window when its position closes.
 */
export class RugSlTracker {
  private readonly windows = new Map<string, PricePoint[]>();

  constructor(private readonly retainMs: number) {}

  /** Append a price sample for `key` (our position pubkey) and prune samples older than `retainMs`. */
  record(key: string, price: number, nowMs: number): void {
    const next = [...(this.windows.get(key) ?? []), { ts: nowMs, price }].filter((p) => nowMs - p.ts <= this.retainMs);
    this.windows.set(key, next);
  }

  /** Whether `key` has crashed by ≥ `cfg.dropPercent` within `cfg.windowSeconds`. */
  check(key: string, cfg: RugSlConfig, nowMs: number): boolean {
    return decideRugSl(this.windows.get(key) ?? [], cfg, nowMs);
  }

  /** Drop a position's window (call on close so a re-opened SAME pubkey never reuses stale prices, and to free RAM). */
  forget(key: string): void {
    this.windows.delete(key);
  }
}
