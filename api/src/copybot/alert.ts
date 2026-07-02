/**
 * Copy-bot — external alert channel (the out-of-band `ALERT_WEBHOOK` POST).
 *
 * Operator-actionable failures ("VERIFY/CLOSE MANUALLY": a definitive sign/land failure, `failsafe.failed`,
 * `lifecycle.*_failed`, `swap.failed_after_retries`, …) are the `pinned` `CopyEvent`s. They are journaled durably +
 * mirrored to pino by `CopyEvents.emit`; this helper reconnects the SAME set to the external webhook so an operator
 * is paged out-of-band. It is injected as `CopyEvents`' optional `alertSink` at boot (brain + coffre).
 *
 * NEVER throws (a failing alert must not break the bot — the copy-bot's #1 pillar) and is a no-op without config.
 */
import type { Logger } from 'pino';
import type { CopyEvent } from '@/domain/copybot/observability/event';

/** Hard cap on the webhook POST so a hung endpoint can never stall the fire-and-forget alert. */
const ALERT_WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Build the external-alert sink for `CopyEvents`. Returns `undefined` (⇒ no-op, nothing happens without config) when
 * `ALERT_WEBHOOK` is unset. Otherwise returns a fire-and-forget POST of the operator-actionable event's identity
 * (`code`/`severity`/`reason`/`adminDetail`/`ts`). NEVER throws — a synchronous or async fetch failure is warn-logged
 * and swallowed (best-effort; a dead webhook must never break the hot path nor propagate into `emit`).
 */
export function createAlertWebhookSink(
  url: string | undefined,
  log: Logger,
): ((e: CopyEvent) => void) | undefined {
  if (!url) return undefined;
  return (e: CopyEvent): void => {
    try {
      const body = JSON.stringify({
        code: e.code,
        severity: e.severity,
        reason: e.reason,
        adminDetail: e.adminDetail,
        ts: e.ts,
      });
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(ALERT_WEBHOOK_TIMEOUT_MS),
      }).catch((err) => {
        log.warn({ err: (err as Error).message }, 'alert webhook POST failed');
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'alert webhook POST failed');
    }
  };
}
