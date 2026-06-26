/**
 * RPC / credit telemetry — the shape of `GET /debug/rpc` plus pure shaping helpers for the owner panel.
 * No React, no I/O: every transform here is deterministic so it can be reasoned about (and tested) in
 * isolation from the polling component. Mirrors the API's CreditMeter (`stats()`/`anomalies()`) and the
 * durable rollup row (`RpcCreditLedgerRepository.since()`).
 */

/** UTC-day bucket width — `day` = floor(ms / MS_PER_DAY), matching the API CreditMeter's day key. */
const MS_PER_DAY = 86_400_000;

export type RpcSeverity = 'low' | 'medium' | 'high';

/** One recorded call from the meter's bounded ring (the live feed). `credits === 0 && blocked` ⇒ a
 *  kill-switch-skipped call that was never issued. */
export interface RpcRingEntry {
  at: number;
  method: string;
  codePath: string;
  wallet: string | null;
  credits: number;
  ok: boolean;
  blocked?: boolean;
}

/** Cumulative credit ledger (since the API process booted) + the recent live tail. */
export interface RpcCreditStats {
  totalCredits: number;
  totalCalls: number;
  byMethod: Record<string, number>;
  byCodePath: Record<string, number>;
  byWallet: Record<string, number>;
  ringTail: RpcRingEntry[];
}

export interface RpcAnomaly {
  kind: 'enhanced-used' | 'legacy-gpa' | 'credits-per-min-over' | 'wallet-daily-budget';
  detail: string;
  severity: RpcSeverity;
}

/** One persisted rollup bucket — per (UTC-day, method, wallet, codePath). */
export interface RpcCreditLedgerRow {
  day: number;
  method: string;
  wallet: string;
  codePath: string;
  calls: number;
  credits: number;
}

/** The full `GET /debug/rpc` response (owner only). */
export interface RpcTelemetry {
  stats: RpcCreditStats;
  anomalies: RpcAnomaly[];
  killSwitch: { blockingNow: boolean };
  /** Durable per-day spend for the last-7d window — newest day first. Absent if the API omits it. */
  last7d?: RpcCreditLedgerRow[];
}

/** How credit-expensive a method is, for the at-a-glance highlight. */
export type CreditWeight = 'normal' | 'heavy' | 'banned';

/**
 * Per-method Helius credit weight — mirrors the API's CREDIT_COST so the panel flags the same costly
 * calls the meter does. `banned` = forbidden from steady-state (drained the key); `heavy` = a cheaper
 * paginated/DAS-free alternative exists. Everything else is `normal` (1 credit/call).
 */
const HEAVY_METHODS: Record<string, CreditWeight> = {
  enhancedTx: 'banned', // Enhanced Transactions API — 100 credits/call, BANNED from steady-state
  getProgramAccounts: 'heavy', // legacy gPA — 10 credits/call (use getProgramAccountsV2 = 1)
  das: 'heavy', // DAS getAsset* — 10 credits/call
};

/** Credit weight for a method name (drives the bar/feed colour). Unknown ⇒ `normal`. */
export function methodWeight(method: string): CreditWeight {
  return HEAVY_METHODS[method] ?? 'normal';
}

/** Badge tone for an anomaly severity (high = loss/red, medium = warn/amber, low = neutral). */
export function severityTone(severity: RpcSeverity): 'loss' | 'warn' | 'neutral' {
  if (severity === 'high') return 'loss';
  if (severity === 'medium') return 'warn';
  return 'neutral';
}

export interface CreditEntry {
  key: string;
  credits: number;
}

/** A `Record<key, credits>` as entries sorted by credits desc (ties broken by key for stable output). */
export function sortedByCredits(rec: Record<string, number>): CreditEntry[] {
  return Object.entries(rec)
    .map(([key, credits]) => ({ key, credits }))
    .sort((a, b) => b.credits - a.credits || a.key.localeCompare(b.key));
}

/** Largest credit value across entries — the denominator for bar widths (0 ⇒ empty). */
export function maxCredits(entries: CreditEntry[]): number {
  return entries.reduce((m, e) => Math.max(m, e.credits), 0);
}

export interface DailyCredit {
  day: number;
  dayMs: number;
  credits: number;
  calls: number;
}

/** Collapse the rollup rows into one bucket per UTC day (summing across method/wallet/codePath),
 *  ascending by day so the trend reads left→right (oldest→newest). `dayMs` is that day's UTC midnight. */
export function aggregateDailyCredits(rows: RpcCreditLedgerRow[]): DailyCredit[] {
  const byDay = new Map<number, DailyCredit>();
  for (const r of rows) {
    const cur = byDay.get(r.day);
    if (cur) {
      cur.credits += r.credits;
      cur.calls += r.calls;
    } else {
      byDay.set(r.day, {
        day: r.day,
        dayMs: r.day * MS_PER_DAY,
        credits: r.credits,
        calls: r.calls,
      });
    }
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

/** Today's credits + calls from the durable rollup (the UTC-day bucket for `nowMs`). When the rollup is
 *  unavailable, this is empty — the caller falls back to the session totals. */
export function todayTotals(
  last7d: RpcCreditLedgerRow[] | undefined,
  nowMs: number,
): { credits: number; calls: number } {
  const today = Math.floor(nowMs / MS_PER_DAY);
  let credits = 0;
  let calls = 0;
  for (const r of last7d ?? []) {
    if (r.day === today) {
      credits += r.credits;
      calls += r.calls;
    }
  }
  return { credits, calls };
}
