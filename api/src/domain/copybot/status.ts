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
  // Detection-liveness (observability). The cursor poll + reconcile sweep run on setInterval with LOG-ONLY
  // `.catch` handlers: if they throw forever (a revoked RPC key, an auth outage, a permanently-throwing poll) the
  // bot goes silently BLIND to leader events — including closes — while this heartbeat keeps the web GREEN. These
  // fields surface detection health so a stalled detector is both visible and alertable. OPTIONAL (defaulted where
  // read) so pre-existing persisted jsonb rows without them stay backward-compatible.
  wsConnected?: boolean; // last-known WS trigger connectivity (sub.isConnected())
  lastPollAt?: number | null; // ms of the last SUCCESSFUL cursor poll, or null if none yet
  lastReconcileAt?: number | null; // ms of the last SUCCESSFUL reconcile sweep, or null if none yet
  pollFailures?: number; // CONSECUTIVE poll failures (reset to 0 on a success)
  reconcileFailures?: number; // CONSECUTIVE reconcile failures (reset to 0 on a success)
};

/** Consecutive poll OR reconcile failures after which the detector is assumed BLIND and the operator is alerted. */
export const DETECTION_STALE_FAILURES = 3; // ~3 missed cycles ⇒ not a transient blip; a persistent RPC/key outage

/**
 * Should we raise the pinned detection-stale operator alert NOW? Pure. True iff detection is not already flagged
 * (`alreadyAlerted` gates it to ONCE per stale episode) AND either loop has failed `threshold` times in a row.
 * The caller sets its own `alerted` flag on a true result and re-arms it via `detectionHealthy` on recovery.
 */
export function shouldAlertDetectionStale(
  pollFailures: number,
  reconcileFailures: number,
  alreadyAlerted: boolean,
  threshold: number = DETECTION_STALE_FAILURES,
): boolean {
  return !alreadyAlerted && (pollFailures >= threshold || reconcileFailures >= threshold);
}

/** Detection is healthy again iff BOTH loops have a zeroed consecutive-failure counter. Pure. Re-arms the alert. */
export function detectionHealthy(pollFailures: number, reconcileFailures: number): boolean {
  return pollFailures === 0 && reconcileFailures === 0;
}

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
