/**
 * Copy-bot · process status / heartbeat — PURE (no I/O).
 *
 * Each process upserts a heartbeat row periodically; the web derives online/offline from how fresh that row is,
 * NOT from a stored boolean (a crashed process can't flip a flag to false — staleness is the only honest signal).
 */
import type { JournalProcess } from './journal';

export type StatusProcess = JournalProcess; // 'brain' | 'coffre'

export const HEARTBEAT_INTERVAL_MS = 10_000; // how often each process beats
export const HEARTBEAT_STALE_MS = 30_000; // a process silent longer than this (≈3 missed beats) is offline

// `type` (not `interface`) so these payloads satisfy the adapter's `Record<string, unknown>` jsonb param directly.
/** Brain heartbeat payload (rendered by the web). */
export type BrainStatusDetail = {
  leader: string;
  openPositions: number;
  exposureSol: number;
  lastActionAt: number | null; // ms of the last build+publish, or null if none yet
  lastLatencyMs: number | null; // brainMs of that last action
};

/** Coffre heartbeat payload. */
export type CoffreStatusDetail = {
  signingEnabled: boolean;
};

/**
 * A process is online iff it beat within the stale window. `null` (never beat) ⇒ offline. Pure.
 * Boundary is inclusive (a beat exactly `staleMs` ago still counts as online) so the edge doesn't flap.
 */
export function isOnline(lastBeatMs: number | null, nowMs: number, staleMs: number = HEARTBEAT_STALE_MS): boolean {
  return lastBeatMs !== null && nowMs - lastBeatMs <= staleMs;
}
