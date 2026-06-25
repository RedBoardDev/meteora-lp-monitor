/**
 * Copy-bot · P2.6 — caps + kill-switch (PURE, no I/O). The safety envelope at the WALLET level:
 * gates the OPENING of a new position (≠ filters, which judge the candidate; here we judge the global state).
 *
 * The kill-switch blocks ONLY entries — exits / reconciliation keep running (spec 06 §1.2:
 * protect funds even with the bot off). The clock (`nowMs`) is injected → pure/testable (sliding window).
 *
 * Defaults (spec 06 §1.1, DECISIONS Round 2): maxOpenPositions 8 (P), 10 opens / 10 min (DECIDED),
 * kill-switches OFF, per-token & total exposure OFF (optional). The loss-per-day cap is ABANDONED
 * as a default (never reintroduced as an active guardrail).
 */

export interface CapsConfig {
  killSwitchGlobal: boolean;
  killSwitchLeader: boolean; // pause the current leader (CLI = a single leader)
  maxOpenPositions: number | null;
  maxConcurrentPerToken: number | null; // global; null = unlimited (default)
  maxOpensPerWindow: number | null;
  windowMinutes: number | null;
  maxTotalExposureSol: number | null; // optional; null = OFF (default)
}

export interface CapsState {
  openPositions: number;
  totalExposureSol: number;
  tokenOpenCount: number; // positions open on the candidate's token
  openTimestampsMs: number[]; // wall-clock ms of ALL our opens (checkCaps filters by window)
}

export type CapVerdict = { action: 'allow' } | { action: 'block'; reason: string };
const block = (reason: string): CapVerdict => ({ action: 'block', reason });
const ALLOW: CapVerdict = { action: 'allow' };

/** "Active envelope" defaults (spec 06 §1.1 / Round 2). */
export const CAPS_DEFAULTS: CapsConfig = {
  killSwitchGlobal: false,
  killSwitchLeader: false,
  maxOpenPositions: 8,
  maxConcurrentPerToken: null,
  maxOpensPerWindow: 10,
  windowMinutes: 10,
  maxTotalExposureSol: null,
};

/** Allows or blocks a NEW opening of size `sizeSol`. First block wins (kill-switch first). Pure. */
export function checkCaps(cfg: CapsConfig, state: CapsState, sizeSol: number, nowMs: number): CapVerdict {
  if (cfg.killSwitchGlobal) return block('kill_switch_global');
  if (cfg.killSwitchLeader) return block('kill_switch_leader');
  if (cfg.maxOpenPositions != null && state.openPositions >= cfg.maxOpenPositions) {
    return block('max_open_positions');
  }
  if (cfg.maxConcurrentPerToken != null && state.tokenOpenCount >= cfg.maxConcurrentPerToken) {
    return block('max_concurrent_per_token');
  }
  if (cfg.maxOpensPerWindow != null && cfg.windowMinutes != null) {
    const since = nowMs - cfg.windowMinutes * 60_000;
    const recent = state.openTimestampsMs.filter((t) => t > since).length;
    if (recent >= cfg.maxOpensPerWindow) return block('max_opens_per_window');
  }
  if (cfg.maxTotalExposureSol != null && state.totalExposureSol + sizeSol > cfg.maxTotalExposureSol) {
    return block('max_total_exposure');
  }
  return ALLOW;
}
