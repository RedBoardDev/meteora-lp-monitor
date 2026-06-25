/**
 * Copy-bot — alert on critical failure (a sell/close that fails, loop crash, etc.). Error-level log +
 * optional webhook (`ALERT_WEBHOOK`). NEVER throws (a failing alert must not break the bot).
 * Always an "emergency": we warn, we don't die.
 */
import type { Logger } from 'pino';

export async function alert(log: Logger, msg: string, ctx: Record<string, unknown> = {}): Promise<void> {
  log.error(ctx, `🚨 ALERT: ${msg}`);
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg, ...ctx, ts: Date.now() }) });
  } catch (e) {
    log.warn({ e: (e as Error).message }, 'alert webhook failed');
  }
}
