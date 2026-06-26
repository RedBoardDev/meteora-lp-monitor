/**
 * CreditMeter — the credit-precise telemetry foundation of the near-zero-RPC watcher.
 *
 * Every billable Helius call is reported via `record()`; the meter attributes its CREDIT cost (not just
 * a call count) per exact method, per code path, and per wallet, keeps a bounded ring of recent calls
 * for a live feed, and derives pure anomaly + kill-switch signals from a rolling 60s window and a
 * per-(wallet, UTC-day) sum. It holds NO I/O — the clock is injected so all time-based logic is unit
 * testable, and the in-memory ledger is the source of truth for `/debug/rpc` (the DB rollup is Step 2).
 *
 * Credit costs are the Helius credit model (docs/research/near-zero-watcher-PLAN.md → "Helius credit
 * model" table). Each entry below cites that table.
 */

/** Per-method credit cost — Helius credit model. `default` covers any std JSON-RPC method not listed. */
export const CREDIT_COST: Record<string, number> = {
  getProgramAccounts: 10, // legacy gPA — 10 credits (Helius credit model)
  getProgramAccountsV2: 1, // paginated gPA — 1 credit (Helius credit model)
  getMultipleAccounts: 1, // ≤100 accounts — 1 credit (Helius credit model)
  getAccountInfo: 1, // 1 credit (Helius credit model)
  getSignaturesForAddress: 1, // 1 credit (Helius credit model)
  getTransaction: 1, // 1 credit (Helius credit model)
  getParsedTransaction: 1, // 1 credit (Helius credit model)
  sendTransaction: 1, // 1 credit (Helius credit model)
  getBalance: 1, // 1 credit (Helius credit model)
  getLatestBlockhash: 1, // 1 credit (Helius credit model)
  das: 10, // DAS getAsset* — 10 credits (Helius credit model)
  enhancedTx: 100, // Enhanced Transactions API — 100 credits (Helius credit model)
  default: 1, // std JSON-RPC — 1 credit (Helius credit model)
};

// WebSocket billing — Helius credit model: 1 credit to open + 20 credits per (started) MB streamed.
const WS_OPEN_CREDITS = 1; // 1 credit to open a subscription (Helius credit model)
const WS_CREDITS_PER_MB = 20; // 20 credits per MB of streamed data (Helius credit model)
const BYTES_PER_MB = 1_000_000;

/** WebSocket credit cost for `bytes` of streamed data — 1 to open + 20/MB (Helius credit model). */
export function wsCredits(bytes: number): number {
  return WS_OPEN_CREDITS + Math.ceil(Math.max(0, bytes) / BYTES_PER_MB) * WS_CREDITS_PER_MB;
}

const MS_PER_DAY = 86_400_000; // UTC-day bucket width for per-wallet daily budgets
const ROLLING_WINDOW_MS = 60_000; // rolling 60s window for the per-minute credit rules
const RING_CAPACITY = 2000; // bounded recent-call ring (live feed); oldest evicted past this
const RING_TAIL = 50; // entries `stats()` exposes as the live tail

// ── Default thresholds (constructor-overridable so tests use tiny values) ──────────────────────────
// The Helius Developer plan allows 10,000,000 credits/month ≈ 231 credits/min sustained. The defaults
// sit well above legitimate steady-state (idle target < ~50 credits/day per wallet) yet far below the
// burst that drained the key in the prod incident (~$1/min ≈ Enhanced re-paging), so a regression to
// that pattern trips loudly. All three are knobs — env-driven production tuning lives in composition.
const ALARM_CREDITS_PER_MIN = 2_000; // ~10× the sustainable steady rate → flag a credit burst
const GLOBAL_KILL_CREDITS_PER_MIN = 10_000; // hard breaker: sustained, this exhausts the month in <1 day
const WALLET_DAILY_BUDGET = 5_000; // > the ~4,300/day a single wallet cost on the OLD bad path → catches it

export type Severity = 'low' | 'medium' | 'high';

export interface Anomaly {
  kind: 'enhanced-used' | 'legacy-gpa' | 'credits-per-min-over' | 'wallet-daily-budget';
  detail: string;
  severity: Severity;
}

/** A single recorded call, kept in the bounded ring for the live feed. */
export interface RingEntry {
  at: number;
  method: string;
  codePath: string;
  wallet: string | null;
  credits: number;
  ok: boolean;
  /** true for a kill-switch-blocked call that was NEVER issued (0 credits) — distinct from a real call. */
  blocked?: boolean;
}

export interface CreditStats {
  totalCredits: number;
  totalCalls: number;
  byMethod: Record<string, number>;
  byCodePath: Record<string, number>;
  byWallet: Record<string, number>;
  ringTail: RingEntry[];
}

/** A per-(UTC-day, exact method, wallet, code path) credit delta — the unit the 60s flush appends to the
 *  `rpc_credit_daily` rollup. `wallet` is '' when the call isn't attributable to a wallet (so it maps
 *  straight onto that table's columns + PK). */
export interface CreditFlushRow {
  day: number;
  method: string;
  wallet: string;
  codePath: string;
  calls: number;
  credits: number;
}

export interface RecordOpts {
  wallet?: string;
  codePath?: string;
  /** When set, the cost is `wsCredits(bytes)` instead of the per-method map (WebSocket accounting). */
  bytes?: number;
  ok?: boolean;
}

export interface CreditMeterThresholds {
  alarmCreditsPerMin?: number;
  globalKillCreditsPerMin?: number;
  walletDailyBudget?: number;
}

/** UTC-day index for `at` (ms) — the per-wallet daily budget bucket. */
const utcDay = (at: number): number => Math.floor(at / MS_PER_DAY);

export class CreditMeter {
  private totalCredits = 0;
  private totalCalls = 0;
  private readonly byMethod: Record<string, number> = {};
  private readonly byCodePath: Record<string, number> = {};
  private readonly byWallet: Record<string, number> = {};
  // Bounded live-feed ring; oldest entries are evicted once it exceeds RING_CAPACITY.
  private readonly ring: RingEntry[] = [];
  // Rolling 60s window of {at, credits} for the per-minute rules — pruned on each read by the clock.
  private window: { at: number; credits: number }[] = [];
  // Per wallet: ONLY its current UTC day's running credit sum (reset when the day rolls) → bounded to
  // the number of wallets, no unbounded history kept in memory.
  private readonly walletDay = new Map<string, { day: number; credits: number }>();
  // Per-(day,method,wallet,codePath) deltas accumulated SINCE the last drainForFlush() — the DB-flush
  // buffer. Distinct from the cumulative counters above: a drain resets ONLY this, never stats().
  private flushBuffer = new Map<string, CreditFlushRow>();

  private readonly alarmCreditsPerMin: number;
  private readonly globalKillCreditsPerMin: number;
  private readonly walletDailyBudget: number;

  constructor(
    private readonly now: () => number = () => Date.now(),
    thresholds: CreditMeterThresholds = {},
  ) {
    this.alarmCreditsPerMin = thresholds.alarmCreditsPerMin ?? ALARM_CREDITS_PER_MIN;
    this.globalKillCreditsPerMin =
      thresholds.globalKillCreditsPerMin ?? GLOBAL_KILL_CREDITS_PER_MIN;
    this.walletDailyBudget = thresholds.walletDailyBudget ?? WALLET_DAILY_BUDGET;
  }

  /** Credit cost for a recorded call — WebSocket bytes when given, else the per-method map (or default). */
  private creditsFor(method: string, opts: RecordOpts): number {
    if (opts.bytes != null) return wsCredits(opts.bytes);
    return CREDIT_COST[method] ?? CREDIT_COST.default!;
  }

  /** Record one billable call: add its credits to every cumulative counter + the rolling structures. */
  record(method: string, opts: RecordOpts = {}): void {
    const at = this.now();
    const credits = this.creditsFor(method, opts);
    const codePath = opts.codePath ?? 'unknown';
    const wallet = opts.wallet ?? null;

    this.totalCredits += credits;
    this.totalCalls += 1;
    this.byMethod[method] = (this.byMethod[method] ?? 0) + credits;
    this.byCodePath[codePath] = (this.byCodePath[codePath] ?? 0) + credits;
    if (wallet) {
      this.byWallet[wallet] = (this.byWallet[wallet] ?? 0) + credits;
      this.bumpWalletDay(wallet, credits, at);
    }

    this.pushRing({ at, method, codePath, wallet, credits, ok: opts.ok ?? true });
    this.window.push({ at, credits });
    this.pruneWindow(at);
    this.bumpFlush(at, method, wallet, codePath, credits);
  }

  /** Record a kill-switch-blocked call that was NEVER issued — counted (0 credits) for the live feed only. */
  recordBlocked(method: string, opts: { wallet?: string; codePath?: string } = {}): void {
    this.totalCalls += 1;
    this.pushRing({
      at: this.now(),
      method,
      codePath: opts.codePath ?? 'unknown',
      wallet: opts.wallet ?? null,
      credits: 0,
      ok: false,
      blocked: true,
    });
  }

  /** Cumulative credit ledger + the recent live tail — the payload behind `/debug/rpc`. */
  stats(): CreditStats {
    return {
      totalCredits: this.totalCredits,
      totalCalls: this.totalCalls,
      byMethod: { ...this.byMethod },
      byCodePath: { ...this.byCodePath },
      byWallet: { ...this.byWallet },
      ringTail: this.ring.slice(-RING_TAIL),
    };
  }

  /** The per-(day,method,wallet,codePath) credit deltas accumulated SINCE the previous drain, then RESET
   *  the buffer (the cumulative stats() counters are untouched). The 60s timer flushes these into the
   *  `rpc_credit_daily` rollup; a drain with no new calls since the last one returns [] (so the timer
   *  never re-writes an already-persisted window). */
  drainForFlush(): CreditFlushRow[] {
    const rows = [...this.flushBuffer.values()];
    this.flushBuffer.clear();
    return rows;
  }

  /** Pure anomaly signals derived from the cumulative ledger + the rolling window + the per-day sums. */
  anomalies(): Anomaly[] {
    const out: Anomaly[] = [];
    // Enhanced API is BANNED from steady-state (100 credits/call drained the key) — any use is a flag.
    if ((this.byMethod.enhancedTx ?? 0) > 0) {
      out.push({
        kind: 'enhanced-used',
        detail: `enhancedTx credits=${this.byMethod.enhancedTx}`,
        severity: 'high',
      });
    }
    // Legacy getProgramAccounts is 10× getProgramAccountsV2 — its presence on a recurring path is waste.
    if ((this.byMethod.getProgramAccounts ?? 0) > 0) {
      out.push({
        kind: 'legacy-gpa',
        detail: `getProgramAccounts credits=${this.byMethod.getProgramAccounts}`,
        severity: 'medium',
      });
    }
    const rpm = this.rollingCredits();
    if (rpm > this.alarmCreditsPerMin) {
      out.push({
        kind: 'credits-per-min-over',
        detail: `${rpm} > ${this.alarmCreditsPerMin} credits/min`,
        severity: 'high',
      });
    }
    const today = utcDay(this.now());
    for (const [wallet, wd] of this.walletDay) {
      if (wd.day === today && wd.credits > this.walletDailyBudget) {
        out.push({
          kind: 'wallet-daily-budget',
          detail: `${wallet} ${wd.credits} > ${this.walletDailyBudget} credits/day`,
          severity: 'high',
        });
      }
    }
    return out;
  }

  /**
   * Kill-switch: true when recurring RPC must HALT — the rolling-60s global credits breached the hard
   * breaker, OR (when a wallet is given) that wallet's UTC-day sum breached its daily budget. Callers
   * skip the call instead of crashing, so a runaway burst can't drain the key.
   */
  shouldBlock(wallet?: string): boolean {
    if (this.rollingCredits() > this.globalKillCreditsPerMin) return true;
    if (wallet) {
      const wd = this.walletDay.get(wallet);
      if (wd && wd.day === utcDay(this.now()) && wd.credits > this.walletDailyBudget) return true;
    }
    return false;
  }

  /** Sum of credits within the trailing ROLLING_WINDOW_MS as of the injected clock (prunes stale entries). */
  private rollingCredits(): number {
    this.pruneWindow(this.now());
    let sum = 0;
    for (const e of this.window) sum += e.credits;
    return sum;
  }

  private pruneWindow(at: number): void {
    const floor = at - ROLLING_WINDOW_MS;
    let i = 0;
    while (i < this.window.length && this.window[i]!.at <= floor) i++;
    if (i > 0) this.window = this.window.slice(i);
  }

  private bumpWalletDay(wallet: string, credits: number, at: number): void {
    const day = utcDay(at);
    const cur = this.walletDay.get(wallet);
    if (!cur || cur.day !== day) this.walletDay.set(wallet, { day, credits });
    else cur.credits += credits;
  }

  /** Accumulate one call into the flush buffer under its (day,method,wallet,codePath) key. A null wallet
   *  maps to '' (matches the rpc_credit_daily column default). Blocked calls are excluded — they were
   *  never issued, so they belong in the live feed, not the spend rollup. */
  private bumpFlush(
    at: number,
    method: string,
    wallet: string | null,
    codePath: string,
    credits: number,
  ): void {
    const day = utcDay(at);
    const w = wallet ?? '';
    const key = `${day} ${method} ${w} ${codePath}`;
    const cur = this.flushBuffer.get(key);
    if (cur) {
      cur.calls += 1;
      cur.credits += credits;
    } else {
      this.flushBuffer.set(key, { day, method, wallet: w, codePath, calls: 1, credits });
    }
  }

  private pushRing(entry: RingEntry): void {
    this.ring.push(entry);
    if (this.ring.length > RING_CAPACITY) this.ring.shift();
  }
}
