/**
 * Copy-bot — alert on critical failure (a sell/close that fails, loop crash, etc.). Error-level log +
 * optional webhook (`ALERT_WEBHOOK`). NEVER throws (a failing alert must not break the bot).
 * Always an "emergency": we warn, we don't die.
 *
 * P1 SHIM (SPEC §8): `alert()` keeps its `(log, msg, ctx)` signature (so the 13 call sites are untouched until
 * P2) AND its error-log + webhook POST, but when the boot has bound a process `CopyEvents` (`bindAlertEvents`) it
 * ALSO persists a `pinned` event so the alert is durably journaled, tenant-tagged, and feed-visible — the
 * user-reaching guarantee (SPEC §6). Until P2 maps each call site to its precise code, every alert lands on the
 * generic pinned `failsafe.failed` ("close/verify manually"), which is exactly what an alert means to the user.
 */
import type { Logger } from 'pino';
import type { CopyEvents } from './observability/copy-events';

/** The generic pinned code a P1 alert maps to — feed-visible "close manually", durably persisted (SPEC §6). */
const ALERT_CODE = 'failsafe.failed' as const;

/**
 * Process-global emitter binding (mono-process boot). The boot calls `bindAlertEvents(events)` once; `alert()`
 * then persists through it. Absent ⇒ legacy behavior only (log + webhook), so an un-bound test/path still works.
 */
let boundEvents: CopyEvents | null = null;

/** Bind the process `CopyEvents` so subsequent `alert()` calls also persist a pinned, feed-visible row (SPEC §8). */
export function bindAlertEvents(events: CopyEvents): void {
  boundEvents = events;
}

export async function alert(log: Logger, msg: string, ctx: Record<string, unknown> = {}): Promise<void> {
  log.error(ctx, `🚨 ALERT: ${msg}`);

  // Durably journal the alert as a pinned, feed-visible event when an emitter is bound. NEVER throws (the emitter's
  // shim path swallows internally), and we still proceed to the webhook even if the binding is absent (loop guard).
  if (boundEvents) {
    boundEvents.recordAssembled({
      code: ALERT_CODE,
      severity: 'error',
      category: 'FAILSAFE',
      audience: 'feed',
      pinned: true,
      ts: Date.now(),
      eventTs: Date.now(),
      ctx: boundEvents.context,
      stage: 'failsafe',
      outcome: 'failed',
      reason: msg, // verbatim message → P2 maps each site to a precise code; today it is the alert headline
      adminDetail: ctx,
    });
  }

  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg, ...ctx, ts: Date.now() }) });
  } catch (e) {
    log.warn({ e: (e as Error).message }, 'alert webhook failed');
  }
}
