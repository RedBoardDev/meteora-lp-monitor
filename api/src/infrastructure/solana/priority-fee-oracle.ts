/**
 * Copy-bot — LIVE priority-fee oracle. Background-refreshed cache of Helius `getPriorityFeeEstimate` (µLamports/CU
 * per priority level), scoped to DLMM-program activity, so the brain can RAISE a static fee tier during congestion
 * WITHOUT paying an RPC round-trip on the hot path (mirrors BlockhashCache). Defensive by design: a failed poll keeps
 * the last good value, and `get()` returns null until first primed — the caller then falls back to the static tier,
 * so a dead oracle never under-pays nor blocks. The hard SOL cap still bounds whatever this returns.
 * See docs/reference/copybot-settings.md §5.
 *
 * No DLMM SDK (firewall-safe): just an HTTP JSON-RPC POST to the Helius endpoint.
 */
import type { PriorityFeeTier } from '@/domain/copybot/priority-fee';

/** Map each fee TIER to the matching Helius priority level (API identifiers — keep stable). */
const TIER_TO_HELIUS_LEVEL: Record<PriorityFeeTier, string> = { low: 'low', medium: 'medium', high: 'high' };

const DEFAULT_REFRESH_MS = 15_000; // congestion moves on a seconds scale; 15s is responsive yet ~negligible RPC cost

type PriorityFeeLevels = Record<string, number>; // helius result.priorityFeeLevels: { min, low, medium, high, veryHigh, unsafeMax } in µLamports/CU
type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class PriorityFeeOracle {
  private levels: PriorityFeeLevels | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly httpUrl: string,
    private readonly accountKey: string, // scope the estimate to txs touching this account (the DLMM program)
    private readonly refreshMs = DEFAULT_REFRESH_MS,
    private readonly fetchFn: HttpFetch = fetch as unknown as HttpFetch,
  ) {}

  /** Prime once (so `get()` is ready) then refresh in the background; never keep the process alive just for this. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  /** Refresh the cached level map, keeping the last good value on any failure (a transient blip must not blank it). */
  async refresh(): Promise<void> {
    try {
      const res = await this.fetchFn(this.httpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'priority-fee',
          method: 'getPriorityFeeEstimate',
          params: [{ accountKeys: [this.accountKey], options: { includeAllPriorityFeeLevels: true } }],
        }),
      });
      if (!res.ok) return; // keep last good
      const json = (await res.json()) as { result?: { priorityFeeLevels?: PriorityFeeLevels } };
      const lv = json.result?.priorityFeeLevels;
      if (lv && typeof lv === 'object') this.levels = lv;
    } catch {
      /* keep the previous value */
    }
  }

  /** Latest live µLamports/CU for a tier, or null when never primed / the level is missing → caller uses the tier. */
  get(tier: PriorityFeeTier): number | null {
    const v = this.levels?.[TIER_TO_HELIUS_LEVEL[tier]];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
