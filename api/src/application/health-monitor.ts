import type { SourceHealth, SourceStatus } from '@meteora/shared';
import type { HealthReporter } from '@/domain/ports';

const DOWN_THRESHOLD = 3; // consecutive failures before a source is reported "down"

/**
 * Per-source health with a simple circuit breaker: a source goes `lagging` on the first failure and
 * `down` after `downThreshold` consecutive failures; any success resets it to `ok`. Callers keep their
 * own last-good data (the engine never discards the last snapshot/positions on error) — this just makes
 * WHY the live indicator is degraded visible per service (rpc / meteora / jupiter / ws).
 */
export class HealthMonitor implements HealthReporter {
  private readonly sources = new Map<string, SourceHealth>();
  private chainTip: number | null = null;

  constructor(private readonly downThreshold = DOWN_THRESHOLD) {}

  /** A programmatic call's outcome (rpc/meteora/jupiter). */
  record(source: string, ok: boolean, detail?: string): void {
    const s = this.ensure(source);
    if (ok) {
      s.status = 'ok';
      s.lastOkAt = Date.now();
      s.consecutiveErrors = 0;
      s.detail = null;
    } else {
      s.consecutiveErrors += 1;
      s.lastErrorAt = Date.now();
      s.detail = detail ?? s.detail;
      s.status = s.consecutiveErrors >= this.downThreshold ? 'down' : 'lagging';
    }
  }

  /** A directly-observed state (e.g. ws connectivity) — no breaker counting. */
  set(source: string, status: SourceStatus, detail?: string): void {
    const s = this.ensure(source);
    if (status === 'ok') {
      s.lastOkAt = Date.now();
      s.consecutiveErrors = 0;
    } else {
      s.lastErrorAt = Date.now();
    }
    s.status = status;
    s.detail = status === 'ok' ? null : (detail ?? s.detail);
  }

  setChainTip(slot: number): void {
    this.chainTip = slot;
  }
  get chainTipSlot(): number | null {
    return this.chainTip;
  }

  list(): SourceHealth[] {
    return [...this.sources.values()];
  }

  /** Overall ok = no recorded source is down. */
  get ok(): boolean {
    return this.list().every((s) => s.status !== 'down');
  }

  /** Status of one source (for back-compat fields like `meteoraOk`); `ok` if never recorded. */
  statusOf(source: string): SourceStatus {
    return this.sources.get(source)?.status ?? 'ok';
  }

  private ensure(source: string): SourceHealth {
    let s = this.sources.get(source);
    if (!s) {
      s = {
        name: source,
        status: 'ok',
        lastOkAt: null,
        lastErrorAt: null,
        consecutiveErrors: 0,
        detail: null,
      };
      this.sources.set(source, s);
    }
    return s;
  }
}
