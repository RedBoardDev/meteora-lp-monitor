import type { RateLimitedQueue } from './rate-limited-queue';

/** A closed position as LPAgent reports it — PnL with the residual valued at market price. */
export interface LpAgentClosed {
  positionAddress: string;
  pnlSol: number; // pnlNative = outputNative + feeNative - inputNative
  feesSol: number; // collectedFeeNative
  depositSol: number; // inputNative
  withdrawSol: number; // outputNative (residual valued at market)
  closedAt: number | null; // ms — used to bound the history backfill to a floor date
}

const PAGE_LIMIT = 100; // LPAgent caps actual page size (~10); we just take what it returns
const MAX_429_RETRIES = 4;
const DEFAULT_429_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function mapRow(r: Record<string, unknown>): LpAgentClosed | null {
  const addr = r.tokenId ?? r.position;
  const pnlBlock = r.pnl as Record<string, unknown> | undefined;
  const pnl = pnlBlock?.valueNative ?? r.pnlNative;
  if (typeof addr !== 'string' || pnl == null) return null;
  const closeAt = r.closeAt ?? r.close_At;
  const closedMs = typeof closeAt === 'string' ? Date.parse(closeAt) : Number.NaN;
  return {
    positionAddress: addr,
    pnlSol: num(pnl),
    feesSol: num(r.collectedFeeNative ?? r.feeNative),
    depositSol: num(r.inputNative),
    withdrawSol: num(r.outputNative),
    closedAt: Number.isNaN(closedMs) ? null : closedMs,
  };
}

/** Reads an owner's closed-position PnL from LPAgent. All calls are throttled by the shared queue. */
export class LpAgentGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly queue: RateLimitedQueue,
  ) {}

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  /** One page of an owner's closed history (most recent first). `priority` orders it in the queue. */
  async fetchHistoricalPage(
    owner: string,
    page: number,
    priority: number,
  ): Promise<{ rows: LpAgentClosed[]; totalPages: number }> {
    const url = `${this.baseUrl}/open-api/v1/lp-positions/historical?owner=${owner}&page=${page}&limit=${PAGE_LIMIT}`;
    return this.queue.enqueue(async () => {
      // The key's real rate limit is stricter/burstier than the configured spacing — absorb 429s
      // here (respecting Retry-After) so a page is never lost, rather than throwing to the caller.
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { headers: { 'x-api-key': this.apiKey } });
        if (res.status === 429 && attempt < MAX_429_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after')) * 1000;
          await sleep(retryAfter > 0 ? retryAfter : DEFAULT_429_WAIT_MS);
          continue;
        }
        if (!res.ok) throw new Error(`LPAgent ${res.status}`);
        const json = (await res.json()) as { data?: unknown };
        const data = (json.data ?? {}) as Record<string, unknown>;
        const list = (Array.isArray(data.data) ? data.data : []) as Record<string, unknown>[];
        const pagination = (data.pagination ?? {}) as Record<string, unknown>;
        const rows = list.map(mapRow).filter((r): r is LpAgentClosed => r != null);
        return { rows, totalPages: num(pagination.totalPages) || 1 };
      }
    }, priority);
  }
}
